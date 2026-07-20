import { describe, expect, it, mock, beforeEach } from "bun:test";
// Real (unmocked) import, resolved at file-load time BEFORE any
// `mock.module` call runs (those only execute inside `beforeEach`/`it`
// bodies) — re-exported from every `../shared/ssrf-safe-fetch` mock below so
// `keyword-gaps.ts`'s own `import { RateLimitError, ssrfSafeFetch } from
// "../shared/ssrf-safe-fetch"` always finds a real named export. Omitting it
// from a mock's returned object is a hard ESM SyntaxError at import time
// (missing named export), not a silent `undefined` — every mock factory
// below MUST include it. Same rule applies to EVERY named export
// `keyword-gaps.ts` imports from "./keyword-store" — every `mock.module("./
// keyword-store", ...)` factory below must include all of them, even ones a
// given test doesn't exercise.
import { RateLimitError } from "../shared/ssrf-safe-fetch";

/** Every `./keyword-store` export `keyword-gaps.ts` imports, with inert defaults. */
function keywordStoreMockBase() {
  return {
    getStaleKeywords: async () => [],
    getStaleKeywordsTiered: async () => [],
    insertScan: async () => {},
    markScanned: async () => {},
    getLatestScan: async () => null,
    getScanHistory: async () => [],
    countScansSince: async () => 0,
    countMinedScansSince: async () => 0,
    getKeywordMeta: async () => null,
    deactivateJunkKeywords: async () => 0,
    getMinedDeactivationStats: async () => ({
      scanCount: 0,
      maxDemand: 0,
      hasSignatureHit: false,
    }),
    getTier1ProtectedKeywords: async () => [],
  };
}

const sample = {
  results: [
    {
      trackId: 1,
      trackName: "LiverPal",
      userRatingCount: 7,
      averageUserRating: 5,
      releaseDate: "2020-01-01T00:00:00Z",
    },
    {
      trackId: 2,
      trackName: "Fatty Liver",
      userRatingCount: 1,
      averageUserRating: 1,
      releaseDate: "2019-01-01T00:00:00Z",
    },
  ],
};

// A single title-matching incumbent so demand/velocity flow through the
// matched-app path. `userRatingCount` is the "now" review count each velocity
// test diffs against its mocked baseline.
const velSample = {
  results: [
    {
      trackId: 100,
      trackName: "Budget Planner",
      userRatingCount: 5000,
      averageUserRating: 4.0,
      releaseDate: "2020-01-01T00:00:00Z",
      currentVersionReleaseDate: "2026-06-01T00:00:00Z",
      price: 0,
      formattedPrice: "Free",
    },
  ],
};

describe("scanKeyword velocity baseline", () => {
  const KEYWORD = "budget planner";
  const MATCHED_ID = "100";

  beforeEach(() => {
    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async () => ({ ok: true, json: async () => velSample }),
    }));
  });

  function mockHistory(rows: readonly unknown[]): void {
    mock.module("./keyword-store", () => ({
      ...keywordStoreMockBase(),
      getScanHistory: async () => rows,
    }));
  }

  it("activates recentVelocity from a baseline at least the min window old", async () => {
    const now = Math.floor(Date.now() / 1000);
    mockHistory([
      { store: "app", scannedAt: now - 86_400, demand: 500, topApps: [{ id: MATCHED_ID, reviews: 4000 }] },
    ]);
    const { scanKeyword } = await import("./keyword-gaps");
    const p = await scanKeyword(KEYWORD);
    const matched = p.topApps.find((a) => a.id === MATCHED_ID);
    // (5000 - 4000) reviews over ~1 day ≈ 1000/day — a REAL velocity, not the
    // tiny lifetime average (5000 / ~2400-day age ≈ 2/day).
    expect(matched?.recentVelocity).toBeCloseTo(1000, 0);
    // demand = lifetime baseline (~2/day) + velocity momentum (~1000/day): the
    // momentum dominates here, so demand tracks the velocity closely but is not
    // exactly it.
    expect(p.demand).toBeGreaterThan(990);
    expect(p.demand).toBeLessThan(1010);
  });

  it("skips a too-fresh scan and diffs against the older baseline when both exist", async () => {
    const now = Math.floor(Date.now() / 1000);
    mockHistory([
      // ~10 min old — too fresh to be a baseline (would give a noisy 100/day).
      { store: "app", scannedAt: now - 600, demand: 900, topApps: [{ id: MATCHED_ID, reviews: 4900 }] },
      // ~1 day old — the baseline actually used.
      { store: "app", scannedAt: now - 86_400, demand: 500, topApps: [{ id: MATCHED_ID, reviews: 4000 }] },
    ]);
    const { scanKeyword } = await import("./keyword-gaps");
    const p = await scanKeyword(KEYWORD);
    const matched = p.topApps.find((a) => a.id === MATCHED_ID);
    // Diffed against 4000 (≈1000/day), not the 4900 fresh point (≈100/day).
    expect(matched?.recentVelocity).toBeGreaterThan(500);
  });

  it("falls back to lifetime when the only prior scan is too fresh", async () => {
    const now = Math.floor(Date.now() / 1000);
    mockHistory([
      { store: "app", scannedAt: now - 600, demand: 900, topApps: [{ id: MATCHED_ID, reviews: 4900 }] },
    ]);
    const { scanKeyword } = await import("./keyword-gaps");
    const p = await scanKeyword(KEYWORD);
    const matched = p.topApps.find((a) => a.id === MATCHED_ID);
    expect(matched?.recentVelocity).toBeUndefined();
    // Lifetime ratingsPerDay = 5000 / ~2400-day age ≈ 2/day.
    expect(p.demand).toBeLessThan(50);
  });
});

describe("scanKeyword", () => {
  beforeEach(() => {
    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async () => ({ ok: true, json: async () => sample }),
    }));
    mock.module("./keyword-store", () => keywordStoreMockBase());
  });

  it("scores an open gap from live results", async () => {
    const { scanKeyword } = await import("./keyword-gaps");
    const p = await scanKeyword("fatty liver diet");
    expect(p.topApps.length).toBe(2);
    expect(p.competitiveness).toBeLessThan(30);
    expect(p.trend).toBe("new");
    expect(p.opportunity).toBeGreaterThan(0);
  });

  it("scores against the DE storefront when opts.store is 'DE', tagging the profile accordingly", async () => {
    let requestedUrl = "";
    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async (url: string) => {
        requestedUrl = url;
        return { ok: true, json: async () => sample };
      },
    }));

    const { scanKeyword } = await import("./keyword-gaps");
    const p = await scanKeyword("fatty liver diet", { store: "DE" });
    expect(p.store).toBe("DE");
    expect(requestedUrl).toContain("country=de");
  });
});

describe("runScanSlice", () => {
  let insertScanCalls: unknown[];
  let markScannedCalls: Array<{ keywords: readonly string[]; at: number }>;

  beforeEach(() => {
    insertScanCalls = [];
    markScannedCalls = [];

    mock.module("./keyword-store", () => ({
      ...keywordStoreMockBase(),
      getStaleKeywords: async () => ["a", "b"],
      insertScan: async (p: unknown) => {
        insertScanCalls.push(p);
      },
      markScanned: async (keywords: readonly string[], at: number) => {
        markScannedCalls.push({ keywords, at });
      },
    }));

    // Velocity recording (`scanAndRecord`) is a no-op in these orchestration
    // tests — its own bucketing/insert behavior is covered by
    // app-velocity-store.integration.test.ts.
    mock.module("./app-velocity-store", () => ({
      recordVelocityObservationsForScan: async () => ({ recorded: 0 }),
    }));

    let fetchCallCount = 0;
    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async () => {
        fetchCallCount++;
        if (fetchCallCount === 1) {
          return { ok: true, json: async () => sample };
        }
        throw new Error("network failure");
      },
    }));
  });

  it("scans the stale slice, tolerates a failing keyword, and marks only successes", async () => {
    const { runScanSlice } = await import("./keyword-gaps");
    const result = await runScanSlice({ genreZone: "health", budget: 10, delayMs: 0 });

    expect(result).toEqual({ scanned: 1, failed: 1 });
    expect(insertScanCalls.length).toBe(1);
    expect(markScannedCalls.length).toBe(1);
    expect(markScannedCalls[0]?.keywords).toEqual(["a"]);
  });

  it("never throws even if every keyword fails", async () => {
    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async () => {
        throw new Error("network failure");
      },
    }));

    const { runScanSlice } = await import("./keyword-gaps");
    const result = await runScanSlice({ genreZone: "health", budget: 10, delayMs: 0 });

    expect(result).toEqual({ scanned: 0, failed: 2 });
    expect(insertScanCalls.length).toBe(0);
    expect(markScannedCalls.length).toBe(0);
  });
});

describe("runKeywordSweep", () => {
  let insertScanCalls: unknown[];
  let markScannedCalls: Array<{ keywords: readonly string[]; at: number }>;
  let staleKeywordsTieredCalls: Array<{ batchLimit: number; mineQuotaRemaining: number }>;

  beforeEach(() => {
    insertScanCalls = [];
    markScannedCalls = [];
    staleKeywordsTieredCalls = [];

    mock.module("./keyword-store", () => ({
      ...keywordStoreMockBase(),
      getStaleKeywordsTiered: async (opts: { batchLimit: number; mineQuotaRemaining: number }) => {
        staleKeywordsTieredCalls.push(opts);
        return ["a", "b"];
      },
      insertScan: async (p: unknown) => {
        insertScanCalls.push(p);
      },
      markScanned: async (keywords: readonly string[], at: number) => {
        markScannedCalls.push({ keywords, at });
      },
    }));

    mock.module("./app-velocity-store", () => ({
      recordVelocityObservationsForScan: async () => ({ recorded: 0 }),
    }));

    let fetchCallCount = 0;
    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async () => {
        fetchCallCount++;
        if (fetchCallCount === 1) {
          return { ok: true, json: async () => sample };
        }
        throw new Error("network failure");
      },
    }));
  });

  it("scans the globally stalest slice across zones, tolerates a failing keyword, and marks only successes", async () => {
    const { runKeywordSweep } = await import("./keyword-gaps");
    const result = await runKeywordSweep({ limit: 25, delayMs: 0 });

    expect(result).toEqual({ scanned: 1, failed: 1, skipped: false, bailed: false, rateLimitErrors: 0 });
    expect(staleKeywordsTieredCalls).toEqual([{ batchLimit: 25, mineQuotaRemaining: 5_000 }]);
    expect(insertScanCalls.length).toBe(1);
    expect(markScannedCalls.length).toBe(1);
    expect(markScannedCalls[0]?.keywords).toEqual(["a"]);
  });

  it("skips the sweep without scanning anything when the rolling 24h budget is reached", async () => {
    mock.module("./keyword-store", () => ({
      ...keywordStoreMockBase(),
      getStaleKeywordsTiered: async (opts: { batchLimit: number; mineQuotaRemaining: number }) => {
        staleKeywordsTieredCalls.push(opts);
        return ["a", "b"];
      },
      insertScan: async (p: unknown) => {
        insertScanCalls.push(p);
      },
      markScanned: async (keywords: readonly string[], at: number) => {
        markScannedCalls.push({ keywords, at });
      },
      // Default config's dailyKeywordBudget is 60_000 — return a count that
      // already meets it so the sweep must skip.
      countScansSince: async () => 60_000,
    }));

    const { runKeywordSweep } = await import("./keyword-gaps");
    const result = await runKeywordSweep({ limit: 25, delayMs: 0 });

    expect(result).toEqual({ scanned: 0, failed: 0, skipped: true, bailed: false, rateLimitErrors: 0 });
    expect(staleKeywordsTieredCalls.length).toBe(0);
    expect(insertScanCalls.length).toBe(0);
    expect(markScannedCalls.length).toBe(0);
  });

  it("subtracts countMinedScansSince from the mined daily quota when computing mineQuotaRemaining", async () => {
    mock.module("./keyword-store", () => ({
      ...keywordStoreMockBase(),
      getStaleKeywordsTiered: async (opts: { batchLimit: number; mineQuotaRemaining: number }) => {
        staleKeywordsTieredCalls.push(opts);
        return [];
      },
      // Default config's minedExploration.dailyQuota is 5_000.
      countMinedScansSince: async () => 4_990,
    }));

    const { runKeywordSweep } = await import("./keyword-gaps");
    await runKeywordSweep({ limit: 25, delayMs: 0 });

    expect(staleKeywordsTieredCalls).toEqual([{ batchLimit: 25, mineQuotaRemaining: 10 }]);
  });

  it("floors mineQuotaRemaining at 0 rather than going negative when mined scans exceed the quota", async () => {
    mock.module("./keyword-store", () => ({
      ...keywordStoreMockBase(),
      getStaleKeywordsTiered: async (opts: { batchLimit: number; mineQuotaRemaining: number }) => {
        staleKeywordsTieredCalls.push(opts);
        return [];
      },
      countMinedScansSince: async () => 999_999,
    }));

    const { runKeywordSweep } = await import("./keyword-gaps");
    await runKeywordSweep({ limit: 25, delayMs: 0 });

    expect(staleKeywordsTieredCalls).toEqual([{ batchLimit: 25, mineQuotaRemaining: 0 }]);
  });

  it("bails early after too many consecutive scan failures instead of burning the whole slice", async () => {
    // Seven keywords, every fetch throws: the sweep must stop after the 5th
    // consecutive failure rather than attempting all seven.
    mock.module("./keyword-store", () => ({
      ...keywordStoreMockBase(),
      getStaleKeywordsTiered: async (opts: { batchLimit: number; mineQuotaRemaining: number }) => {
        staleKeywordsTieredCalls.push(opts);
        return ["a", "b", "c", "d", "e", "f", "g"];
      },
      insertScan: async (p: unknown) => {
        insertScanCalls.push(p);
      },
      markScanned: async (keywords: readonly string[], at: number) => {
        markScannedCalls.push({ keywords, at });
      },
    }));

    let fetchCalls = 0;
    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async () => {
        fetchCalls++;
        throw new Error("rate limited");
      },
    }));

    const { runKeywordSweep } = await import("./keyword-gaps");
    const result = await runKeywordSweep({ limit: 25, delayMs: 0 });

    // Stopped at the 5-consecutive-failure threshold: 5 attempted, 2 untouched.
    expect(result).toEqual({ scanned: 0, failed: 5, skipped: false, bailed: true, rateLimitErrors: 0 });
    expect(fetchCalls).toBe(5);
    expect(insertScanCalls.length).toBe(0);
    expect(markScannedCalls.length).toBe(0);
  });

  it("counts rate-limit failures separately in `rateLimitErrors` (feeds the adaptive throttle)", async () => {
    // A rate-limit-shaped error carries `code: 'RATE_LIMITED'` (what the real
    // `RateLimitError` from ssrf-safe-fetch.ts exposes) — `scanAndRecord`
    // must detect it via duck-typing, since this mock doesn't re-export the
    // real class (see `isRateLimitError`'s doc comment in keyword-gaps.ts).
    mock.module("./keyword-store", () => ({
      ...keywordStoreMockBase(),
      getStaleKeywordsTiered: async (opts: { batchLimit: number; mineQuotaRemaining: number }) => {
        staleKeywordsTieredCalls.push(opts);
        return ["a", "b"];
      },
      insertScan: async (p: unknown) => {
        insertScanCalls.push(p);
      },
      markScanned: async (keywords: readonly string[], at: number) => {
        markScannedCalls.push({ keywords, at });
      },
    }));

    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async () => {
        const err = new Error("Rate limited (HTTP 429)");
        (err as { code?: string }).code = "RATE_LIMITED";
        throw err;
      },
    }));

    const { runKeywordSweep } = await import("./keyword-gaps");
    const result = await runKeywordSweep({ limit: 25, delayMs: 0 });

    expect(result.failed).toBe(2);
    expect(result.rateLimitErrors).toBe(2);
    expect(result.scanned).toBe(0);
  });
});

describe("scanAndRecord mined-specific deactivation (via runKeywordSweep)", () => {
  let deactivateCalls: string[][];

  beforeEach(() => {
    deactivateCalls = [];
    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async () => ({ ok: true, json: async () => sample }),
    }));
    mock.module("./app-velocity-store", () => ({
      recordVelocityObservationsForScan: async () => ({ recorded: 0 }),
    }));
  });

  it("deactivates a mined keyword whose demand never crossed 5 in any scan and has no signature hit", async () => {
    mock.module("./keyword-store", () => ({
      ...keywordStoreMockBase(),
      getStaleKeywordsTiered: async () => ["hopeless-mined-term"],
      getKeywordMeta: async () => ({ firstFoundAt: 0, source: "mined" as const }),
      getMinedDeactivationStats: async () => ({
        scanCount: 3,
        maxDemand: 2, // never reached 5
        hasSignatureHit: false,
      }),
      deactivateJunkKeywords: async (keywords: readonly string[]) => {
        deactivateCalls.push([...keywords]);
        return keywords.length;
      },
    }));

    const { runKeywordSweep } = await import("./keyword-gaps");
    await runKeywordSweep({ limit: 25, delayMs: 0 });

    expect(deactivateCalls).toEqual([["hopeless-mined-term"]]);
  });

  it("does NOT deactivate a mined keyword with a signature hit, even with low demand", async () => {
    mock.module("./keyword-store", () => ({
      ...keywordStoreMockBase(),
      getStaleKeywordsTiered: async () => ["watchlisted-mined-term"],
      getKeywordMeta: async () => ({ firstFoundAt: 0, source: "mined" as const }),
      getMinedDeactivationStats: async () => ({
        scanCount: 3,
        maxDemand: 2,
        hasSignatureHit: true, // exempt
      }),
      deactivateJunkKeywords: async (keywords: readonly string[]) => {
        deactivateCalls.push([...keywords]);
        return keywords.length;
      },
    }));

    const { runKeywordSweep } = await import("./keyword-gaps");
    await runKeywordSweep({ limit: 25, delayMs: 0 });

    expect(deactivateCalls).toEqual([]);
  });

  it("does NOT apply the mined-specific rule to a non-mined source, even with the same low-demand stats", async () => {
    mock.module("./keyword-store", () => ({
      ...keywordStoreMockBase(),
      getStaleKeywordsTiered: async () => ["seed-term"],
      getKeywordMeta: async () => ({ firstFoundAt: 0, source: "seed" as const }),
      // getMinedDeactivationStats must not even matter here — 'seed' is
      // protected outright by shouldDeactivateKeyword, and the mined-specific
      // rule never fires for a non-mined source.
      getMinedDeactivationStats: async () => ({
        scanCount: 3,
        maxDemand: 0,
        hasSignatureHit: false,
      }),
      deactivateJunkKeywords: async (keywords: readonly string[]) => {
        deactivateCalls.push([...keywords]);
        return keywords.length;
      },
    }));

    const { runKeywordSweep } = await import("./keyword-gaps");
    await runKeywordSweep({ limit: 25, delayMs: 0 });

    expect(deactivateCalls).toEqual([]);
  });
});

describe("runDeStorefrontSweep", () => {
  it("scans the tier-1-protected corpus against the DE storefront, tags rows store: 'DE', and never marks appstore_keywords.last_scanned_at or runs deactivation/velocity bookkeeping", async () => {
    const insertScanCalls: Array<{ store: string }> = [];
    const markScannedCalls: unknown[] = [];
    const deactivateCalls: unknown[] = [];
    const velocityCalls: unknown[] = [];
    let requestedUrl = "";

    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async (url: string) => {
        requestedUrl = url;
        return { ok: true, json: async () => sample };
      },
    }));
    mock.module("./app-velocity-store", () => ({
      recordVelocityObservationsForScan: async (p: unknown) => {
        velocityCalls.push(p);
        return { recorded: 0 };
      },
    }));
    mock.module("./keyword-store", () => ({
      ...keywordStoreMockBase(),
      getTier1ProtectedKeywords: async () => ["de-lane-term"],
      insertScan: async (p: { store: string }) => {
        insertScanCalls.push(p);
      },
      markScanned: async (keywords: readonly string[]) => {
        markScannedCalls.push(keywords);
      },
      deactivateJunkKeywords: async (keywords: readonly string[]) => {
        deactivateCalls.push(keywords);
        return keywords.length;
      },
      getKeywordMeta: async () => ({ firstFoundAt: 0, source: "seed" as const }),
    }));

    const { runDeStorefrontSweep } = await import("./keyword-gaps");
    const result = await runDeStorefrontSweep({ delayMs: 0 });

    expect(result.scanned).toBe(1);
    expect(insertScanCalls).toHaveLength(1);
    expect(insertScanCalls[0]?.store).toBe("DE");
    expect(requestedUrl).toContain("country=de");
    // Never touches the shared US staleness cadence.
    expect(markScannedCalls).toHaveLength(0);
    // Never runs junk-deactivation or velocity bookkeeping against DE data.
    expect(deactivateCalls).toHaveLength(0);
    expect(velocityCalls).toHaveLength(0);
  });
});
