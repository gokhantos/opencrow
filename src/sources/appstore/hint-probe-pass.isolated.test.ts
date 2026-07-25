import { afterAll, beforeEach, describe, expect, it, mock } from "bun:test";
// Real (unmocked) import resolved at file-load time, BEFORE any `mock.module`
// runs — re-exported from every `../shared/ssrf-safe-fetch` mock below so
// `keyword-autocomplete.ts`'s `import { RateLimitError, ssrfSafeFetch }`
// always finds a real named export. Omitting it is a hard ESM SyntaxError at
// import time, not a silent `undefined`. Mirrors
// keyword-autocomplete.isolated.test.ts.
import { RateLimitError } from "../shared/ssrf-safe-fetch";
// Real (unmocked) module, spread into every `./keyword-store` mock factory
// below. `mock.module` replaces a module PROCESS-WIDE, so a partial factory
// here silently strips exports that OTHER files in the batched isolated lane
// still import (e.g. scraper-sweep-wiring's `pruneKeywordScans`) — a hard ESM
// SyntaxError in a test this file never touches. Spreading the real exports
// first makes the mock additive instead of subtractive. Mirrors the
// `RealKeywordMiner` treatment in scraper-sweep-wiring.isolated.test.ts.
import * as RealKeywordStore from "./keyword-store";
// Same process-wide-leak reasoning as `RealKeywordStore`: `keyword-store.ts`
// imports `getLastProbedAt` from this module, so a partial factory would strip
// it for every other file in the batched lane.
import * as RealHintProbeStore from "./hint-probe-store";

function hintsPlist(terms: readonly string[]): string {
  const dicts = terms.map((t) => `<dict><key>term</key><string>${t}</string></dict>`).join("");
  return `<plist version="1.0"><array>${dicts}</array></plist>`;
}

interface ProbeCandidateShape {
  readonly keyword: string;
  readonly lastProbedAt: number | null;
}

interface HintProbeWriteShape {
  readonly query: string;
  readonly storefront: string;
  readonly probedAt: number;
  readonly returnedAny: boolean;
  readonly termCount: number;
  readonly selfRank: number | null;
}

interface HintRowShape {
  readonly seed: string;
  readonly term: string;
  readonly rank: number;
  readonly storefront: string;
  readonly kept: boolean;
}

/**
 * `hint-probe-pass.ts` imports `keyword-autocomplete.ts`, which imports six
 * names from `./keyword-store`. A `mock.module("./keyword-store", ...)` factory
 * that omits any of them is a hard ESM SyntaxError ("Export named 'X' not
 * found") at import time — not a silent `undefined` — so every mock in this
 * file spreads these inert stubs. Same hazard the `RateLimitError` re-export
 * note above describes.
 */
function keywordStoreUnusedExports() {
  return {
    ...RealKeywordStore,
    getExpansionSeeds: async () => [],
    getScannedAppNames: async () => [] as readonly string[],
    keywordsExist: async () => new Set<string>(),
    markSeedsExpanded: async () => {},
  };
}

const BASE_OPTS = {
  storefront: "143441-1,29",
  market: "us",
  limit: 10,
  perSeed: 8,
  delayMs: 0,
  useProxy: true,
  reprobeAfterSec: 30 * 86_400,
  opportunityFloor: 0.35,
  opportunityLookbackSec: 90 * 86_400,
};

describe("probeCorpusKeywords", () => {
  // The batched isolated lane (`bun run test:isolated`) runs every
  // `*.isolated.test.ts` in ONE process, and `mock.module` replaces a module
  // process-wide AND for the lifetime of already-evaluated importers. Without
  // this, the mocks below outlive this file and the next file's own
  // `mock.module` calls can no longer reach modules that were first evaluated
  // here — which showed up as 21 unrelated `keyword-autocomplete.isolated`
  // failures appearing only in the batched run. Restoring at file scope keeps
  // this file's blast radius to itself.
  afterAll(() => {
    mock.restore();
  });

  let candidates: readonly ProbeCandidateShape[];
  let candidateOptions: unknown[];
  let recordedProbes: HintProbeWriteShape[];
  let insertedHintRows: HintRowShape[];
  let upsertKeywordsCalls: number;
  let fetchedUrls: string[];
  let fetchedOptions: Array<{ headers?: Record<string, string>; useProxy?: boolean }>;

  beforeEach(() => {
    candidates = [
      { keyword: "peptide tracker", lastProbedAt: null },
      { keyword: "card grading", lastProbedAt: null },
    ];
    candidateOptions = [];
    recordedProbes = [];
    insertedHintRows = [];
    upsertKeywordsCalls = 0;
    fetchedUrls = [];
    fetchedOptions = [];

    mock.module("./hint-probe-store", () => ({
      ...RealHintProbeStore,
      getDirectProbeCandidates: async (opts: unknown) => {
        candidateOptions.push(opts);
        return candidates;
      },
      recordHintProbes: async (rows: readonly HintProbeWriteShape[]) => {
        recordedProbes = [...recordedProbes, ...rows];
      },
      countHintProbes: async () => ({
        total: recordedProbes.length,
        returnedAny: recordedProbes.filter((p) => p.returnedAny).length,
        selfSuggested: recordedProbes.filter((p) => p.selfRank !== null).length,
      }),
    }));

    mock.module("./keyword-store", () => ({
      ...keywordStoreUnusedExports(),
      insertAutocompleteHints: async (rows: readonly HintRowShape[]) => {
        insertedHintRows = [...insertedHintRows, ...rows];
      },
      // Present only so an accidental corpus write would be OBSERVABLE rather
      // than a module-resolution error — this lane must never call it.
      upsertKeywords: async (rows: readonly unknown[]) => {
        upsertKeywordsCalls++;
        return rows.length;
      },
    }));

    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async (
        url: string,
        opts: { headers?: Record<string, string>; useProxy?: boolean },
      ) => {
        fetchedUrls.push(url);
        fetchedOptions.push(opts);
        if (url.includes("term=peptide")) {
          return {
            ok: true,
            text: async () => hintsPlist(["peptide tracker", "peptide dosage calculator"]),
          };
        }
        // "card grading": Apple answers, but not with the phrase itself.
        return { ok: true, text: async () => hintsPlist(["card scanner"]) };
      },
    }));
  });

  it("probes each selected corpus keyword BY NAME and records a ledger row per answer", async () => {
    const { probeCorpusKeywords } = await import("./hint-probe-pass");
    const result = await probeCorpusKeywords(BASE_OPTS);

    expect(result.attempted).toBe(2);
    expect(result.probesRecorded).toBe(2);
    expect(recordedProbes.map((p) => p.query)).toEqual(["peptide tracker", "card grading"]);
    // The bare keyword is the query — no prefix decoration.
    expect(fetchedUrls[0]).toContain("term=peptide%20tracker");
  });

  it("distinguishes `present` from `probed-absent` via selfRank on the ledger row", async () => {
    const { probeCorpusKeywords } = await import("./hint-probe-pass");
    const result = await probeCorpusKeywords(BASE_OPTS);

    const peptide = recordedProbes.find((p) => p.query === "peptide tracker");
    const card = recordedProbes.find((p) => p.query === "card grading");
    // Apple suggested "peptide tracker" back at rank 0 -> real demand signal.
    expect(peptide?.selfRank).toBe(0);
    expect(peptide?.returnedAny).toBe(true);
    // Apple answered for "card grading" but never suggested the phrase — the
    // strongest available negative, and previously unrepresentable.
    expect(card?.selfRank).toBeNull();
    expect(card?.returnedAny).toBe(true);
    expect(result.selfSuggested).toBe(1);
  });

  it("records `returnedAny: false` when Apple returns an empty list", async () => {
    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async () => ({ ok: true, text: async () => hintsPlist([]) }),
    }));

    const { probeCorpusKeywords } = await import("./hint-probe-pass");
    const result = await probeCorpusKeywords(BASE_OPTS);

    expect(result.emptyResponses).toBe(2);
    expect(result.probesRecorded).toBe(2);
    expect(recordedProbes.every((p) => p.returnedAny === false)).toBe(true);
    // Flatline contract: zero raw terms across the pass is reported so the
    // caller can tell a broken endpoint from a genuinely quiet corpus.
    expect(result.rawTermCount).toBe(0);
  });

  it("writes NO ledger row for a rate-limited probe and counts it for the throttle", async () => {
    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async (url: string) => {
        if (url.includes("term=peptide")) throw new RateLimitError("Rate limited", 429, undefined);
        return { ok: true, text: async () => hintsPlist(["card scanner"]) };
      },
    }));

    const { probeCorpusKeywords } = await import("./hint-probe-pass");
    const result = await probeCorpusKeywords(BASE_OPTS);

    expect(result.rateLimitErrors).toBe(1);
    expect(result.attempted).toBe(2);
    expect(result.probesRecorded).toBe(1);
    // "peptide tracker" must stay never-probed so it is retried, not recorded
    // as a confirmed absence.
    expect(recordedProbes.map((p) => p.query)).toEqual(["card grading"]);
  });

  it("writes NO ledger row for a bare 403, and does not treat it as an answer", async () => {
    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async () => ({ ok: false, status: 403, text: async () => "" }),
    }));

    const { probeCorpusKeywords } = await import("./hint-probe-pass");
    const result = await probeCorpusKeywords(BASE_OPTS);

    expect(result.probesRecorded).toBe(0);
    expect(recordedProbes).toEqual([]);
    expect(insertedHintRows).toEqual([]);
  });

  it("logs every parsed term with a gapless rank and a kept verdict", async () => {
    const { probeCorpusKeywords } = await import("./hint-probe-pass");
    await probeCorpusKeywords(BASE_OPTS);

    const peptideRows = insertedHintRows.filter((r) => r.seed === "peptide tracker");
    expect(peptideRows.map((r) => r.rank)).toEqual([0, 1]);
    expect(peptideRows.every((r) => r.storefront === "us")).toBe(true);
    expect(peptideRows[0]?.term).toBe("peptide tracker");
  });

  it("NEVER writes to the corpus — coverage growth must not become a second admission path", async () => {
    const { probeCorpusKeywords } = await import("./hint-probe-pass");
    await probeCorpusKeywords(BASE_OPTS);
    expect(upsertKeywordsCalls).toBe(0);
  });

  it("routes fetches through the proxy when asked, and sends the mandatory storefront header", async () => {
    const { probeCorpusKeywords } = await import("./hint-probe-pass");
    await probeCorpusKeywords({ ...BASE_OPTS, useProxy: true });

    expect(fetchedOptions.every((o) => o.useProxy === true)).toBe(true);
    expect(fetchedOptions[0]?.headers?.["X-Apple-Store-Front"]).toBe("143441-1,29");
    expect(fetchedOptions[0]?.headers?.["User-Agent"]).toBeDefined();
  });

  it("can be run directly against a storefront, tagging both ledgers with that market", async () => {
    const { probeCorpusKeywords } = await import("./hint-probe-pass");
    await probeCorpusKeywords({ ...BASE_OPTS, market: "gb", storefront: "143444-1,29" });

    expect(recordedProbes.every((p) => p.storefront === "gb")).toBe(true);
    expect(insertedHintRows.every((r) => r.storefront === "gb")).toBe(true);
  });

  it("returns an inert result and issues no request when there is nothing to probe", async () => {
    candidates = [];
    const { probeCorpusKeywords } = await import("./hint-probe-pass");
    const result = await probeCorpusKeywords(BASE_OPTS);

    expect(result.attempted).toBe(0);
    expect(result.probesRecorded).toBe(0);
    expect(fetchedUrls).toEqual([]);
  });

  it("issues nothing for a non-positive limit (throttle collapsed to zero)", async () => {
    const { probeCorpusKeywords } = await import("./hint-probe-pass");
    const result = await probeCorpusKeywords({ ...BASE_OPTS, limit: 0 });

    expect(result.attempted).toBe(0);
    expect(candidateOptions).toEqual([]);
    expect(fetchedUrls).toEqual([]);
  });

  it("skips keywords still inside the re-probe window rather than spending requests", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    candidates = [
      { keyword: "peptide tracker", lastProbedAt: nowSec - 60 },
      { keyword: "card grading", lastProbedAt: null },
    ];

    const { probeCorpusKeywords } = await import("./hint-probe-pass");
    const result = await probeCorpusKeywords(BASE_OPTS);

    expect(result.attempted).toBe(1);
    expect(recordedProbes.map((p) => p.query)).toEqual(["card grading"]);
  });

  it("does not throw when persistence fails — the shared auxiliary tick must survive", async () => {
    mock.module("./keyword-store", () => ({
      ...keywordStoreUnusedExports(),
      insertAutocompleteHints: async () => {
        throw new Error("db down");
      },
      upsertKeywords: async () => 0,
    }));

    const { probeCorpusKeywords } = await import("./hint-probe-pass");
    const result = await probeCorpusKeywords(BASE_OPTS);

    expect(result.attempted).toBe(2);
    expect(result.ledgerTotal).toBe(0);
  });

  it("asks the store for candidates scoped to the pass's market and cadence", async () => {
    const { probeCorpusKeywords } = await import("./hint-probe-pass");
    await probeCorpusKeywords({ ...BASE_OPTS, limit: 5 });

    const opts = candidateOptions[0] as {
      market: string;
      limit: number;
      reprobeBefore: number;
      opportunityFloor: number;
    };
    expect(opts.market).toBe("us");
    // Oversampled past the request cap so blanks/dupes can't starve the pass.
    expect(opts.limit).toBeGreaterThan(5);
    expect(opts.opportunityFloor).toBe(0.35);
    expect(opts.reprobeBefore).toBeLessThan(Math.floor(Date.now() / 1000));
  });
});
