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

/** Every `./keyword-store` export `keyword-autocomplete.ts` imports, with inert defaults. */
function keywordStoreMockBase() {
  return {
    getExpansionSeeds: async () => SEEDS,
    keywordsExist: async () => new Set<string>(),
    upsertKeywords: async (rows: readonly unknown[]) => rows.length,
    markSeedsExpanded: async () => {},
    insertAutocompleteHints: async () => {},
  };
}

describe("expandCorpus", () => {
  let upsertedRows: unknown[];
  let keywordsExistCalls: Array<readonly string[]>;
  let fetchedUrls: string[];
  let fetchedHeaders: Array<Record<string, string> | undefined>;
  let markSeedsExpandedCalls: Array<readonly string[]>;
  let insertedHintRows: unknown[];

  beforeEach(() => {
    upsertedRows = [];
    keywordsExistCalls = [];
    fetchedUrls = [];
    fetchedHeaders = [];
    markSeedsExpandedCalls = [];
    insertedHintRows = [];

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
      markSeedsExpanded: async (keywords: readonly string[]) => {
        markSeedsExpandedCalls.push(keywords);
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
    expect(markSeedsExpandedCalls[0]).toEqual(["budget", "meal prep"]);
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
      { seed: "budget", term: "budget planner", rank: 0, seenAt: expect.any(Number) },
      { seed: "budget", term: "budget bestie", rank: 1, seenAt: expect.any(Number) },
      { seed: "meal prep", term: "meal prep ideas", rank: 0, seenAt: expect.any(Number) },
    ]);
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
});
