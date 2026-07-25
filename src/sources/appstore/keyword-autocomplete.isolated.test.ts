import { describe, expect, it, mock, beforeEach } from "bun:test";
// Real (unmocked) import, resolved at file-load time BEFORE any
// `mock.module` call runs (those only execute inside `beforeEach`/`it`
// bodies) — re-exported from every `../shared/ssrf-safe-fetch` mock below so
// `keyword-autocomplete.ts`'s own `import { RateLimitError, ssrfSafeFetch }
// from "../shared/ssrf-safe-fetch"` always finds a real named export.
// Omitting it from a mock's returned object is a hard ESM SyntaxError at
// import time (missing named export), not a silent `undefined` — every mock
// factory below MUST include it. Mirrors keyword-gaps.isolated.test.ts.
import { RateLimitError } from "../shared/ssrf-safe-fetch";
// Real (unmocked) module, spread into the `./hint-probe-store` mock below.
// `mock.module` replaces a module process-wide, so a PARTIAL factory here
// strips exports that other modules import — `keyword-store.ts` imports
// `getLastProbedAt` from this module, and dropping it turns every
// already-evaluated importer into a hard ESM SyntaxError. That surfaced only in
// the batched isolated lane (21 unrelated failures), never standalone. Spread
// first, override second.
import * as RealHintProbeStore from "./hint-probe-store";

function hintsPlist(terms: readonly string[]): string {
  const dicts = terms.map((t) => `<dict><key>term</key><string>${t}</string></dict>`).join("");
  return `<plist version="1.0"><array>${dicts}</array></plist>`;
}

const SEEDS = [
  { keyword: "budget", genreZone: "finance", nextPrefixOffset: 0 },
  { keyword: "meal prep", genreZone: "health", nextPrefixOffset: 0 },
];

/** Every `./keyword-store` export `keyword-autocomplete.ts` imports, with inert defaults. */
function keywordStoreMockBase() {
  return {
    getExpansionSeeds: async () => SEEDS,
    keywordsExist: async () => new Set<string>(),
    upsertKeywords: async (rows: readonly unknown[]) => rows.length,
    markSeedsExpanded: async () => {},
    insertAutocompleteHints: async () => {},
    // Batch A budget rescue (2026-07-22): `expandCorpus` now builds an
    // insert-time brand-segment filter from this pool (see
    // `keyword-brand.ts`). Empty by default — none of this file's fixture
    // candidates ("budget planner", "meal prep ideas", ...) contain a brand
    // separator or match an (empty) brand-segment set, so this default is a
    // true no-op for every existing test.
    getScannedAppNames: async () => [] as readonly string[],
  };
}

interface SeedRotationUpdateShape {
  readonly keyword: string;
  readonly storefront: string;
  readonly nextPrefixOffset: number;
}

/**
 * Coverage wave (2026-07-26): `expandCorpus` now also writes the probe ledger
 * (`hint-probe-store.ts`'s `recordHintProbes`, migration 057). That module
 * reaches for `getDb()`, so it MUST be mocked here or every test in this file
 * would try to open a real DB connection.
 */
interface HintProbeWriteShape {
  readonly query: string;
  readonly storefront: string;
  readonly probedAt: number;
  readonly returnedAny: boolean;
  readonly termCount: number;
  readonly selfRank: number | null;
}

describe("expandCorpus", () => {
  let upsertedRows: unknown[];
  let keywordsExistCalls: Array<readonly string[]>;
  let fetchedUrls: string[];
  let fetchedHeaders: Array<Record<string, string> | undefined>;
  let markSeedsExpandedCalls: Array<readonly SeedRotationUpdateShape[]>;
  let insertedHintRows: unknown[];
  let recordedProbes: HintProbeWriteShape[];

  beforeEach(() => {
    upsertedRows = [];
    keywordsExistCalls = [];
    fetchedUrls = [];
    fetchedHeaders = [];
    markSeedsExpandedCalls = [];
    insertedHintRows = [];
    recordedProbes = [];

    mock.module("./hint-probe-store", () => ({
      ...RealHintProbeStore,
      recordHintProbes: async (rows: readonly HintProbeWriteShape[]) => {
        recordedProbes = [...recordedProbes, ...rows];
      },
    }));

    mock.module("./keyword-store", () => ({
      ...keywordStoreMockBase(),
      getExpansionSeeds: async () => SEEDS,
      keywordsExist: async (keywords: readonly string[]) => {
        keywordsExistCalls.push(keywords);
        return new Set<string>();
      },
      upsertKeywords: async (rows: readonly unknown[]) => {
        upsertedRows = [...upsertedRows, ...rows];
        return rows.length;
      },
      markSeedsExpanded: async (updates: readonly SeedRotationUpdateShape[]) => {
        markSeedsExpandedCalls.push(updates);
      },
      insertAutocompleteHints: async (rows: readonly unknown[]) => {
        insertedHintRows = [...insertedHintRows, ...rows];
      },
    }));

    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async (url: string, opts: { headers?: Record<string, string> }) => {
        fetchedUrls.push(url);
        fetchedHeaders.push(opts.headers);
        if (url.includes("term=budget")) {
          return {
            ok: true,
            text: async () => hintsPlist(["budget planner", "budget bestie"]),
          };
        }
        if (url.includes("term=meal")) {
          return { ok: true, text: async () => hintsPlist(["meal prep ideas"]) };
        }
        return { ok: true, text: async () => hintsPlist([]) };
      },
    }));
  });

  it("expands from seeds, upserting new autocomplete-sourced keywords", async () => {
    const { expandCorpus } = await import("./keyword-autocomplete");
    const result = await expandCorpus({
      minOpportunity: 0.15,
      winnerLimit: 15,
      diverseLimit: 10,
      perSeed: 8,
      storefront: "143441-1,29",
      delayMs: 0,
    });

    expect(result.added).toBe(3);
    expect(result.seedsUsed).toBe(2);
    expect(result.attempted).toBe(2);
    expect(result.rateLimitErrors).toBe(0);
    // B2 flatline signal: raw terms summed pre-filter (2 for budget, 1 for meal).
    expect(result.rawTermCount).toBe(3);

    expect(upsertedRows).toEqual([
      { keyword: "budget planner", genreZone: "finance", source: "autocomplete" },
      { keyword: "budget bestie", genreZone: "finance", source: "autocomplete" },
      { keyword: "meal prep ideas", genreZone: "health", source: "autocomplete" },
    ]);
    // Candidates from every seed's hints are checked against the corpus in
    // one batched `keywordsExist` call.
    expect(keywordsExistCalls.length).toBe(1);
    expect(keywordsExistCalls[0]).toEqual(["budget planner", "budget bestie", "meal prep ideas"]);
  });

  it("sends the mandatory X-Apple-Store-Front header on every request", async () => {
    const { expandCorpus } = await import("./keyword-autocomplete");
    await expandCorpus({
      minOpportunity: 0.15,
      winnerLimit: 15,
      diverseLimit: 10,
      perSeed: 8,
      storefront: "143441-1,29",
      delayMs: 0,
    });

    expect(fetchedHeaders.length).toBe(2);
    for (const headers of fetchedHeaders) {
      expect(headers?.["X-Apple-Store-Front"]).toBe("143441-1,29");
    }
    expect(fetchedUrls[0]).toContain("clientApplication=Software");
  });

  it("excludes candidates already present in the corpus", async () => {
    mock.module("./keyword-store", () => ({
      ...keywordStoreMockBase(),
      keywordsExist: async () => new Set(["budget planner"]),
      upsertKeywords: async (rows: readonly unknown[]) => {
        upsertedRows = [...upsertedRows, ...rows];
        return rows.length;
      },
    }));

    const { expandCorpus } = await import("./keyword-autocomplete");
    const result = await expandCorpus({
      minOpportunity: 0.15,
      winnerLimit: 15,
      diverseLimit: 10,
      perSeed: 8,
      storefront: "143441-1,29",
      delayMs: 0,
    });

    expect(result.added).toBe(2);
    expect(upsertedRows.map((r) => (r as { keyword: string }).keyword)).toEqual([
      "budget bestie",
      "meal prep ideas",
    ]);
  });

  it("counts rate-limit failures without aborting the rest of the pass", async () => {
    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async (url: string) => {
        if (url.includes("term=budget")) {
          throw new RateLimitError("Rate limited", 429, undefined);
        }
        return { ok: true, text: async () => hintsPlist(["meal prep ideas"]) };
      },
    }));

    const { expandCorpus } = await import("./keyword-autocomplete");
    const result = await expandCorpus({
      minOpportunity: 0.15,
      winnerLimit: 15,
      diverseLimit: 10,
      perSeed: 8,
      storefront: "143441-1,29",
      delayMs: 0,
    });

    expect(result.rateLimitErrors).toBe(1);
    expect(result.attempted).toBe(2);
    expect(result.added).toBe(1);
    expect(upsertedRows).toEqual([
      { keyword: "meal prep ideas", genreZone: "health", source: "autocomplete" },
    ]);
  });

  it("returns an empty result without any DB writes when there are no seeds", async () => {
    mock.module("./keyword-store", () => ({
      ...keywordStoreMockBase(),
      getExpansionSeeds: async () => [],
      upsertKeywords: async (rows: readonly unknown[]) => {
        upsertedRows = [...upsertedRows, ...rows];
        return rows.length;
      },
    }));

    const { expandCorpus } = await import("./keyword-autocomplete");
    const result = await expandCorpus({
      minOpportunity: 0.15,
      winnerLimit: 15,
      diverseLimit: 10,
      perSeed: 8,
      storefront: "143441-1,29",
      delayMs: 0,
    });

    expect(result).toEqual({
      added: 0,
      seedsUsed: 0,
      attempted: 0,
      rateLimitErrors: 0,
      brandFiltered: 0,
      rawTermCount: 0,
      probesRecorded: 0,
      emptyResponses: 0,
    });
    expect(upsertedRows).toEqual([]);
    expect(recordedProbes).toEqual([]);
  });

  // --- Coverage wave (2026-07-26): probe ledger (migration 057) ---
  //
  // The whole point of the ledger is that "we asked and Apple said nothing"
  // and "we never asked" stop being the same observation. These tests pin the
  // two directions of that invariant, because getting either wrong silently
  // corrupts the one incumbent-independent demand signal in the system.

  it("records a probe row for EVERY query Apple answered, including the bare seed", async () => {
    const { expandCorpus } = await import("./keyword-autocomplete");
    const result = await expandCorpus({
      minOpportunity: 0.15,
      winnerLimit: 15,
      diverseLimit: 10,
      perSeed: 8,
      storefront: "143441-1,29",
      market: "us",
      delayMs: 0,
    });

    expect(result.probesRecorded).toBe(2);
    expect(recordedProbes.map((p) => p.query)).toEqual(["budget", "meal prep"]);
    expect(recordedProbes.every((p) => p.storefront === "us")).toBe(true);
    expect(recordedProbes.every((p) => p.returnedAny)).toBe(true);
  });

  it("records `returnedAny: false` when Apple answers with an EMPTY suggestion list", async () => {
    // THE critical datum: pre-migration-057 this produced no row anywhere, so
    // the keyword stayed indistinguishable from one that was never probed.
    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async (url: string) => {
        if (url.includes("term=budget")) {
          return { ok: true, text: async () => hintsPlist([]) };
        }
        return { ok: true, text: async () => hintsPlist(["meal prep ideas"]) };
      },
    }));

    const { expandCorpus } = await import("./keyword-autocomplete");
    const result = await expandCorpus({
      minOpportunity: 0.15,
      winnerLimit: 15,
      diverseLimit: 10,
      perSeed: 8,
      storefront: "143441-1,29",
      delayMs: 0,
    });

    expect(result.emptyResponses).toBe(1);
    expect(result.probesRecorded).toBe(2);
    const budgetProbe = recordedProbes.find((p) => p.query === "budget");
    expect(budgetProbe).toBeDefined();
    expect(budgetProbe?.returnedAny).toBe(false);
    expect(budgetProbe?.termCount).toBe(0);
    expect(budgetProbe?.selfRank).toBeNull();
  });

  it("records NO probe row for a rate-limited query — a failure is not evidence of absence", async () => {
    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async (url: string) => {
        if (url.includes("term=budget")) {
          throw new RateLimitError("Rate limited", 429, undefined);
        }
        return { ok: true, text: async () => hintsPlist(["meal prep ideas"]) };
      },
    }));

    const { expandCorpus } = await import("./keyword-autocomplete");
    const result = await expandCorpus({
      minOpportunity: 0.15,
      winnerLimit: 15,
      diverseLimit: 10,
      perSeed: 8,
      storefront: "143441-1,29",
      delayMs: 0,
    });

    expect(result.rateLimitErrors).toBe(1);
    expect(result.attempted).toBe(2);
    // Two attempts, ONE answer — the rate-limited one leaves no trace in the
    // ledger, so the keyword correctly stays `never-probed`.
    expect(result.probesRecorded).toBe(1);
    expect(recordedProbes.map((p) => p.query)).toEqual(["meal prep"]);
  });

  it("records NO probe row for a non-OK HTTP status", async () => {
    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async (url: string) => {
        if (url.includes("term=budget")) {
          return { ok: false, status: 500, text: async () => "" };
        }
        return { ok: true, text: async () => hintsPlist(["meal prep ideas"]) };
      },
    }));

    const { expandCorpus } = await import("./keyword-autocomplete");
    const result = await expandCorpus({
      minOpportunity: 0.15,
      winnerLimit: 15,
      diverseLimit: 10,
      perSeed: 8,
      storefront: "143441-1,29",
      delayMs: 0,
    });

    expect(result.probesRecorded).toBe(1);
    expect(recordedProbes.map((p) => p.query)).toEqual(["meal prep"]);
  });

  it("captures the query's own rank in its results as `selfRank`", async () => {
    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async (url: string) => {
        if (url.includes("term=budget")) {
          // Apple echoes the exact phrase back at rank 1.
          return { ok: true, text: async () => hintsPlist(["budget planner", "budget"]) };
        }
        return { ok: true, text: async () => hintsPlist(["meal prep ideas"]) };
      },
    }));

    const { expandCorpus } = await import("./keyword-autocomplete");
    await expandCorpus({
      minOpportunity: 0.15,
      winnerLimit: 15,
      diverseLimit: 10,
      perSeed: 8,
      storefront: "143441-1,29",
      delayMs: 0,
    });

    expect(recordedProbes.find((p) => p.query === "budget")?.selfRank).toBe(1);
    // "meal prep" was not suggested back by its own query -> null, which with
    // `returnedAny: true` is the strongest available negative.
    expect(recordedProbes.find((p) => p.query === "meal prep")?.selfRank).toBeNull();
  });

  it("tags probe rows with the pass's market, so US and GB ledgers stay independent", async () => {
    const { expandCorpus } = await import("./keyword-autocomplete");
    await expandCorpus({
      minOpportunity: 0.15,
      winnerLimit: 15,
      diverseLimit: 10,
      perSeed: 8,
      storefront: "143444-1,29",
      market: "gb",
      delayMs: 0,
    });

    expect(recordedProbes.every((p) => p.storefront === "gb")).toBe(true);
  });

  it("tolerates a non-OK HTTP status on one seed without throwing", async () => {
    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async (url: string) => {
        if (url.includes("term=budget")) {
          return { ok: false, status: 500, text: async () => "" };
        }
        return { ok: true, text: async () => hintsPlist(["meal prep ideas"]) };
      },
    }));

    const { expandCorpus } = await import("./keyword-autocomplete");
    const result = await expandCorpus({
      minOpportunity: 0.15,
      winnerLimit: 15,
      diverseLimit: 10,
      perSeed: 8,
      storefront: "143441-1,29",
      delayMs: 0,
    });

    expect(result.added).toBe(1);
    expect(result.rateLimitErrors).toBe(0);
  });

  // 2026-07-21 audit item D fix: seed rotation.
  it("marks every drawn seed as expanded, regardless of fetch outcome", async () => {
    const { expandCorpus } = await import("./keyword-autocomplete");
    await expandCorpus({
      minOpportunity: 0.15,
      winnerLimit: 15,
      diverseLimit: 10,
      perSeed: 8,
      storefront: "143441-1,29",
      delayMs: 0,
    });

    expect(markSeedsExpandedCalls.length).toBe(1);
    // No prefix fan-out this call (maxPrefixesPerSeed omitted) — every
    // seed's cursor stays at its starting offset (0), just the storefront
    // and rotation timestamp change.
    expect(markSeedsExpandedCalls[0]).toEqual([
      { keyword: "budget", storefront: "us", nextPrefixOffset: 0 },
      { keyword: "meal prep", storefront: "us", nextPrefixOffset: 0 },
    ]);
  });

  // 2026-07-21 audit item D fix: rank hints persisted.
  it("persists a (seed, term, rank, seenAt) row for every candidate, not just the ones that become new keywords", async () => {
    mock.module("./keyword-store", () => ({
      ...keywordStoreMockBase(),
      // "budget planner" already exists — it must still get a hint row even
      // though it won't be upserted as a new corpus keyword.
      keywordsExist: async () => new Set(["budget planner"]),
      insertAutocompleteHints: async (rows: readonly unknown[]) => {
        insertedHintRows = [...insertedHintRows, ...rows];
      },
    }));

    const { expandCorpus } = await import("./keyword-autocomplete");
    await expandCorpus({
      minOpportunity: 0.15,
      winnerLimit: 15,
      diverseLimit: 10,
      perSeed: 8,
      storefront: "143441-1,29",
      delayMs: 0,
    });

    expect(insertedHintRows).toEqual([
      {
        seed: "budget",
        term: "budget planner",
        rank: 0,
        seenAt: expect.any(Number),
        storefront: "us",
        kept: true,
      },
      {
        seed: "budget",
        term: "budget bestie",
        rank: 1,
        seenAt: expect.any(Number),
        storefront: "us",
        kept: true,
      },
      {
        seed: "meal prep",
        term: "meal prep ideas",
        rank: 0,
        seenAt: expect.any(Number),
        storefront: "us",
        kept: true,
      },
    ]);
  });

  // Batch D item D1 (2026-07-22): every PARSED term is logged now, not just
  // the ones that survive the junk/length/dedup/perSeed-cap filter — `kept`
  // distinguishes them, so ranks stay gapless for `getHintEvidence`'s
  // absence reasoning.
  it("logs a filtered-out (junk) term too, with kept: false, alongside the surviving good terms", async () => {
    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async (url: string) => {
        if (url.includes("term=budget")) {
          // "app" alone is junk (JUNK_KEYWORDS) — filtered out, but must
          // still be logged.
          return { ok: true, text: async () => hintsPlist(["app", "budget planner"]) };
        }
        return { ok: true, text: async () => hintsPlist([]) };
      },
    }));

    const { expandCorpus } = await import("./keyword-autocomplete");
    await expandCorpus({
      minOpportunity: 0.15,
      winnerLimit: 15,
      diverseLimit: 10,
      perSeed: 8,
      storefront: "143441-1,29",
      delayMs: 0,
    });

    const budgetRows = (
      insertedHintRows as Array<{ seed: string; term: string; rank: number; kept: boolean }>
    )
      .filter((r) => r.seed === "budget")
      .map((r) => ({ term: r.term, rank: r.rank, kept: r.kept }));
    expect(budgetRows).toEqual([
      { term: "app", rank: 0, kept: false },
      { term: "budget planner", rank: 1, kept: true },
    ]);
  });

  // Security hardening (2026-07-22): an over-length term is still logged
  // (Batch D item D1 logs EVERY parsed term) but must be BOUNDED to the
  // 80-char cap before it reaches the TEXT column — previously an
  // over-length term was dropped outright (`continue`) before persistence
  // existed at all; now that every parsed term gets a row, persisting it
  // verbatim would let an unbounded upstream string into the DB.
  it("truncates an over-length hint term to 80 chars before persisting, with kept: false", async () => {
    const oversized = `budget ${"planner ".repeat(15)}`.trim();
    expect(oversized.length).toBeGreaterThan(80);

    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async (url: string) => {
        if (url.includes("term=budget")) {
          return { ok: true, text: async () => hintsPlist([oversized, "budget planner"]) };
        }
        return { ok: true, text: async () => hintsPlist([]) };
      },
    }));

    const { expandCorpus } = await import("./keyword-autocomplete");
    await expandCorpus({
      minOpportunity: 0.15,
      winnerLimit: 15,
      diverseLimit: 10,
      perSeed: 8,
      storefront: "143441-1,29",
      delayMs: 0,
    });

    const budgetRows = (
      insertedHintRows as Array<{ seed: string; term: string; rank: number; kept: boolean }>
    ).filter((r) => r.seed === "budget");

    const oversizedRow = budgetRows.find((r) => r.rank === 0);
    expect(oversizedRow?.term.length).toBe(80);
    expect(oversizedRow?.term).toBe(oversized.toLowerCase().slice(0, 80));
    expect(oversizedRow?.kept).toBe(false);

    const keptRow = budgetRows.find((r) => r.rank === 1);
    expect(keptRow?.term).toBe("budget planner");
    expect(keptRow?.kept).toBe(true);

    // The over-length term must never reach the corpus-expansion candidate
    // set either — unchanged from pre-existing behavior.
    expect(upsertedRows.map((r) => (r as { keyword: string }).keyword)).not.toContain(
      oversizedRow?.term,
    );
  });

  // Throughput wave item 3 ("hint breadth"): `market` tags every hint row
  // with the storefront being queried (migration 049) — defaults to "us"
  // (tested above) but a caller running the GB lane passes "gb" explicitly.
  it("tags hint rows with the caller-supplied `market` (GB hints lane)", async () => {
    mock.module("./keyword-store", () => ({
      ...keywordStoreMockBase(),
      insertAutocompleteHints: async (rows: readonly unknown[]) => {
        insertedHintRows = [...insertedHintRows, ...rows];
      },
    }));

    const { expandCorpus } = await import("./keyword-autocomplete");
    await expandCorpus({
      minOpportunity: 0.15,
      winnerLimit: 15,
      diverseLimit: 10,
      perSeed: 8,
      storefront: "143444-1,29",
      market: "gb",
      delayMs: 0,
    });

    expect(insertedHintRows.length).toBeGreaterThan(0);
    for (const row of insertedHintRows) {
      expect((row as { storefront: string }).storefront).toBe("gb");
    }
  });

  // 2026-07-21 audit item D fix: prefix fan-out.
  describe("prefix fan-out", () => {
    it("bounds the extra requests per seed to maxPrefixesPerSeed", async () => {
      const { expandCorpus } = await import("./keyword-autocomplete");
      const result = await expandCorpus({
        minOpportunity: 0.15,
        winnerLimit: 15,
        diverseLimit: 10,
        perSeed: 8,
        storefront: "143441-1,29",
        delayMs: 0,
        maxPrefixesPerSeed: 3,
      });

      // 2 seeds * (1 bare + 3 prefix) = 8 total requests.
      expect(result.attempted).toBe(8);
      expect(fetchedUrls.length).toBe(8);
    });

    it("issues zero extra requests when maxPrefixesPerSeed is omitted (default 0 — unchanged pre-fix behavior)", async () => {
      const { expandCorpus } = await import("./keyword-autocomplete");
      const result = await expandCorpus({
        minOpportunity: 0.15,
        winnerLimit: 15,
        diverseLimit: 10,
        perSeed: 8,
        storefront: "143441-1,29",
        delayMs: 0,
      });

      expect(result.attempted).toBe(2);
    });

    it("queries the expected letter-suffixed URLs, in order, up to the cap", async () => {
      const { expandCorpus } = await import("./keyword-autocomplete");
      await expandCorpus({
        minOpportunity: 0.15,
        winnerLimit: 15,
        diverseLimit: 10,
        perSeed: 8,
        storefront: "143441-1,29",
        delayMs: 0,
        maxPrefixesPerSeed: 2,
      });

      // First seed "budget": bare seed + "budget a" + "budget b".
      expect(fetchedUrls[0]).toContain(`term=${encodeURIComponent("budget")}`);
      expect(fetchedUrls[1]).toContain(`term=${encodeURIComponent("budget a")}`);
      expect(fetchedUrls[2]).toContain(`term=${encodeURIComponent("budget b")}`);
    });

    it("caps at 26 even if a caller passes a larger maxPrefixesPerSeed", async () => {
      const { expandCorpus } = await import("./keyword-autocomplete");
      const result = await expandCorpus({
        minOpportunity: 0.15,
        winnerLimit: 15,
        diverseLimit: 10,
        perSeed: 8,
        storefront: "143441-1,29",
        delayMs: 0,
        maxPrefixesPerSeed: 100,
      });

      // 2 seeds * (1 bare + 26 letters) = 54 total requests, not 202.
      expect(result.attempted).toBe(54);
    });
  });

  // Batch A budget rescue (2026-07-22): insert-time brand-navigational
  // filter — see keyword-brand.ts module doc, layer 1.
  describe("brand-navigational filter", () => {
    it("drops a candidate that itself contains a brand separator, still logs its hint row", async () => {
      mock.module("../shared/ssrf-safe-fetch", () => ({
        RateLimitError,
        ssrfSafeFetch: async (url: string) => {
          if (url.includes("term=budget")) {
            // Full "Brand: subtitle"-shaped hint alongside a genuine one.
            return {
              ok: true,
              text: async () => hintsPlist(["duolingo: language lessons", "budget planner"]),
            };
          }
          return { ok: true, text: async () => hintsPlist(["meal prep ideas"]) };
        },
      }));
      mock.module("./keyword-store", () => ({
        ...keywordStoreMockBase(),
        upsertKeywords: async (rows: readonly unknown[]) => {
          upsertedRows = [...upsertedRows, ...rows];
          return rows.length;
        },
        insertAutocompleteHints: async (rows: readonly unknown[]) => {
          insertedHintRows = [...insertedHintRows, ...rows];
        },
      }));

      const { expandCorpus } = await import("./keyword-autocomplete");
      const result = await expandCorpus({
        minOpportunity: 0.15,
        winnerLimit: 15,
        diverseLimit: 10,
        perSeed: 8,
        storefront: "143441-1,29",
        delayMs: 0,
      });

      // "duolingo: language lessons" dropped by the brand filter — only the
      // 2 genuine phrases become new corpus keywords.
      expect(result.added).toBe(2);
      expect(result.brandFiltered).toBe(1);
      expect(upsertedRows.map((r) => (r as { keyword: string }).keyword)).toEqual([
        "budget planner",
        "meal prep ideas",
      ]);
      // The hint row is still persisted regardless of the brand-filter verdict.
      expect(insertedHintRows.map((r) => (r as { term: string }).term)).toContain(
        "duolingo: language lessons",
      );
    });

    it("drops a candidate that exactly matches a known brand segment from getScannedAppNames", async () => {
      mock.module("./keyword-store", () => ({
        ...keywordStoreMockBase(),
        upsertKeywords: async (rows: readonly unknown[]) => {
          upsertedRows = [...upsertedRows, ...rows];
          return rows.length;
        },
        // A recently-scanned SERP result titled "Notion: Notes, Docs, AI"
        // yields the brand segment "notion" — a bare "budget planner" hint
        // that happened to normalize to that exact segment would be dropped
        // too, so use the seed's own bare-word hint set instead: rewire
        // ssrf-safe-fetch below to return the literal brand name as a hint.
        getScannedAppNames: async () => ["Notion: Notes, Docs, AI"],
      }));
      mock.module("../shared/ssrf-safe-fetch", () => ({
        RateLimitError,
        ssrfSafeFetch: async (url: string) => {
          if (url.includes("term=budget")) {
            return { ok: true, text: async () => hintsPlist(["notion", "budget planner"]) };
          }
          return { ok: true, text: async () => hintsPlist(["meal prep ideas"]) };
        },
      }));

      const { expandCorpus } = await import("./keyword-autocomplete");
      const result = await expandCorpus({
        minOpportunity: 0.15,
        winnerLimit: 15,
        diverseLimit: 10,
        perSeed: 8,
        storefront: "143441-1,29",
        delayMs: 0,
      });

      expect(result.brandFiltered).toBe(1);
      expect(upsertedRows.map((r) => (r as { keyword: string }).keyword)).not.toContain("notion");
      expect(upsertedRows.map((r) => (r as { keyword: string }).keyword)).toContain(
        "budget planner",
      );
    });
  });
});
