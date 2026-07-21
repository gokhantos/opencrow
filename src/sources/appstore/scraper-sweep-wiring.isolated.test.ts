import { describe, expect, it, mock, afterEach } from "bun:test";
// Real (unmocked) import, resolved at file-load time BEFORE any
// `mock.module` call runs — captures the REAL pure-function exports of
// "./keyword-miner" so the mock below can spread them verbatim rather than
// hand-rolling (and risking silently drifting from) identity/passthrough
// stand-ins. Only `mineKeywords` needs an actual override (to count calls);
// everything else this module exports should behave exactly as production
// code does, for any OTHER suite sharing this bun process whose transitive
// imports might resolve through this mock (see the "isolated lane mock
// leak" convention elsewhere in this directory).
import * as RealKeywordMiner from "./keyword-miner";

// This suite reproduces the PR #326 "deep scrape" production incident:
// appstore_app_meta enrichment, review harvests, app-page HTML enrichment,
// and international storefront charts never fired in production, ~14h+
// post-deploy, despite all four lanes being `enabled: true` by schema
// default with no DB/env override in effect (verified live). The four
// PRE-EXISTING lanes on the same `keywordSweepTick` (the keyword sweep
// itself, the newborn-velocity screener, autocomplete expansion, and the DE
// storefront sweep) all fired correctly in production over the same window.
//
// `createAppStoreScraper` wires ALL eight lanes onto ONE `keywordSweepTick`
// (`src/sources/appstore/scraper.ts`), each gated by its own "IfDue"
// wrapper. This test drives the real `scraper.ts` module (everything it
// imports is mocked — no network, no DB) and asserts that every wrapper's
// underlying pass function is actually invoked on the very first tick after
// `start()`, which is what the process-local `lastXRunAt = 0` cadence
// trackers are supposed to guarantee (elapsed-since-epoch is always >> any
// `minIntervalMs`, so nothing should gate the first-ever call of a fresh
// process).
//
// Mocks every module `scraper.ts` imports with I/O (network/DB); leaves
// pure-logic modules (`sweep-throttle`, `review-rss`, `charts`,
// `error-serialization`) real per the isolated-test convention used
// elsewhere in this directory (see review-harvester.isolated.test.ts /
// app-pages.isolated.test.ts's own scope notes).

interface CallLog {
  runKeywordSweep: number;
  runDeStorefrontSweep: number;
  runScreener: number;
  expandCorpus: number;
  mineKeywords: number;
  backfillMinedDeactivation: number;
  runRegistryBackfillOnce: number;
  runEnrichmentPass: number;
  runPortfolioPass: number;
  runIntlChartsSweep: number;
  harvestDueApps: number;
  runCohortRefresh: number;
  runAppPageFetchPass: number;
  runAppPageSyncPass: number;
}

function freshCallLog(): CallLog {
  return {
    runKeywordSweep: 0,
    runDeStorefrontSweep: 0,
    runScreener: 0,
    expandCorpus: 0,
    mineKeywords: 0,
    backfillMinedDeactivation: 0,
    runRegistryBackfillOnce: 0,
    runEnrichmentPass: 0,
    runPortfolioPass: 0,
    runIntlChartsSweep: 0,
    harvestDueApps: 0,
    runCohortRefresh: 0,
    runAppPageFetchPass: 0,
    runAppPageSyncPass: 0,
  };
}

let calls: CallLog;

/**
 * Full `OpenCrowConfig`-shaped appstore config subtree, matching PRODUCTION
 * schema defaults (`src/config/schema.ts`) with every `minIntervalMs` /
 * `minRunIntervalMs` zeroed so due-checks never gate this test on wall-clock
 * time — the point is to prove the FIRST call fires, not to test cadence
 * math (that's covered elsewhere). `enabled: true` everywhere, matching the
 * live resolved config verified against the deployed process.
 */
function fakeAppstoreConfig() {
  return {
    appstoreKeywordGap: {
      enabled: true,
      scanIntervalMs: 3_600_000, // large: this test drives ONE explicit tick, not the timer
      sweepDelayMs: 100,
      dailyKeywordBudget: 60_000,
      keywordsPerSweep: 75,
      tier1StaleThresholdMs: 43_200_000,
      topN: 20,
      demandWeight: 1,
      opportunityThresholdForSeed: 0.15,
      corpusDiscovery: {
        enabled: true,
        maxMinedPerCycle: 100,
        // Batch C4: default OFF, so `runReviewHarvestIfDue`'s reviewMining
        // sub-pass never actually fires this suite — but the field must
        // exist or `reviewMiningCfg.enabled` throws (this mock hand-rolls
        // the config shape rather than deriving it from the real schema —
        // see keyword-gaps.isolated.test.ts for the alternative pattern).
        reviewMining: {
          enabled: false,
          minIntervalMs: 6 * 60 * 60 * 1000,
          reviewScanLimit: 5000,
          lookbackMs: 30 * 24 * 60 * 60 * 1000,
          maxNewPerCycle: 50,
        },
      },
      autocompleteExpansion: {
        enabled: true,
        minIntervalMs: 0,
        winnerLimit: 10,
        diverseLimit: 10,
        perSeed: 5,
        storefront: "us",
        delayMs: 0,
        prefixFanOut: { enabled: true, maxPrefixesPerSeed: 5 },
      },
      deStorefrontLane: { enabled: true, minIntervalMs: 0, delayMs: 0 },
      sweepRateSafety: { legacyRateOverride: false, adaptiveThrottleEnabled: true },
    },
    appstoreJunkDeactivation: { enabled: true, minedBackfillEnabled: true },
    appstoreSignatureScreener: { enabled: true, minRunIntervalMs: 0 },
    appstoreSync: {
      perCategoryLimit: 200,
      listTypes: ["top-free"],
      globalLimit: 100,
      intlCharts: {
        enabled: true,
        storefronts: ["gb"],
        minIntervalMs: 0,
        listTypes: ["top-free"],
        delayMs: 0,
      },
    },
    appstoreAppEnrichment: {
      enabled: true,
      minIntervalMs: 0,
      batchSize: 200,
      maxBatchesPerPass: 4,
      staleAfterMs: 2_592_000_000,
      acceleratingLimit: 50,
      delistMissThreshold: 1,
      dailyRequestBudget: 1_200,
      portfolio: {
        enabled: true,
        minIntervalMs: 0,
        developerLimit: 2,
        portfolioLimit: 200,
        minRescanIntervalMs: 2_592_000_000,
      },
      ledgerPrune: { maxAgeMs: 604_800_000, minIntervalMs: 86_400_000 },
    },
    appstoreReviewHarvest: {
      enabled: true,
      minIntervalMs: 0,
      appsPerTick: 3,
      storefront: "us",
      pageDelayMs: 0,
      maxConsecutiveEmptyHarvests: 5,
      memoryIndexing: "all",
      dailyRequestBudget: 10_000,
      cohortRefresh: {
        enabled: true,
        minIntervalMs: 0,
        signatureHitCap: 100,
        velocityCap: 50,
        chartNewbornCap: 200,
      },
      ledgerPrune: { maxAgeMs: 604_800_000, minIntervalMs: 86_400_000 },
    },
    appstoreAppPages: {
      enabled: true,
      minIntervalMs: 0,
      pagesPerBatch: 10,
      storefront: "us",
      requestDelayMs: 0,
      dailyPageBudget: 3_000,
      hotIntervalMs: 86_400_000,
      rollingIntervalMs: 1_209_600_000,
      sync: {
        enabled: true,
        minIntervalMs: 0,
        hotSignatureHitCap: 100,
        hotVelocityCap: 50,
        rollingAddPerSync: 500,
      },
      canary: { minBatchSize: 10, parseFailureThreshold: 0.5 },
    },
  };
}

function setUpMocks(): void {
  calls = freshCallLog();

  mock.module("../../config/loader", () => ({
    loadConfig: () => fakeAppstoreConfig(),
    loadConfigWithOverrides: async () => fakeAppstoreConfig(),
  }));

  mock.module("./keyword-gaps", () => ({
    runKeywordSweep: async () => {
      calls.runKeywordSweep++;
      return { scanned: 0, failed: 0, rateLimitErrors: 0, skipped: false, mineQuotaRemaining: 0 };
    },
    runDeStorefrontSweep: async () => {
      calls.runDeStorefrontSweep++;
      return { scanned: 0, failed: 0, bailed: false, rateLimitErrors: 0 };
    },
  }));

  mock.module("./keyword-screener", () => ({
    runScreener: async () => {
      calls.runScreener++;
      return { evaluated: 0, hits: 0, newHits: 0, newHitKeywords: [] };
    },
  }));

  mock.module("./keyword-autocomplete", () => ({
    expandCorpus: async () => {
      calls.expandCorpus++;
      return {
        added: 0,
        seedsUsed: 0,
        attempted: 0,
        rateLimitErrors: 0,
        brandFiltered: 0,
        rawTermCount: 0,
      };
    },
  }));

  mock.module("./keyword-miner", () => ({
    // Spread every REAL export first (see the `RealKeywordMiner` import's
    // doc comment) — `keyword-review-miner.ts` (imported transitively via
    // real `scraper.ts`, never invoked this suite since reviewMining
    // defaults OFF) needs `DEFAULT_ZONE`/`mapCategoryToZone`/`normalizeText`/
    // `tokenize`/`filterJunkTokens`/`filterStopwords` to exist with their
    // TRUE semantics, not an identity stand-in, in case this mock ever
    // leaks into another suite sharing this process.
    ...RealKeywordMiner,
    // Only override `mineKeywords` — the one export THIS suite needs to
    // intercept, to count calls without hitting the DB.
    mineKeywords: async () => {
      calls.mineKeywords++;
      return { added: 0, scannedFromRankings: 0, scannedFromTopApps: 0 };
    },
  }));

  mock.module("./keyword-store", () => ({
    backfillMinedDeactivation: async () => {
      calls.backfillMinedDeactivation++;
      return 0;
    },
    countScansSince: async () => 0,
    // Batch C4: `./keyword-review-miner` (imported by scraper.ts, real/
    // unmocked here — reviewMining defaults OFF so it's never actually
    // invoked this suite) itself imports these from "./keyword-store" — must
    // be present or the transitive import throws a missing-named-export ESM
    // SyntaxError, per this file's own module-mocking convention.
    keywordsExist: async () => new Set<string>(),
    upsertKeywords: async (rows: readonly unknown[]) => rows.length,
    // The REAL "./keyword-miner" (spread into the mock below, so its
    // `mineKeywords`/pure-helper exports behave with true semantics) itself
    // imports `getScannedAppNames` from "./keyword-store" too.
    getScannedAppNames: async () => [],
    // Batch D item D1: the autocomplete-hints ledger prune lane
    // (`runAutocompleteExpansionIfDue`'s trailing prune call) fires on the
    // very first tick (process-local cadence tracker starts at 0) — must be
    // present or that call throws (caught/swallowed, but keep it real so the
    // lane behaves as production does for any suite sharing this process).
    pruneAutocompleteHints: async () => 0,
  }));

  mock.module("./app-enrichment", () => ({
    runEnrichmentPass: async () => {
      calls.runEnrichmentPass++;
      return {
        skipped: false,
        enrichedCount: 0,
        missCount: 0,
        delistedCount: 0,
        relistedCount: 0,
        chartNewbornVelocityCount: 0,
        attempted: 0,
        rateLimitErrors: 0,
        bailed: false,
      };
    },
    runPortfolioPass: async () => {
      calls.runPortfolioPass++;
      return { developersScanned: 0, newSightings: 0, attempted: 0, rateLimitErrors: 0, bailed: false };
    },
    runRegistryBackfillOnce: async () => {
      calls.runRegistryBackfillOnce++;
      return { inserted: 0 };
    },
    runLookupLedgerPrune: async () => ({ pruned: 0 }),
    computeEffectiveMaxBatches: (maxBatchesPerPass: number) => maxBatchesPerPass,
  }));

  mock.module("./app-meta-store", () => ({
    recordAppSightings: async () => undefined,
    // Batch C4: see the "./keyword-store" mock's comment above — same
    // transitive-import reasoning, this time for `./keyword-review-miner`'s
    // `getAppMetaBatch` import.
    getAppMetaBatch: async () => new Map(),
  }));

  mock.module("./charts-intl", () => ({
    runIntlChartsSweep: async () => {
      calls.runIntlChartsSweep++;
      return { scanned: 0, failed: 0, bailed: false, rateLimitErrors: 0, sightingsRecorded: 0 };
    },
  }));

  mock.module("./review-harvester", () => ({
    computeEffectiveAppsPerTick: (appsPerTick: number) => appsPerTick,
    harvestDueApps: async () => {
      calls.harvestDueApps++;
      return {
        skipped: false,
        appsHarvested: 0,
        pagesFetched: 0,
        reviewsFound: 0,
        newReviews: 0,
        deactivated: 0,
        attempted: 0,
        rateLimitErrors: 0,
        bailed: false,
      };
    },
    runCohortRefresh: async () => {
      calls.runCohortRefresh++;
      return { enrolled: 0, refreshed: 0 };
    },
    runReviewHarvestLedgerPrune: async () => ({ pruned: 0 }),
  }));

  mock.module("./app-pages", () => ({
    runAppPageFetchPass: async () => {
      calls.runAppPageFetchPass++;
      return {
        skipped: false,
        attempted: 0,
        succeeded: 0,
        gone: 0,
        failed: 0,
        parseFailed: 0,
        rateLimitErrors: 0,
        bailed: false,
        canaryTripped: false,
      };
    },
    runAppPageSyncPass: async () => {
      calls.runAppPageSyncPass++;
      return { hotEnrolled: 0, rollingEnrolled: 0 };
    },
  }));

  mock.module("./store", () => ({
    upsertRankings: async () => ({ upserted: 0 }),
    upsertReviews: async () => ({ upserted: 0, newIds: [] }),
    getRankings: async () => [],
    getDiscoveredAppIds: async () => [],
    getUnindexedReviews: async () => [],
    markReviewsIndexed: async () => undefined,
    getUnindexedRankings: async () => [],
    markRankingsIndexed: async () => undefined,
    // Batch C4: see the "./keyword-store" mock's comment above — same
    // transitive-import reasoning, this time for `./keyword-review-miner`'s
    // `getRecentComplaintReviews` import.
    getRecentComplaintReviews: async () => [],
  }));

  mock.module("../scraper-config", () => ({
    loadScraperIntervalMs: async () => 3_600_000,
  }));

  mock.module("../shared/fetch-with-timeout", () => ({
    fetchWithTimeout: async () => ({ ok: false, status: 599, json: async () => ({}) }),
  }));
}

describe("appstore scraper.ts — keywordSweepTick lane wiring", () => {
  afterEach(() => {
    mock.restore();
  });

  it("invokes every deep-scrape lane's pass function on the first tick after start()", async () => {
    setUpMocks();

    const { createAppStoreScraper } = await import("./scraper");
    const scraper = createAppStoreScraper({});

    try {
      scraper.start();

      // keywordSweepTick() is fired synchronously (fire-and-forget) inside
      // start(); give its sequential await chain time to settle. All mocked
      // I/O resolves near-instantly, so this margin is generous, not tuned.
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Pre-existing lanes (shipped before PR #326) — sanity check that the
      // harness itself is wired correctly and these still fire, matching
      // verified production behavior.
      expect(calls.runKeywordSweep).toBeGreaterThan(0);
      expect(calls.runScreener).toBeGreaterThan(0);
      expect(calls.expandCorpus).toBeGreaterThan(0);
      expect(calls.runDeStorefrontSweep).toBeGreaterThan(0);
      expect(calls.backfillMinedDeactivation).toBeGreaterThan(0);

      // The four PR #326 deep-scrape lanes — THIS is the regression this
      // test guards. In production these never fired even once in 14h+
      // across 18 process restarts, despite `enabled: true` everywhere.
      expect(calls.runIntlChartsSweep).toBeGreaterThan(0);
      expect(calls.runRegistryBackfillOnce).toBeGreaterThan(0);
      expect(calls.runEnrichmentPass).toBeGreaterThan(0);
      expect(calls.harvestDueApps).toBeGreaterThan(0);
      expect(calls.runCohortRefresh).toBeGreaterThan(0);
      expect(calls.runAppPageFetchPass).toBeGreaterThan(0);
      expect(calls.runAppPageSyncPass).toBeGreaterThan(0);
    } finally {
      scraper.stop();
    }
  });
});
