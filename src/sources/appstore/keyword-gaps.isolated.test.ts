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
// Real (unmocked) import too — used to build a COMPLETE, schema-derived
// config for the deep-scan lane-wiring tests below, never a hand-rolled
// partial object that could silently drift from `src/config/schema.ts`.
import { opencrowConfigSchema } from "../../config/schema";

// Batch C3: `keyword-gaps.ts` now imports `mapCategoryToZone` from
// "./keyword-miner" (corpus zone self-healing). Deliberately NOT mocked —
// `mapCategoryToZone` is a pure function and this file has no reason to fake
// its behavior; a wholesale stub mock here previously leaked into ANOTHER
// file's `scraper.ts` -> `keyword-review-miner.ts` transitive import chain
// (all *.isolated.test.ts files share ONE bun process AND the project's
// pre-commit hook can additionally batch *.test.ts + *.isolated.test.ts
// files together in a single `bun test` invocation — see the "isolated lane
// mock leak" convention elsewhere in this directory) — a stub's IDENTITY
// `normalizeText`/case-sensitive comparisons silently diverged from the
// real implementation once it won that cross-file race. Leaving
// "./keyword-miner" real instead means `keyword-miner.ts` itself needs
// `getScannedAppNames`/`keywordsExist`/`upsertKeywords` from THIS file's
// "./keyword-store" mock (below) even though no test here calls
// `mineKeywords` — see `keywordStoreMockBase`'s doc comment.
/**
 * Every `./keyword-store` export `keyword-gaps.ts` imports, with inert
 * defaults. Also includes `getScannedAppNames`/`keywordsExist`/
 * `upsertKeywords` — not read by `keyword-gaps.ts` itself, but required
 * because `keyword-gaps.ts` now imports (real, unmocked) `mapCategoryToZone`
 * from "./keyword-miner", and `keyword-miner.ts`'s own top-level `import {
 * getScannedAppNames, keywordsExist, upsertKeywords } from "./keyword-store"`
 * resolves to THIS mock — a missing name here is a load-time ESM
 * SyntaxError regardless of whether the binding is ever called.
 */
function keywordStoreMockBase() {
  return {
    getStaleKeywords: async () => [],
    getStaleKeywordsTiered: async () => [],
    getScannedAppNames: async () => [],
    keywordsExist: async () => new Set<string>(),
    upsertKeywords: async (rows: readonly unknown[]) => rows.length,
    insertScan: async () => {},
    markScanned: async () => {},
    // Batch A budget rescue (2026-07-22) — the DE storefront lane's own
    // resume-cursor bookkeeping (see keyword-store.ts's `markDeScanned`).
    markDeScanned: async () => {},
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
    getTier1ProtectedKeywords: async (_limit: number) => [],
    // Batch C3 (corpus zone self-healing) — inert no-op default; tests that
    // specifically exercise `setKeywordZone` override this.
    setKeywordZone: async () => false,
    // Batch D item D1: `computeGapProfile` looks up hint evidence on every
    // scan — default to "no evidence" (neutral multiplier, never a penalty)
    // so pre-existing tests that don't exercise this path are unaffected.
    getHintEvidence: async () => new Map(),
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
      {
        store: "app",
        scannedAt: now - 86_400,
        demand: 500,
        topApps: [{ id: MATCHED_ID, reviews: 4970 }],
      },
    ]);
    const { scanKeyword } = await import("./keyword-gaps");
    const p = await scanKeyword(KEYWORD);
    const matched = p.topApps.find((a) => a.id === MATCHED_ID);
    // (5000 - 4970) reviews over ~1 day = 30/day — a REAL velocity, not the
    // tiny lifetime average (5000 / ~2400-day age ≈ 2/day), and comfortably
    // under the flap-robustness cap (max(10x lifetime rpd, 50/day) ≈ 50/day
    // for this fixture — see the dedicated cap test below) so this test
    // isolates baseline ACTIVATION from capping.
    expect(matched?.recentVelocity).toBeCloseTo(30, 0);
    // demand = lifetime baseline (~2/day) + velocity momentum (~30/day): the
    // momentum dominates here, so demand tracks the velocity closely but is
    // not exactly it.
    expect(p.demand).toBeGreaterThan(28);
    expect(p.demand).toBeLessThan(36);
  });

  it("skips a too-fresh scan and diffs against the older baseline when both exist", async () => {
    const now = Math.floor(Date.now() / 1000);
    mockHistory([
      // ~10 min old — too fresh to be a baseline (would give a noisy, huge
      // implied rate if wrongly used).
      {
        store: "app",
        scannedAt: now - 600,
        demand: 900,
        topApps: [{ id: MATCHED_ID, reviews: 4990 }],
      },
      // ~1 day old — the baseline actually used.
      {
        store: "app",
        scannedAt: now - 86_400,
        demand: 500,
        topApps: [{ id: MATCHED_ID, reviews: 4970 }],
      },
    ]);
    const { scanKeyword } = await import("./keyword-gaps");
    const p = await scanKeyword(KEYWORD);
    const matched = p.topApps.find((a) => a.id === MATCHED_ID);
    // Diffed against 4970 (30/day), not the 4990 fresh point.
    expect(matched?.recentVelocity).toBeCloseTo(30, 0);
  });

  it("falls back to lifetime when the only prior scan is too fresh", async () => {
    const now = Math.floor(Date.now() / 1000);
    mockHistory([
      {
        store: "app",
        scannedAt: now - 600,
        demand: 900,
        topApps: [{ id: MATCHED_ID, reviews: 4900 }],
      },
    ]);
    const { scanKeyword } = await import("./keyword-gaps");
    const p = await scanKeyword(KEYWORD);
    const matched = p.topApps.find((a) => a.id === MATCHED_ID);
    expect(matched?.recentVelocity).toBeUndefined();
    // Lifetime ratingsPerDay = 5000 / ~2400-day age ≈ 2/day.
    expect(p.demand).toBeLessThan(50);
  });

  // 2026-07-21 audit item C fix: flap-robust velocity baseline + cap.
  it("caps recentVelocity at max(10x lifetime ratingsPerDay, 50/day) instead of an implausible raw spike", async () => {
    const now = Math.floor(Date.now() / 1000);
    mockHistory([
      {
        store: "app",
        scannedAt: now - 86_400,
        demand: 500,
        topApps: [{ id: MATCHED_ID, reviews: 4000 }],
      },
    ]);
    const { scanKeyword } = await import("./keyword-gaps");
    const p = await scanKeyword(KEYWORD);
    const matched = p.topApps.find((a) => a.id === MATCHED_ID);
    // Raw would be (5000-4000)/1 day = 1000/day; lifetime ratingsPerDay for
    // this fixture is ~2/day (5000 reviews / ~2400-day age), so the cap is
    // max(10*2, 50) = 50/day — well under the raw 1000/day.
    expect(matched?.recentVelocity).toBeCloseTo(50, 0);
    expect(matched?.recentVelocity).toBeLessThan(1000);
  });

  it("takes the max across the two newest eligible baselines, surviving a drop-then-recover flap", async () => {
    const now = Math.floor(Date.now() / 1000);
    mockHistory([
      // ~1 day old — the newest eligible baseline, but a transient DOWNWARD
      // flap (a glitched/corrected review-count reading).
      {
        store: "app",
        scannedAt: now - 86_400,
        demand: 500,
        topApps: [{ id: MATCHED_ID, reviews: 4000 }],
      },
      // ~2 days old — the second-newest eligible baseline, at the REAL
      // (pre-flap) level. Taking the max of the two anchors the baseline
      // here instead of at the flapped dip.
      {
        store: "app",
        scannedAt: now - 172_800,
        demand: 480,
        topApps: [{ id: MATCHED_ID, reviews: 4970 }],
      },
    ]);
    const { scanKeyword } = await import("./keyword-gaps");
    const p = await scanKeyword(KEYWORD);
    const matched = p.topApps.find((a) => a.id === MATCHED_ID);
    // (5000 - max(4000, 4970)) / 1 day = 30/day — NOT (5000-4000)/1 day =
    // 1000/day, which diffing against only the single newest (flapped)
    // baseline would have produced (and which would then have been capped
    // to 50/day, masking the bug rather than exposing it — 30 is
    // distinguishable from both the uncapped 1000 and the capped 50).
    expect(matched?.recentVelocity).toBeCloseTo(30, 0);
  });

  // Literal audit reproduction: "a flap sequence (reviews N, then N−37k,
  // then back to ~N) produces velocity ≈ 0, not a phantom spike."
  it("a flap sequence (N, then N-37k, then back to ~N) produces velocity ≈ 0, not a phantom spike", async () => {
    const N = 42_000;
    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async () => ({
        ok: true,
        json: async () => ({
          results: [
            {
              trackId: 100,
              trackName: "Budget Planner",
              userRatingCount: N, // "now" — back to ~N
              averageUserRating: 4.0,
              releaseDate: "2020-01-01T00:00:00Z",
              currentVersionReleaseDate: "2026-06-01T00:00:00Z",
              price: 0,
              formattedPrice: "Free",
            },
          ],
        }),
      }),
    }));
    const now = Math.floor(Date.now() / 1000);
    mockHistory([
      // ~1 day old — the newest eligible baseline, at the flapped dip (N-37k).
      {
        store: "app",
        scannedAt: now - 86_400,
        demand: 500,
        topApps: [{ id: MATCHED_ID, reviews: N - 37_000 }],
      },
      // ~2 days old — the second-newest eligible baseline, at ~N (pre-flap).
      {
        store: "app",
        scannedAt: now - 172_800,
        demand: 480,
        topApps: [{ id: MATCHED_ID, reviews: N }],
      },
    ]);
    const { scanKeyword } = await import("./keyword-gaps");
    const p = await scanKeyword(KEYWORD);
    const matched = p.topApps.find((a) => a.id === MATCHED_ID);
    // max(N-37k, N) = N; N (now) - N (baseline) = 0 — no phantom spike from
    // diffing against the single-newest (dipped) reading.
    expect(matched?.recentVelocity).toBeCloseTo(0, 0);
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

// 2026-07-21 audit item C fix: kill the zero-title-match whole-SERP demand
// fallback. When nothing title-matches, demand must come ONLY from
// non-matched, non-giant (< GIANT_REVIEW_THRESHOLD reviews) apps — never
// from the raw unfiltered SERP average, which let review-mass giants
// unrelated to the keyword set demand via sheer volume.
describe("zero-match giant-exclusion fallback (2026-07-21 audit item C fix)", () => {
  beforeEach(() => {
    mock.module("./keyword-store", () => keywordStoreMockBase());
  });

  it("a WhatsApp-class giant, non-title-matched, scores demand ≈ 0 on a 'credit score widget'-shaped SERP (not 498 via the old raw-SERP fallback)", async () => {
    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async () => ({
        ok: true,
        json: async () => ({
          results: [
            {
              trackId: 1,
              trackName: "WhatsApp Messenger",
              userRatingCount: 500_000,
              averageUserRating: 4.5,
              releaseDate: "2014-01-01T00:00:00Z",
            },
          ],
        }),
      }),
    }));

    const { scanKeyword } = await import("./keyword-gaps");
    const p = await scanKeyword("credit score widget");

    expect(p.topApps.every((a) => !a.titleMatch)).toBe(true);
    expect(p.lowConfidence).toBe(true);
    expect(p.demand).toBe(0);
  });

  it("a DE giant-contaminated, zero-title-match SERP scores demand ≈ 0 (not the audit's measured ~140 raw-SERP-fallback average)", async () => {
    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async () => ({
        ok: true,
        json: async () => ({
          results: [
            {
              trackId: 1,
              trackName: "Stromrechner Deutschland",
              userRatingCount: 250_000,
              averageUserRating: 4.2,
              releaseDate: "2015-01-01T00:00:00Z",
            },
            {
              trackId: 2,
              trackName: "Energie Sparen Pro",
              userRatingCount: 180_000,
              averageUserRating: 4.0,
              releaseDate: "2016-01-01T00:00:00Z",
            },
          ],
        }),
      }),
    }));

    const { scanKeyword } = await import("./keyword-gaps");
    const p = await scanKeyword("time of use electricity", { store: "DE" });

    expect(p.topApps.every((a) => !a.titleMatch)).toBe(true);
    expect(p.lowConfidence).toBe(true);
    expect(p.demand).toBe(0);
  });

  it("falls back to non-matched, non-giant apps when zero apps title-match — still flagged low-confidence, but demand is not forced to 0", async () => {
    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async () => ({
        ok: true,
        json: async () => ({
          results: [
            {
              trackId: 1,
              trackName: "Totally Unrelated App",
              userRatingCount: 5_000, // well under GIANT_REVIEW_THRESHOLD
              averageUserRating: 4.0,
              releaseDate: "2020-01-01T00:00:00Z",
            },
          ],
        }),
      }),
    }));

    const { scanKeyword } = await import("./keyword-gaps");
    const p = await scanKeyword("some niche keyword phrase");

    expect(p.lowConfidence).toBe(true);
    expect(p.demand).toBeGreaterThan(0);
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
  let staleKeywordsTieredCalls: Array<{
    batchLimit: number;
    mineQuotaRemaining: number;
    tier1StaleThresholdMs: number;
    perSweepCap: number;
    tier1AutocompleteCap: number;
  }>;

  // Default config values (src/config/schema.ts's appstoreKeywordGapConfigSchema
  // defaults). 2026-07-21 audit NOW-tier fixes set tier1StaleThresholdMs =
  // 12h, minedExploration.dailyQuota = 20_000. The 2026-07-21 capacity-raise
  // escalation (post PR #328, Webshare proxy now paid/armed) halved
  // tier1StaleThresholdMs again to 6h and raised dailyQuota to 30_000. The
  // 2026-07-22 max-throughput pass raised dailyQuota again, 30_000 -> 100_000
  // (see schema.ts's "MAX-THROUGHPUT PASS" comment). tier1AutocompleteCap =
  // 50 (Batch A budget rescue, 2026-07-22 structural guard default,
  // unchanged by the throughput pass).
  //
  // CONTINUOUS FETCH (2026-07-23): `perSweepCap` is no longer derived from
  // `dailyQuota`/`scanIntervalMs` (the old formula produced ~70/sweep at
  // these defaults, which paced — and effectively idled — the mined lane;
  // see keyword-tiering.ts's module doc). `runKeywordSweep` now passes its
  // OWN `limit` (this cycle's batch size, i.e. whatever `{ limit }` the test
  // below invokes it with) straight through as `perSweepCap` — no additional
  // ceiling beyond the batch itself.
  const DEFAULT_TIER1_STALE_THRESHOLD_MS = 6 * 60 * 60 * 1000;
  const DEFAULT_MINE_DAILY_QUOTA = 100_000;
  const DEFAULT_TIER1_AUTOCOMPLETE_CAP = 50;

  beforeEach(() => {
    insertScanCalls = [];
    markScannedCalls = [];
    staleKeywordsTieredCalls = [];

    mock.module("./keyword-store", () => ({
      ...keywordStoreMockBase(),
      getStaleKeywordsTiered: async (opts: {
        batchLimit: number;
        mineQuotaRemaining: number;
        tier1StaleThresholdMs: number;
        perSweepCap: number;
        tier1AutocompleteCap: number;
      }) => {
        staleKeywordsTieredCalls.push(opts);
        return [
          { keyword: "a", lane: "tier1" as const },
          { keyword: "b", lane: "tier1" as const },
        ];
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

    expect(result).toEqual({
      scanned: 1,
      failed: 1,
      skipped: false,
      bailed: false,
      rateLimitErrors: 0,
      mineQuotaRemaining: DEFAULT_MINE_DAILY_QUOTA,
    });
    expect(staleKeywordsTieredCalls).toEqual([
      {
        batchLimit: 25,
        mineQuotaRemaining: DEFAULT_MINE_DAILY_QUOTA,
        tier1StaleThresholdMs: DEFAULT_TIER1_STALE_THRESHOLD_MS,
        // Continuous fetch (2026-07-23): perSweepCap == batchLimit (opts.limit
        // passed straight through), no longer a daily-quota-paced slice.
        perSweepCap: 25,
        tier1AutocompleteCap: DEFAULT_TIER1_AUTOCOMPLETE_CAP,
      },
    ]);
    expect(insertScanCalls.length).toBe(1);
    expect(markScannedCalls.length).toBe(1);
    expect(markScannedCalls[0]?.keywords).toEqual(["a"]);
  });

  // Continuous fetch (2026-07-23): `perSweepCap` must track `opts.limit`
  // directly, NOT the old `ceil(dailyQuota * scanIntervalMs / 86_400_000)`
  // formula (~70/sweep at the default 100_000 quota — see
  // keyword-tiering.ts's module doc). At the real production
  // `keywordsPerSweep` default (600), the old formula would have kept
  // capping mined exploration at ~70 regardless of batch size; this proves
  // the cap now scales with the batch instead, decoupled from dailyQuota.
  it("computes perSweepCap as this cycle's own batch limit, decoupled from minedExploration.dailyQuota/scanIntervalMs", async () => {
    const { runKeywordSweep } = await import("./keyword-gaps");
    await runKeywordSweep({ limit: 600, delayMs: 0 });

    expect(staleKeywordsTieredCalls).toEqual([
      {
        batchLimit: 600,
        mineQuotaRemaining: DEFAULT_MINE_DAILY_QUOTA,
        tier1StaleThresholdMs: DEFAULT_TIER1_STALE_THRESHOLD_MS,
        perSweepCap: 600,
        tier1AutocompleteCap: DEFAULT_TIER1_AUTOCOMPLETE_CAP,
      },
    ]);
  });

  it("skips the sweep without scanning anything when the rolling 24h budget is reached", async () => {
    mock.module("./keyword-store", () => ({
      ...keywordStoreMockBase(),
      getStaleKeywordsTiered: async (opts: {
        batchLimit: number;
        mineQuotaRemaining: number;
        tier1StaleThresholdMs: number;
        perSweepCap: number;
        tier1AutocompleteCap: number;
      }) => {
        staleKeywordsTieredCalls.push(opts);
        return [
          { keyword: "a", lane: "tier1" as const },
          { keyword: "b", lane: "tier1" as const },
        ];
      },
      insertScan: async (p: unknown) => {
        insertScanCalls.push(p);
      },
      markScanned: async (keywords: readonly string[], at: number) => {
        markScannedCalls.push({ keywords, at });
      },
      // Default config's dailyKeywordBudget is 150_000 (max-throughput pass,
      // 2026-07-22) — return a count that already meets it so the sweep must
      // skip.
      countScansSince: async () => 150_000,
    }));

    const { runKeywordSweep } = await import("./keyword-gaps");
    const result = await runKeywordSweep({ limit: 25, delayMs: 0 });

    expect(result).toEqual({
      scanned: 0,
      failed: 0,
      skipped: true,
      bailed: false,
      rateLimitErrors: 0,
      mineQuotaRemaining: DEFAULT_MINE_DAILY_QUOTA,
    });
    expect(staleKeywordsTieredCalls.length).toBe(0);
    expect(insertScanCalls.length).toBe(0);
    expect(markScannedCalls.length).toBe(0);
  });

  it("subtracts countMinedScansSince from the mined daily quota when computing mineQuotaRemaining", async () => {
    mock.module("./keyword-store", () => ({
      ...keywordStoreMockBase(),
      getStaleKeywordsTiered: async (opts: {
        batchLimit: number;
        mineQuotaRemaining: number;
        tier1StaleThresholdMs: number;
        perSweepCap: number;
        tier1AutocompleteCap: number;
      }) => {
        staleKeywordsTieredCalls.push(opts);
        return [];
      },
      // Default config's minedExploration.dailyQuota is 100_000
      // (max-throughput pass, 2026-07-22).
      countMinedScansSince: async () => 99_990,
    }));

    const { runKeywordSweep } = await import("./keyword-gaps");
    await runKeywordSweep({ limit: 25, delayMs: 0 });

    expect(staleKeywordsTieredCalls).toEqual([
      {
        batchLimit: 25,
        mineQuotaRemaining: 10,
        tier1StaleThresholdMs: DEFAULT_TIER1_STALE_THRESHOLD_MS,
        // Continuous fetch (2026-07-23): perSweepCap == batchLimit (opts.limit
        // passed straight through), no longer a daily-quota-paced slice.
        perSweepCap: 25,
        tier1AutocompleteCap: DEFAULT_TIER1_AUTOCOMPLETE_CAP,
      },
    ]);
  });

  it("floors mineQuotaRemaining at 0 rather than going negative when mined scans exceed the quota", async () => {
    mock.module("./keyword-store", () => ({
      ...keywordStoreMockBase(),
      getStaleKeywordsTiered: async (opts: {
        batchLimit: number;
        mineQuotaRemaining: number;
        tier1StaleThresholdMs: number;
        perSweepCap: number;
        tier1AutocompleteCap: number;
      }) => {
        staleKeywordsTieredCalls.push(opts);
        return [];
      },
      countMinedScansSince: async () => 999_999,
    }));

    const { runKeywordSweep } = await import("./keyword-gaps");
    await runKeywordSweep({ limit: 25, delayMs: 0 });

    expect(staleKeywordsTieredCalls).toEqual([
      {
        batchLimit: 25,
        mineQuotaRemaining: 0,
        tier1StaleThresholdMs: DEFAULT_TIER1_STALE_THRESHOLD_MS,
        // Continuous fetch (2026-07-23): perSweepCap == batchLimit (opts.limit
        // passed straight through), no longer a daily-quota-paced slice.
        perSweepCap: 25,
        tier1AutocompleteCap: DEFAULT_TIER1_AUTOCOMPLETE_CAP,
      },
    ]);
  });

  it("bails early after too many consecutive scan failures instead of burning the whole slice", async () => {
    // Seven keywords, every fetch throws: the sweep must stop after the 5th
    // consecutive failure rather than attempting all seven.
    mock.module("./keyword-store", () => ({
      ...keywordStoreMockBase(),
      getStaleKeywordsTiered: async (opts: {
        batchLimit: number;
        mineQuotaRemaining: number;
        tier1StaleThresholdMs: number;
        perSweepCap: number;
        tier1AutocompleteCap: number;
      }) => {
        staleKeywordsTieredCalls.push(opts);
        return ["a", "b", "c", "d", "e", "f", "g"].map((keyword) => ({
          keyword,
          lane: "tier1" as const,
        }));
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
    expect(result).toEqual({
      scanned: 0,
      failed: 5,
      skipped: false,
      bailed: true,
      rateLimitErrors: 0,
      mineQuotaRemaining: DEFAULT_MINE_DAILY_QUOTA,
    });
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
      getStaleKeywordsTiered: async (opts: {
        batchLimit: number;
        mineQuotaRemaining: number;
        tier1StaleThresholdMs: number;
        perSweepCap: number;
        tier1AutocompleteCap: number;
      }) => {
        staleKeywordsTieredCalls.push(opts);
        return [
          { keyword: "a", lane: "tier1" as const },
          { keyword: "b", lane: "tier1" as const },
        ];
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

  // Batch A budget rescue (2026-07-22), PR #327 consistency: `scanAndRecord`
  // now consults the SAME wall-clock pass-deadline guard other deep-scrape
  // lanes already use — see `newborn-reobservation.isolated.test.ts`'s
  // sibling test for the same technique (mocking `isPassOverBudget` itself
  // rather than actually waiting out `MAX_PASS_DURATION_MS`). Proves the
  // batch bails via the wall-clock guard even when every scan succeeds — the
  // unrelated consecutive-failure counter alone could never produce this.
  it("bails via the wall-clock pass-deadline guard even when every scan is succeeding", async () => {
    mock.module("./keyword-store", () => ({
      ...keywordStoreMockBase(),
      getStaleKeywordsTiered: async () =>
        Array.from({ length: 10 }, (_, i) => ({ keyword: `k${i}`, lane: "tier1" as const })),
    }));
    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async () => ({ ok: true, json: async () => sample }),
    }));

    let budgetChecks = 0;
    mock.module("../shared/pass-deadline", () => ({
      isPassOverBudget: () => {
        budgetChecks++;
        return budgetChecks > 3;
      },
    }));

    const { runKeywordSweep } = await import("./keyword-gaps");
    const result = await runKeywordSweep({ limit: 25, delayMs: 0 });

    expect(result.bailed).toBe(true);
    expect(result.scanned).toBe(3);
    expect(result.failed).toBe(0);
    expect(budgetChecks).toBe(4);

    // Reset — `mock.module` mocks persist for the rest of this file's shared
    // bun process (see this repo's "Isolated lane mock leak" note); every
    // OTHER describe block below expects the real (never-trips-within-a-
    // fast-test) `isPassOverBudget`, so this test must not leave its
    // trips-after-3-checks stub active for them.
    mock.module("../shared/pass-deadline", () => ({
      isPassOverBudget: () => false,
    }));
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
      getStaleKeywordsTiered: async () => [
        { keyword: "hopeless-mined-term", lane: "mined" as const },
      ],
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
      getStaleKeywordsTiered: async () => [
        { keyword: "watchlisted-mined-term", lane: "mined" as const },
      ],
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
      getStaleKeywordsTiered: async () => [{ keyword: "seed-term", lane: "tier1" as const }],
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

// Batch A budget rescue (2026-07-22) — see keyword-brand.ts module doc,
// layer 2, and keyword-deactivation.ts's shouldDeactivateBrandNavigationalKeyword.
describe("scanAndRecord brand-navigational deactivation (via runKeywordSweep)", () => {
  let deactivateCalls: string[][];

  // A high-review, old (low ratingsPerDay -> no newcomer traction), non-
  // title-matching-irrelevant fixture — `topAppReviews` this run computes
  // FROM THIS FETCH (not from the `getScanHistory` mock's own `topAppReviews`
  // field, which only feeds the brand-navigational check) lands well above
  // `DEACTIVATION_MAX_REVIEWS_CEILING` (1000), so the GENERAL deactivation
  // rule's reviews-ceiling branch returns false regardless of demand —
  // isolating these tests to ONLY the brand-navigational rule's own verdict.
  const highReviewSample = {
    results: [
      {
        trackId: 1,
        trackName: "Some Established App",
        userRatingCount: 5000,
        averageUserRating: 4.2,
        releaseDate: "2010-01-01T00:00:00Z",
      },
    ],
  };

  beforeEach(() => {
    deactivateCalls = [];
    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async () => ({ ok: true, json: async () => highReviewSample }),
    }));
    mock.module("./app-velocity-store", () => ({
      recordVelocityObservationsForScan: async () => ({ recorded: 0 }),
    }));
  });

  it("deactivates an autocomplete keyword whose last DEACTIVATION_MIN_SCANS scans were ALL brand-navigational", async () => {
    mock.module("./keyword-store", () => ({
      ...keywordStoreMockBase(),
      getStaleKeywordsTiered: async () => [
        { keyword: "brand-navigational-term", lane: "tier1" as const },
      ],
      getKeywordMeta: async () => ({ firstFoundAt: 0, source: "autocomplete" as const }),
      // Both of the two most recent scans (including the one this run just
      // persisted) are brand-navigational — the general rule's own reviews
      // ceiling does NOT fire here (see `highReviewSample`), but the
      // brand-navigational rule bypasses that ceiling entirely.
      getScanHistory: async () => [
        {
          store: "app",
          scannedAt: 1,
          demand: 5,
          topApps: [],
          topAppReviews: 5000,
          brandNavigational: true,
        },
        {
          store: "app",
          scannedAt: 2,
          demand: 5,
          topApps: [],
          topAppReviews: 5000,
          brandNavigational: true,
        },
      ],
      deactivateJunkKeywords: async (keywords: readonly string[]) => {
        deactivateCalls.push([...keywords]);
        return keywords.length;
      },
    }));

    const { runKeywordSweep } = await import("./keyword-gaps");
    await runKeywordSweep({ limit: 25, delayMs: 0 });

    expect(deactivateCalls).toEqual([["brand-navigational-term"]]);
  });

  it("does NOT deactivate when only ONE of the recent scans was brand-navigational", async () => {
    mock.module("./keyword-store", () => ({
      ...keywordStoreMockBase(),
      getStaleKeywordsTiered: async () => [{ keyword: "mixed-term", lane: "tier1" as const }],
      getKeywordMeta: async () => ({ firstFoundAt: 0, source: "autocomplete" as const }),
      getScanHistory: async () => [
        {
          store: "app",
          scannedAt: 1,
          demand: 5,
          topApps: [],
          topAppReviews: 5000,
          brandNavigational: false,
        },
        {
          store: "app",
          scannedAt: 2,
          demand: 5,
          topApps: [],
          topAppReviews: 5000,
          brandNavigational: true,
        },
      ],
      deactivateJunkKeywords: async (keywords: readonly string[]) => {
        deactivateCalls.push([...keywords]);
        return keywords.length;
      },
    }));

    const { runKeywordSweep } = await import("./keyword-gaps");
    await runKeywordSweep({ limit: 25, delayMs: 0 });

    expect(deactivateCalls).toEqual([]);
  });

  it("does NOT deactivate a seed keyword even when all recent scans are brand-navigational (protected source)", async () => {
    mock.module("./keyword-store", () => ({
      ...keywordStoreMockBase(),
      getStaleKeywordsTiered: async () => [{ keyword: "seed-brand-term", lane: "tier1" as const }],
      getKeywordMeta: async () => ({ firstFoundAt: 0, source: "seed" as const }),
      getScanHistory: async () => [
        {
          store: "app",
          scannedAt: 1,
          demand: 5,
          topApps: [],
          topAppReviews: 50_000,
          brandNavigational: true,
        },
        {
          store: "app",
          scannedAt: 2,
          demand: 5,
          topApps: [],
          topAppReviews: 50_000,
          brandNavigational: true,
        },
      ],
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
    const result = await runDeStorefrontSweep({ delayMs: 0, chunkSize: 150 });

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

  // Batch A budget rescue (2026-07-22): the chunk resume cursor.
  it("passes chunkSize through to getTier1ProtectedKeywords and marks last_de_scanned_at via markDeScanned", async () => {
    const protectedKeywordsCalls: number[] = [];
    const markDeScannedCalls: Array<readonly string[]> = [];

    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async () => ({ ok: true, json: async () => sample }),
    }));
    mock.module("./app-velocity-store", () => ({
      recordVelocityObservationsForScan: async () => ({ recorded: 0 }),
    }));
    mock.module("./keyword-store", () => ({
      ...keywordStoreMockBase(),
      getTier1ProtectedKeywords: async (limit: number) => {
        protectedKeywordsCalls.push(limit);
        return ["de-chunk-term"];
      },
      markDeScanned: async (keywords: readonly string[]) => {
        markDeScannedCalls.push(keywords);
      },
      getKeywordMeta: async () => ({ firstFoundAt: 0, source: "seed" as const }),
    }));

    const { runDeStorefrontSweep } = await import("./keyword-gaps");
    await runDeStorefrontSweep({ delayMs: 0, chunkSize: 37 });

    expect(protectedKeywordsCalls).toEqual([37]);
    expect(markDeScannedCalls).toEqual([["de-chunk-term"]]);
  });
});

// ---------------------------------------------------------------------------
// serp-rank Stage 1 (deep-scrape build): deep SERP fetch + rank persistence.
// `scanKeywordDeep` is tested directly with EXPLICIT `topN`/`depth` opts
// (never relying on `loadConfig()` defaults) so these tests stay correct
// regardless of the shared bun process's well-known cross-file config-mock
// leak (other `*.isolated.test.ts` files install their own, unrelated
// `../../config/loader` stubs at module-load time — see this repo's
// "Isolated lane mock leak" note; unaffected here since every value this
// describe block needs is passed explicitly).
// ---------------------------------------------------------------------------

describe("scanKeywordDeep — calibration guard (serp-rank Stage 1)", () => {
  const KEYWORD = "budget planner";
  // 30 fixture entries so a topN=20 fetch and a depth=200 fetch (mock
  // truncates to the SAME fixture, capped by its own length) diverge in
  // fetched size but must still produce an IDENTICAL scored profile.
  const FIXTURE_RESULTS = Array.from({ length: 30 }, (_, i) => ({
    trackId: i + 1,
    trackName: `App ${i + 1}`,
    userRatingCount: 1000 - i * 10,
    averageUserRating: 4.0,
    releaseDate: "2020-01-01T00:00:00Z",
  }));

  let requestedUrl = "";

  beforeEach(() => {
    requestedUrl = "";
    // Limit-aware, matching real iTunes behavior (the live endpoint DOES
    // truncate by `limit=`) — required for the byte-equal comparison test
    // below to be meaningful rather than trivially true.
    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async (url: string) => {
        requestedUrl = url;
        const match = /limit=(\d+)/.exec(url);
        const limit = match ? Number(match[1]) : FIXTURE_RESULTS.length;
        return { ok: true, json: async () => ({ results: FIXTURE_RESULTS.slice(0, limit) }) };
      },
    }));
    mock.module("./keyword-store", () => keywordStoreMockBase());
  });

  it("fetches at the given depth (not topN) but scores/returns only the top-N slice", async () => {
    const { scanKeywordDeep } = await import("./keyword-gaps");
    const { profile, rankedSerp } = await scanKeywordDeep(KEYWORD, { topN: 20, depth: 200 });

    expect(requestedUrl).toContain("limit=200");
    expect(profile.topApps.length).toBe(20);
    // Fixture only has 30 entries (< depth 200) — the mock returns all of them.
    expect(rankedSerp.length).toBe(30);
    // Beyond-topN entries persist as the compact tail, not in `topApps`.
    expect(profile.serpTail?.length).toBe(10);
    expect(profile.serpTail?.[0]).toEqual({ id: "21", rank: 20 });
  });

  it("under kill-switch depth=topN (20), fetches only 20 and has no tail", async () => {
    const { scanKeywordDeep } = await import("./keyword-gaps");
    const { profile, rankedSerp } = await scanKeywordDeep(KEYWORD, { topN: 20, depth: 20 });

    expect(requestedUrl).toContain("limit=20");
    expect(profile.topApps.length).toBe(20);
    expect(rankedSerp.length).toBe(20);
    expect(profile.serpTail).toBeUndefined();
  });

  it("produces a scoring-identical profile to a plain scanKeyword(topN=20) call on the same live results", async () => {
    const { scanKeyword, scanKeywordDeep } = await import("./keyword-gaps");
    const shallow = await scanKeyword(KEYWORD, { topN: 20 });
    const { profile: deep } = await scanKeywordDeep(KEYWORD, { topN: 20, depth: 200 });

    expect(deep.competitiveness).toBe(shallow.competitiveness);
    expect(deep.demand).toBe(shallow.demand);
    expect(deep.incumbentWeakness).toBe(shallow.incumbentWeakness);
    expect(deep.opportunity).toBe(shallow.opportunity);
    expect(deep.trend).toBe(shallow.trend);
    expect(deep.lowConfidence).toBe(shallow.lowConfidence);
    expect(deep.topApps).toEqual(shallow.topApps);
  });
});

describe("runKeywordSweep — deep-scan lane wiring (serp-rank Stage 1)", () => {
  // A COMPLETE, schema-derived config (`opencrowConfigSchema.parse`, never a
  // hand-rolled partial object) — every field `runKeywordSweep`/
  // `scanAndRecord` reads is guaranteed present regardless of schema drift,
  // and the mock is (re-)installed in `beforeEach` (execution phase) so it
  // wins over any OTHER file's module-load-time config/loader stub still
  // active in the shared bun process (see this block's module doc comment).
  function mockConfig(overrides: {
    readonly legacyRateOverride?: boolean;
    readonly deepScanMined?: boolean;
  }): void {
    mock.module("../../config/loader", () => ({
      loadConfig: () =>
        opencrowConfigSchema.parse({
          appstoreKeywordGap: {
            deepScanMined: overrides.deepScanMined ?? false,
            sweepRateSafety: {
              legacyRateOverride: overrides.legacyRateOverride ?? false,
            },
          },
        }),
    }));
  }

  let fetchedUrls: string[];

  function mockLimitAwareFetch(): void {
    fetchedUrls = [];
    mock.module("../shared/ssrf-safe-fetch", () => ({
      RateLimitError,
      ssrfSafeFetch: async (url: string) => {
        fetchedUrls.push(url);
        return { ok: true, json: async () => sample };
      },
    }));
  }

  beforeEach(() => {
    mockLimitAwareFetch();
    mock.module("./app-velocity-store", () => ({
      recordVelocityObservationsForScan: async () => ({ recorded: 0 }),
    }));
    mock.module("./keyword-store", () => ({
      ...keywordStoreMockBase(),
      getStaleKeywordsTiered: async () => [
        { keyword: "hot-kw", lane: "hot" as const },
        { keyword: "tier1-kw", lane: "tier1" as const },
        { keyword: "mined-kw", lane: "mined" as const },
      ],
    }));
  });

  it("deep-scans hot/tier1 lanes (limit=200) but keeps the mined lane shallow (limit=20) by default", async () => {
    mockConfig({});
    const { runKeywordSweep } = await import("./keyword-gaps");
    await runKeywordSweep({ limit: 25, delayMs: 0 });

    expect(fetchedUrls.length).toBe(3);
    expect(fetchedUrls[0]).toContain("limit=200"); // hot
    expect(fetchedUrls[1]).toContain("limit=200"); // tier1
    expect(fetchedUrls[2]).toContain("limit=20"); // mined, shallow
  });

  it("legacyRateOverride forces EVERY lane back to limit=20, even hot/tier1", async () => {
    mockConfig({ legacyRateOverride: true });
    const { runKeywordSweep } = await import("./keyword-gaps");
    await runKeywordSweep({ limit: 25, delayMs: 0 });

    expect(fetchedUrls.length).toBe(3);
    for (const url of fetchedUrls) {
      expect(url).toContain("limit=20");
    }
  });

  it("deepScanMined opts the mined lane into a deep (limit=200) fetch too", async () => {
    mockConfig({ deepScanMined: true });
    const { runKeywordSweep } = await import("./keyword-gaps");
    await runKeywordSweep({ limit: 25, delayMs: 0 });

    expect(fetchedUrls.length).toBe(3);
    for (const url of fetchedUrls) {
      expect(url).toContain("limit=200");
    }
  });
});
