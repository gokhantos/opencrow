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

function hintsPlist(terms: readonly string[]): string {
  const dicts = terms
    .map((t) => `<dict><key>term</key><string>${t}</string></dict>`)
    .join("");
  return `<plist version="1.0"><array>${dicts}</array></plist>`;
}

const SEEDS = [
  { keyword: "budget", genreZone: "finance" },
  { keyword: "meal prep", genreZone: "health" },
];

describe("expandCorpus", () => {
  let upsertedRows: unknown[];
  let keywordsExistCalls: Array<readonly string[]>;
  let fetchedUrls: string[];
  let fetchedHeaders: Array<Record<string, string> | undefined>;

  beforeEach(() => {
    upsertedRows = [];
    keywordsExistCalls = [];
    fetchedUrls = [];
    fetchedHeaders = [];

    mock.module("./keyword-store", () => ({
      getExpansionSeeds: async () => SEEDS,
      keywordsExist: async (keywords: readonly string[]) => {
        keywordsExistCalls.push(keywords);
        return new Set<string>();
      },
      upsertKeywords: async (rows: readonly unknown[]) => {
        upsertedRows = [...upsertedRows, ...rows];
        return rows.length;
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

    expect(upsertedRows).toEqual([
      { keyword: "budget planner", genreZone: "finance", source: "autocomplete" },
      { keyword: "budget bestie", genreZone: "finance", source: "autocomplete" },
      { keyword: "meal prep ideas", genreZone: "health", source: "autocomplete" },
    ]);
    // Candidates from every seed's hints are checked against the corpus in
    // one batched `keywordsExist` call.
    expect(keywordsExistCalls.length).toBe(1);
    expect(keywordsExistCalls[0]).toEqual([
      "budget planner",
      "budget bestie",
      "meal prep ideas",
    ]);
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
      getExpansionSeeds: async () => SEEDS,
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
      getExpansionSeeds: async () => [],
      keywordsExist: async () => new Set<string>(),
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

    expect(result).toEqual({ added: 0, seedsUsed: 0, attempted: 0, rateLimitErrors: 0 });
    expect(upsertedRows).toEqual([]);
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
});
