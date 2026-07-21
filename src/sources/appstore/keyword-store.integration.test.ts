import { describe, expect, it, beforeAll, afterAll, afterEach } from "bun:test";
import { initDb, getDb } from "../../store/db";
import { computeBuildability } from "./keyword-scoring";
import {
  upsertKeywords,
  getStaleKeywords,
  getStaleKeywordsAcrossZones,
  getStaleKeywordsTiered,
  markScanned,
  insertScan,
  getLatestScan,
  getTopOpportunities,
  getScanHistory,
  getMostRecentScanAt,
  countScansSince,
  countMinedScansSince,
  getWinnerKeywords,
  keywordsExist,
  getDiverseZoneSample,
  getExpansionSeeds,
  getKeywordMeta,
  getScannedAppNames,
  deactivateJunkKeywords,
  getMinedDeactivationStats,
  backfillMinedDeactivation,
  getTier1ProtectedKeywords,
  markDeScanned,
  markSeedsExpanded,
  insertAutocompleteHints,
  pruneKeywordScans,
  getHintEvidence,
  pruneAutocompleteHints,
} from "./keyword-store";
import type { KeywordGapProfile, TopApp } from "./keyword-types";
import type { SeedRotationUpdate, TieredKeyword } from "./keyword-store";
import { upsertPopularity } from "./popularity-store";

/**
 * Batch C1+C2 (migration 051): `markSeedsExpanded` now takes per-seed
 * `{keyword, storefront, nextPrefixOffset}` updates rather than a bare
 * keyword list. Every pre-Batch-C rotation test below only cares about
 * `last_expanded_at` ordering (not the prefix-offset cursor itself — that
 * gets its own dedicated coverage further down), so this helper defaults
 * every update to the US storefront and offset 0, keeping those tests
 * unchanged in intent.
 */
function rotationUpdates(
  keywords: readonly string[],
  storefront: string = "us",
): readonly SeedRotationUpdate[] {
  return keywords.map((keyword) => ({ keyword, storefront, nextPrefixOffset: 0 }));
}

/**
 * `getStaleKeywordsTiered` now returns lane-tagged rows (serp-rank Stage 1,
 * deep-scrape build — see `keyword-store.ts`'s `TieredKeyword`). Every test
 * below predates that change and asserts against plain keyword strings —
 * this adapter keeps every existing `.toContain`/`.indexOf`/`.filter`
 * assertion working unchanged by projecting straight back to `string[]`
 * immediately after the call; lane itself is NOT under test here (that's
 * covered by the dedicated deep-scan tests in `keyword-gaps.isolated.test.ts`).
 */
function keywordsOf(rows: readonly TieredKeyword[]): readonly string[] {
  return rows.map((r) => r.keyword);
}

/**
 * Every keyword any test in this file inserts. Centralized so cleanup can
 * always target a fixed, known set — keeps repeated `bun run test:integration`
 * runs from leaking rows into getStaleKeywords/getTopOpportunities. Deleting a
 * keyword a prior (crashed) run left behind is a safe no-op.
 */
const TEST_KEYWORDS: readonly string[] = [
  "zzz-fatty-liver-diet",
  "zzz-gap-test",
  "zzz-gap-filter-genre-match",
  "zzz-gap-filter-genre-decoy",
  "zzz-gap-filter-trend-match",
  "zzz-gap-filter-trend-decoy",
  "zzz-gap-filter-combo-match",
  "zzz-gap-filter-combo-decoy-trend",
  "zzz-gap-filter-combo-decoy-genre",
  "zzz-gap-history",
  "zzz-most-recent-scan-a",
  "zzz-most-recent-scan-b",
  "zzz-winner-high",
  "zzz-winner-low",
  "zzz-exist-check-present",
  "zzz-cross-zone-stale-a",
  "zzz-cross-zone-stale-b",
  "zzz-count-scans-since",
  "zzz-diverse-zone-a-stale",
  "zzz-diverse-zone-a-fresh",
  "zzz-diverse-zone-b-stale",
  "zzz-diverse-zone-b-fresh",
  "zzz-expansion-winner",
  "zzz-expansion-diverse",
  "zzz-gap-meta-fields",
  "zzz-keyword-meta",
  "zzz-peak-rank-old-glory",
  "zzz-peak-rank-steady",
  "zzz-page-test-a",
  "zzz-page-test-b",
  "zzz-page-test-c",
  "zzz-scanned-app-names-fixture",
  "zzz-sort-num-a",
  "zzz-sort-num-b",
  "zzz-sort-num-c",
  "zzz-sort-text-alpha",
  "zzz-sort-text-bravo",
  "zzz-sort-text-charlie",
  "zzz-sort-default-a",
  "zzz-sort-default-b",
  "zzz-filter-demand-high",
  "zzz-filter-demand-low",
  "zzz-filter-comp-low",
  "zzz-filter-comp-high",
  "zzz-filter-iw-high",
  "zzz-filter-iw-low",
  "zzz-filter-opp-high",
  "zzz-filter-opp-low",
  // Literal single-word junk-stoplist / short / numeric keywords — verified
  // absent from the real corpus before adding here (see the design doc's
  // hideJunk test notes): these specific tokens ("hd", "42", "q9") are
  // structurally un-minable by keyword-miner.ts (STOPWORDS drops "the"/"and"/
  // "for"; MIN_TOKEN_LENGTH=3 drops 1-2 char tokens like "hd"/"42"/"q9"), so
  // they can never be produced by the live scraping pipeline and are safe to
  // insert/delete here without risking real corpus/scan data.
  "hd",
  "42",
  "q9",
  "zzz-junk-keep-budget-hd-planner",
  "zzz-legit-buildable-keyword",
  "zzz-sweet-spot-match",
  "zzz-sweet-spot-decoy-demand",
  "zzz-sweet-spot-decoy-comp",
  "zzz-sweet-spot-decoy-iw",
  "zzz-build-drift-high",
  "zzz-build-drift-zero",
  "zzz-build-sort-a",
  "zzz-build-sort-b",
  "zzz-build-sort-c",
  "zzz-build-filter-high",
  "zzz-build-filter-low",
  // getStaleKeywordsTiered fixtures
  "zzz-tier1-manual-stale",
  "zzz-tier1-manual-fresh",
  "zzz-tier1-seed-never-scanned",
  "zzz-tier1-autocomplete-stale",
  "zzz-tier1-signature-hit",
  "zzz-tier2-mined-stale",
  "zzz-tier1-cap-manual-a",
  "zzz-tier1-cap-manual-b",
  "zzz-tier1-cap-manual-c",
  "zzz-mine-quota-a",
  "zzz-mine-quota-b",
  "zzz-mine-quota-c",
  // perSweepCap fixtures (2026-07-21 audit item A)
  "zzz-per-sweep-cap-a",
  "zzz-per-sweep-cap-b",
  "zzz-per-sweep-cap-c",
  // Hot lane fixtures (2026-07-21 audit item A)
  "zzz-hot-lane-open-hit",
  "zzz-hot-lane-tier1-decoy",
  "zzz-hot-lane-mined-decoy",
  // Self-supplied mined-exploration "stale competition" decoys for the
  // fresh-manual-keyword exclusion test — see that test's comment (PR #321
  // CI failure) for why these must exist regardless of ambient corpus size.
  ...Array.from({ length: 10 }, (_, i) => `zzz-tier1-fresh-decoy-${i}`),
  // deactivateJunkKeywords fixtures
  "zzz-deactivate-mined",
  "zzz-deactivate-manual-protected",
  "zzz-deactivate-seed-protected",
  "zzz-deactivate-already-inactive",
  // countMinedScansSince / getMinedDeactivationStats / backfillMinedDeactivation
  // / getTier1ProtectedKeywords fixtures (2026-07-21 scan-budget retune)
  "zzz-mined-scan-count-mined",
  "zzz-mined-scan-count-seed",
  "zzz-mined-stats-fixture",
  "zzz-backfill-mined-hopeless",
  "zzz-backfill-mined-sighit",
  "zzz-backfill-manual-protected",
  "zzz-backfill-idempotent",
  "zzz-de-lane-seed",
  "zzz-de-lane-manual",
  "zzz-de-lane-autocomplete",
  "zzz-de-lane-mined-excluded",
  "zzz-de-lane-inactive",
  // DE storefront quarantine fixtures (2026-07-21 audit item B)
  "zzz-de-quarantine-keyword",
  // Seed rotation fixtures (2026-07-21 audit item D)
  "zzz-rotate-winner-a",
  "zzz-rotate-winner-b",
  "zzz-rotate-winner-c",
  "zzz-rotate-winner-d",
  "zzz-rotate-diverse-a",
  "zzz-rotate-diverse-b",
  // Throughput wave item 3 (GB hints lane storefront column) fixtures
  "zzz-rotate-gb-seed",
  "zzz-rotate-default-storefront",
  // Batch A budget rescue (2026-07-22) fixtures
  ...Array.from({ length: 5 }, (_, i) => `zzz-tier1-ac-cap-${i}`),
  "zzz-tier1-ac-cap-manual-decoy",
  "zzz-tier1-ac-cap-seed-decoy",
  "zzz-tier1-ac-cap-autocomplete",
  ...Array.from({ length: 5 }, (_, i) => `zzz-de-chunk-limit-${i}`),
  "zzz-de-cursor-old",
  "zzz-de-cursor-never",
  "zzz-de-cursor-stale",
  "zzz-de-cursor-fresh",
  "zzz-mark-de-scanned",
  "zzz-brand-nav-excluded",
  "zzz-brand-nav-kept",
  // pruneKeywordScans retention fixtures (B3, 2026-07-22)
  "zzz-prune-age-guarded",
  "zzz-prune-age-over-cap",
  "zzz-prune-recent-untouched",
  // Batch D item D1 (getHintEvidence / pruneAutocompleteHints) fixtures —
  // these are `seed` values in appstore_autocomplete_hints, not corpus
  // keywords, but cleanupTestKeywords' hints DELETE filters on `seed IN`
  // this same list.
  "zzz-hint-seed-a",
  "zzz-hint-seed-b",
  "zzz-hint-seed-c",
  "zzz-hint-coverage-seed",
  "zzz-hint-stale-seed",
  "zzz-hint-prune-old",
  "zzz-hint-prune-new",
  // Batch D item D3 (DE store-scoping) fixtures
  "zzz-d3-peak-de-shadow",
  // ASA popularity LEFT JOIN LATERAL fixtures (batch E)
  "zzz-asa-pop-probed",
  "zzz-asa-pop-unprobed",
];

async function cleanupTestKeywords(): Promise<void> {
  const db = getDb();
  await db`DELETE FROM appstore_seed_expansion_state WHERE keyword IN ${db(TEST_KEYWORDS)}`;
  await db`DELETE FROM appstore_autocomplete_hints WHERE seed IN ${db(TEST_KEYWORDS)}`;
  await db`DELETE FROM appstore_signature_hits WHERE keyword IN ${db(TEST_KEYWORDS)}`;
  await db`DELETE FROM appstore_search_popularity WHERE keyword IN ${db(TEST_KEYWORDS)}`;
  await db`DELETE FROM appstore_keyword_scans WHERE keyword IN ${db(TEST_KEYWORDS)}`;
  await db`DELETE FROM appstore_keywords WHERE keyword IN ${db(TEST_KEYWORDS)}`;
}

// Shared fixture threshold for `getStaleKeywordsTiered` call sites below —
// an explicit, self-contained value (no longer tracking the production
// config default, which moved to 6h in the 2026-07-21 capacity-raise
// escalation — see `tier1StaleThresholdMs` in src/config/schema.ts); a
// large perSweepCap so pre-existing tests that pass a big
// `mineQuotaRemaining` aren't incidentally re-capped by the per-sweep slice,
// unless a test is specifically exercising that cap.
const TIER1_STALE_THRESHOLD_MS = 12 * 60 * 60 * 1000;
const UNLIMITED_PER_SWEEP_CAP = 1_000_000;
// Batch A budget rescue (2026-07-22): a generous cap so pre-existing tests
// that aren't specifically exercising the autocomplete structural guard
// aren't incidentally bounded by it.
const UNLIMITED_TIER1_AUTOCOMPLETE_CAP = 1_000_000;

function makeTopApp(overrides: Partial<TopApp> = {}): TopApp {
  return {
    id: "1",
    name: "Toy",
    reviews: 11,
    rating: 3.4,
    ageDays: 500,
    ratingsPerDay: 0.02,
    titleMatch: true,
    lastUpdatedDays: 400,
    price: 0,
    formattedPrice: "Free",
    recentVelocity: 1.5,
    ...overrides,
  };
}

function makeScan(overrides: Partial<KeywordGapProfile> & { keyword: string }): KeywordGapProfile {
  const now = Math.floor(Date.now() / 1000);
  return {
    store: "app",
    competitiveness: 20,
    demand: 13,
    incumbentWeakness: 0.8,
    opportunity: 0.53,
    trend: "heating",
    topAppReviews: 11,
    avgRating: 3.4,
    avgAgeDays: 500,
    topApps: [makeTopApp()],
    scannedAt: now,
    lowConfidence: false,
    brandNavigational: false,
    ...overrides,
  };
}

describe("keyword-store", () => {
  beforeAll(async () => {
    await initDb(process.env.DATABASE_URL);
    // Pre-clean in case a previous crashed run left rows behind.
    await cleanupTestKeywords();
  });

  afterEach(async () => {
    await cleanupTestKeywords();
  });

  afterAll(async () => {
    await cleanupTestKeywords();
  });

  it("upserts corpus and reads a stale slice", async () => {
    // Dedicated zzz-prefixed genre zone (matching the convention used by the
    // other tests in this file) so this assertion is not affected by the
    // real seed corpus (scripts/seed-appstore-keywords.ts) that may already
    // be loaded into the shared "health" zone with no scan history — a
    // shared real zone plus an unqualified ORDER BY last_scanned_at ASC
    // NULLS FIRST / LIMIT 10 makes membership in the top slice non-deterministic.
    await upsertKeywords([
      { keyword: "zzz-fatty-liver-diet", genreZone: "zzz-stale-slice-zone", source: "seed" },
    ]);
    const stale = await getStaleKeywords("zzz-stale-slice-zone", 10);
    expect(stale).toContain("zzz-fatty-liver-diet");
  });

  describe("getStaleKeywordsAcrossZones", () => {
    it("orders the stalest-scanned keywords first regardless of genre zone", async () => {
      const now = Math.floor(Date.now() / 1000);
      await upsertKeywords([
        { keyword: "zzz-cross-zone-stale-a", genreZone: "finance", source: "seed" },
        { keyword: "zzz-cross-zone-stale-b", genreZone: "productivity", source: "seed" },
      ]);
      // Scanned far in the past (not just "a bit ago") so both rows sort at
      // the very FRONT of the stalest-first ordering regardless of how large
      // the real corpus has grown — a small `LIMIT` reaches them reliably
      // instead of depending on a limit constant staying ahead of live
      // corpus growth (this previously used `LIMIT 100_000` on `now - 500`/
      // `now - 100`, which broke once the real corpus passed 100k active
      // keywords — see the PR notes).
      const ancientA = now - 100_000_000;
      const ancientB = now - 99_999_000; // still ancient, but later than A
      await markScanned(["zzz-cross-zone-stale-a"], ancientA);
      await markScanned(["zzz-cross-zone-stale-b"], ancientB);

      // `NULLS FIRST` sorts never-scanned keywords ahead of even an ancient
      // real timestamp, so the limit must clear that never-scanned count
      // (a live, moving number on this shared DB) with margin — 1000 is
      // comfortably larger than any realistic never-scanned backlog while
      // staying far below the corpus-growth threshold that broke the old
      // `LIMIT 100_000` version of this test.
      const stale = await getStaleKeywordsAcrossZones(1000);
      const idxA = stale.indexOf("zzz-cross-zone-stale-a");
      const idxB = stale.indexOf("zzz-cross-zone-stale-b");
      expect(idxA).toBeGreaterThanOrEqual(0);
      expect(idxB).toBeGreaterThanOrEqual(0);
      expect(idxA).toBeLessThan(idxB);
    });
  });

  it("persists a scan and reads it back as latest + top opportunity, round-tripping topApps", async () => {
    const now = Math.floor(Date.now() / 1000);
    await upsertKeywords([{ keyword: "zzz-gap-test", genreZone: "health", source: "seed" }]);
    await insertScan(
      makeScan({
        keyword: "zzz-gap-test",
        opportunity: 0.53,
        scannedAt: now,
        topApps: [makeTopApp({ id: "42", name: "Rival App" })],
      }),
    );
    await markScanned(["zzz-gap-test"], now);

    const latest = await getLatestScan("zzz-gap-test");
    expect(latest?.opportunity).toBeCloseTo(0.53, 2);
    // rowToScan parses the jsonb `top_apps` column defensively — assert
    // directly against the production output, no test-local parsing.
    const topApps = latest?.topApps;
    expect(topApps).toHaveLength(1);
    expect(topApps?.[0]?.id).toBe("42");
    expect(topApps?.[0]?.name).toBe("Rival App");
    // Enrichment fields round-trip through the JSONB column intact.
    expect(topApps?.[0]?.lastUpdatedDays).toBe(400);
    expect(topApps?.[0]?.price).toBe(0);
    expect(topApps?.[0]?.formattedPrice).toBe("Free");
    expect(topApps?.[0]?.recentVelocity).toBeCloseTo(1.5, 6);

    const top = await getTopOpportunities({ limit: 50 });
    expect(top.rows.some((r) => r.keyword === "zzz-gap-test")).toBe(true);
  });

  describe("getTopOpportunities filters", () => {
    it("filters by genreZone alone", async () => {
      const now = Math.floor(Date.now() / 1000);
      await upsertKeywords([
        { keyword: "zzz-gap-filter-genre-match", genreZone: "finance", source: "seed" },
        { keyword: "zzz-gap-filter-genre-decoy", genreZone: "productivity", source: "seed" },
      ]);
      await insertScan(makeScan({ keyword: "zzz-gap-filter-genre-match", scannedAt: now }));
      await insertScan(makeScan({ keyword: "zzz-gap-filter-genre-decoy", scannedAt: now }));

      const top = await getTopOpportunities({ limit: 50, genreZone: "finance" });
      const keywords = top.rows.map((r) => r.keyword);
      expect(keywords).toContain("zzz-gap-filter-genre-match");
      expect(keywords).not.toContain("zzz-gap-filter-genre-decoy");
    });

    it("filters by trend alone", async () => {
      const now = Math.floor(Date.now() / 1000);
      await upsertKeywords([
        { keyword: "zzz-gap-filter-trend-match", genreZone: "health", source: "seed" },
        { keyword: "zzz-gap-filter-trend-decoy", genreZone: "health", source: "seed" },
      ]);
      await insertScan(
        makeScan({ keyword: "zzz-gap-filter-trend-match", trend: "cooling", scannedAt: now }),
      );
      await insertScan(
        makeScan({ keyword: "zzz-gap-filter-trend-decoy", trend: "heating", scannedAt: now }),
      );

      const top = await getTopOpportunities({ limit: 50, trend: "cooling" });
      const keywords = top.rows.map((r) => r.keyword);
      expect(keywords).toContain("zzz-gap-filter-trend-match");
      expect(keywords).not.toContain("zzz-gap-filter-trend-decoy");
    });

    it("filters by combined genreZone + trend, excluding partial matches", async () => {
      const now = Math.floor(Date.now() / 1000);
      await upsertKeywords([
        { keyword: "zzz-gap-filter-combo-match", genreZone: "finance", source: "seed" },
        { keyword: "zzz-gap-filter-combo-decoy-trend", genreZone: "finance", source: "seed" },
        { keyword: "zzz-gap-filter-combo-decoy-genre", genreZone: "productivity", source: "seed" },
      ]);
      await insertScan(
        makeScan({ keyword: "zzz-gap-filter-combo-match", trend: "new", scannedAt: now }),
      );
      // Same genre as the match, different trend — must be excluded.
      await insertScan(
        makeScan({
          keyword: "zzz-gap-filter-combo-decoy-trend",
          trend: "heating",
          scannedAt: now,
        }),
      );
      // Same trend as the match, different genre — must be excluded.
      await insertScan(
        makeScan({ keyword: "zzz-gap-filter-combo-decoy-genre", trend: "new", scannedAt: now }),
      );

      const top = await getTopOpportunities({ limit: 50, genreZone: "finance", trend: "new" });
      const keywords = top.rows.map((r) => r.keyword);
      expect(keywords).toContain("zzz-gap-filter-combo-match");
      expect(keywords).not.toContain("zzz-gap-filter-combo-decoy-trend");
      expect(keywords).not.toContain("zzz-gap-filter-combo-decoy-genre");
    });
  });

  describe("getTopOpportunities buildable-keyword filters", () => {
    it("bounds by minDemand", async () => {
      const now = Math.floor(Date.now() / 1000);
      const zone = "zzz-filter-demand-zone";
      await upsertKeywords([
        { keyword: "zzz-filter-demand-high", genreZone: zone, source: "seed" },
        { keyword: "zzz-filter-demand-low", genreZone: zone, source: "seed" },
      ]);
      await insertScan(makeScan({ keyword: "zzz-filter-demand-high", demand: 10, scannedAt: now }));
      await insertScan(makeScan({ keyword: "zzz-filter-demand-low", demand: 1, scannedAt: now }));

      const top = await getTopOpportunities({ limit: 50, genreZone: zone, minDemand: 5 });
      const keywords = top.rows.map((r) => r.keyword);
      expect(keywords).toContain("zzz-filter-demand-high");
      expect(keywords).not.toContain("zzz-filter-demand-low");
    });

    it("bounds by maxCompetitiveness", async () => {
      const now = Math.floor(Date.now() / 1000);
      const zone = "zzz-filter-comp-zone";
      await upsertKeywords([
        { keyword: "zzz-filter-comp-low", genreZone: zone, source: "seed" },
        { keyword: "zzz-filter-comp-high", genreZone: zone, source: "seed" },
      ]);
      await insertScan(
        makeScan({ keyword: "zzz-filter-comp-low", competitiveness: 20, scannedAt: now }),
      );
      await insertScan(
        makeScan({ keyword: "zzz-filter-comp-high", competitiveness: 80, scannedAt: now }),
      );

      const top = await getTopOpportunities({
        limit: 50,
        genreZone: zone,
        maxCompetitiveness: 45,
      });
      const keywords = top.rows.map((r) => r.keyword);
      expect(keywords).toContain("zzz-filter-comp-low");
      expect(keywords).not.toContain("zzz-filter-comp-high");
    });

    it("bounds by minIncumbentWeakness", async () => {
      const now = Math.floor(Date.now() / 1000);
      const zone = "zzz-filter-iw-zone";
      await upsertKeywords([
        { keyword: "zzz-filter-iw-high", genreZone: zone, source: "seed" },
        { keyword: "zzz-filter-iw-low", genreZone: zone, source: "seed" },
      ]);
      await insertScan(
        makeScan({ keyword: "zzz-filter-iw-high", incumbentWeakness: 0.8, scannedAt: now }),
      );
      await insertScan(
        makeScan({ keyword: "zzz-filter-iw-low", incumbentWeakness: 0.1, scannedAt: now }),
      );

      const top = await getTopOpportunities({
        limit: 50,
        genreZone: zone,
        minIncumbentWeakness: 0.4,
      });
      const keywords = top.rows.map((r) => r.keyword);
      expect(keywords).toContain("zzz-filter-iw-high");
      expect(keywords).not.toContain("zzz-filter-iw-low");
    });

    it("bounds by minOpportunity", async () => {
      const now = Math.floor(Date.now() / 1000);
      const zone = "zzz-filter-opp-zone";
      await upsertKeywords([
        { keyword: "zzz-filter-opp-high", genreZone: zone, source: "seed" },
        { keyword: "zzz-filter-opp-low", genreZone: zone, source: "seed" },
      ]);
      await insertScan(
        makeScan({ keyword: "zzz-filter-opp-high", opportunity: 0.9, scannedAt: now }),
      );
      await insertScan(
        makeScan({ keyword: "zzz-filter-opp-low", opportunity: 0.05, scannedAt: now }),
      );

      const top = await getTopOpportunities({ limit: 50, genreZone: zone, minOpportunity: 0.5 });
      const keywords = top.rows.map((r) => r.keyword);
      expect(keywords).toContain("zzz-filter-opp-high");
      expect(keywords).not.toContain("zzz-filter-opp-low");
    });

    describe("hideJunk", () => {
      it("removes a sole stoplist-word keyword", async () => {
        const now = Math.floor(Date.now() / 1000);
        await upsertKeywords([{ keyword: "hd", genreZone: "zzz-junk-zone", source: "seed" }]);
        await insertScan(makeScan({ keyword: "hd", scannedAt: now }));

        const hidden = await getTopOpportunities({
          limit: 50,
          genreZone: "zzz-junk-zone",
          hideJunk: true,
        });
        expect(hidden.rows.map((r) => r.keyword)).not.toContain("hd");

        const shown = await getTopOpportunities({
          limit: 50,
          genreZone: "zzz-junk-zone",
          hideJunk: false,
        });
        expect(shown.rows.map((r) => r.keyword)).toContain("hd");
      });

      it("removes a keyword shorter than 3 characters", async () => {
        const now = Math.floor(Date.now() / 1000);
        await upsertKeywords([{ keyword: "q9", genreZone: "zzz-junk-zone", source: "seed" }]);
        await insertScan(makeScan({ keyword: "q9", scannedAt: now }));

        const hidden = await getTopOpportunities({
          limit: 50,
          genreZone: "zzz-junk-zone",
          hideJunk: true,
        });
        expect(hidden.rows.map((r) => r.keyword)).not.toContain("q9");
      });

      it("removes a purely numeric keyword", async () => {
        const now = Math.floor(Date.now() / 1000);
        await upsertKeywords([{ keyword: "42", genreZone: "zzz-junk-zone", source: "seed" }]);
        await insertScan(makeScan({ keyword: "42", scannedAt: now }));

        const hidden = await getTopOpportunities({
          limit: 50,
          genreZone: "zzz-junk-zone",
          hideJunk: true,
        });
        expect(hidden.rows.map((r) => r.keyword)).not.toContain("42");
      });

      it("keeps a multi-word keyword even when one token is a generic stoplist word", async () => {
        const now = Math.floor(Date.now() / 1000);
        await upsertKeywords([
          {
            keyword: "zzz-junk-keep-budget-hd-planner",
            genreZone: "zzz-junk-zone",
            source: "seed",
          },
          { keyword: "zzz-legit-buildable-keyword", genreZone: "zzz-junk-zone", source: "seed" },
        ]);
        await insertScan(
          makeScan({ keyword: "zzz-junk-keep-budget-hd-planner", scannedAt: now }),
        );
        await insertScan(makeScan({ keyword: "zzz-legit-buildable-keyword", scannedAt: now }));

        const hidden = await getTopOpportunities({
          limit: 50,
          genreZone: "zzz-junk-zone",
          hideJunk: true,
        });
        const keywords = hidden.rows.map((r) => r.keyword);
        expect(keywords).toContain("zzz-junk-keep-budget-hd-planner");
        expect(keywords).toContain("zzz-legit-buildable-keyword");
      });
    });

    // Batch A budget rescue (2026-07-22) — see keyword-brand.ts module doc.
    describe("brandNavigational exclusion", () => {
      it("unconditionally excludes a brand-navigational latest scan, even without hideJunk", async () => {
        const now = Math.floor(Date.now() / 1000);
        await upsertKeywords([
          { keyword: "zzz-brand-nav-excluded", genreZone: "zzz-brand-nav-zone", source: "autocomplete" },
          { keyword: "zzz-brand-nav-kept", genreZone: "zzz-brand-nav-zone", source: "autocomplete" },
        ]);
        await insertScan(
          makeScan({ keyword: "zzz-brand-nav-excluded", scannedAt: now, brandNavigational: true }),
        );
        await insertScan(
          makeScan({ keyword: "zzz-brand-nav-kept", scannedAt: now, brandNavigational: false }),
        );

        const result = await getTopOpportunities({
          limit: 50,
          genreZone: "zzz-brand-nav-zone",
        });
        const keywords = result.rows.map((r) => r.keyword);
        expect(keywords).not.toContain("zzz-brand-nav-excluded");
        expect(keywords).toContain("zzz-brand-nav-kept");
      });
    });

    it("combines minDemand + maxCompetitiveness + minIncumbentWeakness + hideJunk ('Indie sweet spot'), and total reflects the filtered count", async () => {
      const now = Math.floor(Date.now() / 1000);
      const zone = "zzz-sweet-spot-zone";
      await upsertKeywords([
        { keyword: "zzz-sweet-spot-match", genreZone: zone, source: "seed" },
        { keyword: "zzz-sweet-spot-decoy-demand", genreZone: zone, source: "seed" },
        { keyword: "zzz-sweet-spot-decoy-comp", genreZone: zone, source: "seed" },
        { keyword: "zzz-sweet-spot-decoy-iw", genreZone: zone, source: "seed" },
        // Reuses the literal junk word "hd" as the decoy that fails only
        // hideJunk while passing every numeric bound.
        { keyword: "hd", genreZone: zone, source: "seed" },
      ]);
      // Meets every "Indie sweet spot" bound: demand >= 5, competitiveness <= 45,
      // incumbentWeakness >= 0.4, not junk.
      await insertScan(
        makeScan({
          keyword: "zzz-sweet-spot-match",
          demand: 10,
          competitiveness: 30,
          incumbentWeakness: 0.6,
          scannedAt: now,
        }),
      );
      // Fails minDemand only.
      await insertScan(
        makeScan({
          keyword: "zzz-sweet-spot-decoy-demand",
          demand: 2,
          competitiveness: 30,
          incumbentWeakness: 0.6,
          scannedAt: now,
        }),
      );
      // Fails maxCompetitiveness only.
      await insertScan(
        makeScan({
          keyword: "zzz-sweet-spot-decoy-comp",
          demand: 10,
          competitiveness: 80,
          incumbentWeakness: 0.6,
          scannedAt: now,
        }),
      );
      // Fails minIncumbentWeakness only.
      await insertScan(
        makeScan({
          keyword: "zzz-sweet-spot-decoy-iw",
          demand: 10,
          competitiveness: 30,
          incumbentWeakness: 0.1,
          scannedAt: now,
        }),
      );
      // Passes every numeric bound but is junk (sole stoplist word).
      await insertScan(
        makeScan({
          keyword: "hd",
          demand: 10,
          competitiveness: 30,
          incumbentWeakness: 0.6,
          scannedAt: now,
        }),
      );

      const top = await getTopOpportunities({
        limit: 50,
        genreZone: zone,
        minDemand: 5,
        maxCompetitiveness: 45,
        minIncumbentWeakness: 0.4,
        hideJunk: true,
      });
      expect(top.rows.map((r) => r.keyword)).toEqual(["zzz-sweet-spot-match"]);
      // total reflects the FILTERED count (1), not the 5 rows inserted.
      expect(top.total).toBe(1);
    });
  });

  describe("getTopOpportunities keyword meta", () => {
    it("surfaces firstFoundAt + source from the joined corpus row", async () => {
      const now = Math.floor(Date.now() / 1000);
      await upsertKeywords([
        { keyword: "zzz-gap-meta-fields", genreZone: "health", source: "autocomplete" },
      ]);
      await insertScan(makeScan({ keyword: "zzz-gap-meta-fields", scannedAt: now }));

      const top = await getTopOpportunities({ limit: 50 });
      const row = top.rows.find((r) => r.keyword === "zzz-gap-meta-fields");
      expect(row).toBeDefined();
      expect(row?.source).toBe("autocomplete");
      expect(typeof row?.firstFoundAt).toBe("number");
    });
  });

  describe("getTopOpportunities ASA popularity join", () => {
    it("surfaces the latest asaPopularity/asaPopularityCheckedAt for a probed keyword", async () => {
      const now = Math.floor(Date.now() / 1000);
      await upsertKeywords([
        { keyword: "zzz-asa-pop-probed", genreZone: "health", source: "seed" },
      ]);
      await insertScan(makeScan({ keyword: "zzz-asa-pop-probed", scannedAt: now }));
      await upsertPopularity([
        {
          keyword: "zzz-asa-pop-probed",
          source: "asa",
          value: 1,
          storefront: "US",
          checkedAt: now - 3600,
        },
      ]);

      const top = await getTopOpportunities({ limit: 50 });
      const row = top.rows.find((r) => r.keyword === "zzz-asa-pop-probed");
      expect(row).toBeDefined();
      expect(row?.asaPopularity).toBe(1);
      expect(row?.asaPopularityCheckedAt).toBe(now - 3600);
    });

    it("leaves asaPopularity/asaPopularityCheckedAt null for a never-probed keyword", async () => {
      const now = Math.floor(Date.now() / 1000);
      await upsertKeywords([
        { keyword: "zzz-asa-pop-unprobed", genreZone: "health", source: "seed" },
      ]);
      await insertScan(makeScan({ keyword: "zzz-asa-pop-unprobed", scannedAt: now }));

      const top = await getTopOpportunities({ limit: 50 });
      const row = top.rows.find((r) => r.keyword === "zzz-asa-pop-unprobed");
      expect(row).toBeDefined();
      expect(row?.asaPopularity).toBeNull();
      expect(row?.asaPopularityCheckedAt).toBeNull();
    });
  });

  describe("getTopOpportunities pagination + sorting", () => {
    it("sorts by a numeric column (competitiveness) ascending and descending", async () => {
      const now = Math.floor(Date.now() / 1000);
      const zone = "zzz-sort-num-zone";
      await upsertKeywords([
        { keyword: "zzz-sort-num-a", genreZone: zone, source: "seed" },
        { keyword: "zzz-sort-num-b", genreZone: zone, source: "seed" },
        { keyword: "zzz-sort-num-c", genreZone: zone, source: "seed" },
      ]);
      await insertScan(
        makeScan({ keyword: "zzz-sort-num-a", competitiveness: 10, scannedAt: now }),
      );
      await insertScan(
        makeScan({ keyword: "zzz-sort-num-b", competitiveness: 30, scannedAt: now }),
      );
      await insertScan(
        makeScan({ keyword: "zzz-sort-num-c", competitiveness: 20, scannedAt: now }),
      );

      const asc = await getTopOpportunities({
        limit: 50,
        genreZone: zone,
        sort: "competitiveness",
        dir: "asc",
      });
      expect(asc.rows.map((r) => r.keyword)).toEqual([
        "zzz-sort-num-a",
        "zzz-sort-num-c",
        "zzz-sort-num-b",
      ]);

      const desc = await getTopOpportunities({
        limit: 50,
        genreZone: zone,
        sort: "competitiveness",
        dir: "desc",
      });
      expect(desc.rows.map((r) => r.keyword)).toEqual([
        "zzz-sort-num-b",
        "zzz-sort-num-c",
        "zzz-sort-num-a",
      ]);
    });

    it("sorts by the keyword text column ascending and descending", async () => {
      const now = Math.floor(Date.now() / 1000);
      const zone = "zzz-sort-text-zone";
      await upsertKeywords([
        { keyword: "zzz-sort-text-alpha", genreZone: zone, source: "seed" },
        { keyword: "zzz-sort-text-bravo", genreZone: zone, source: "seed" },
        { keyword: "zzz-sort-text-charlie", genreZone: zone, source: "seed" },
      ]);
      // Inserted out of alphabetical order — sort must not depend on insert order.
      await insertScan(makeScan({ keyword: "zzz-sort-text-charlie", scannedAt: now }));
      await insertScan(makeScan({ keyword: "zzz-sort-text-alpha", scannedAt: now }));
      await insertScan(makeScan({ keyword: "zzz-sort-text-bravo", scannedAt: now }));

      const asc = await getTopOpportunities({
        limit: 50,
        genreZone: zone,
        sort: "keyword",
        dir: "asc",
      });
      expect(asc.rows.map((r) => r.keyword)).toEqual([
        "zzz-sort-text-alpha",
        "zzz-sort-text-bravo",
        "zzz-sort-text-charlie",
      ]);

      const desc = await getTopOpportunities({
        limit: 50,
        genreZone: zone,
        sort: "keyword",
        dir: "desc",
      });
      expect(desc.rows.map((r) => r.keyword)).toEqual([
        "zzz-sort-text-charlie",
        "zzz-sort-text-bravo",
        "zzz-sort-text-alpha",
      ]);
    });

    it("defaults to sort=opportunity, dir=desc when both are omitted", async () => {
      const now = Math.floor(Date.now() / 1000);
      const zone = "zzz-sort-default-zone";
      await upsertKeywords([
        { keyword: "zzz-sort-default-a", genreZone: zone, source: "seed" },
        { keyword: "zzz-sort-default-b", genreZone: zone, source: "seed" },
      ]);
      await insertScan(
        makeScan({ keyword: "zzz-sort-default-a", opportunity: 0.2, scannedAt: now }),
      );
      await insertScan(
        makeScan({ keyword: "zzz-sort-default-b", opportunity: 0.8, scannedAt: now }),
      );

      const defaulted = await getTopOpportunities({ limit: 50, genreZone: zone });
      const explicit = await getTopOpportunities({
        limit: 50,
        genreZone: zone,
        sort: "opportunity",
        dir: "desc",
      });
      expect(defaulted.rows.map((r) => r.keyword)).toEqual(explicit.rows.map((r) => r.keyword));
      // Highest opportunity first by default.
      expect(defaulted.rows.map((r) => r.keyword)).toEqual([
        "zzz-sort-default-b",
        "zzz-sort-default-a",
      ]);
    });

    it("includes peakOpportunity alongside the latest scan's opportunity regardless of sort column", async () => {
      const now = Math.floor(Date.now() / 1000);
      const zone = "zzz-peak-zone";
      await upsertKeywords([
        { keyword: "zzz-peak-rank-old-glory", genreZone: zone, source: "seed" },
        { keyword: "zzz-peak-rank-steady", genreZone: zone, source: "seed" },
      ]);
      // old-glory: peaked long ago, has since collapsed to near-zero demand.
      await insertScan(
        makeScan({ keyword: "zzz-peak-rank-old-glory", opportunity: 0.95, scannedAt: now - 1000 }),
      );
      await insertScan(
        makeScan({ keyword: "zzz-peak-rank-old-glory", opportunity: 0.05, scannedAt: now }),
      );
      // steady: only ever scanned once, mid-range opportunity.
      await insertScan(
        makeScan({ keyword: "zzz-peak-rank-steady", opportunity: 0.5, scannedAt: now }),
      );

      // Default sort (latest-scan opportunity desc) — steady's 0.5 outranks
      // old-glory's collapsed 0.05 latest scan, even though old-glory's
      // ALL-TIME peak (0.95) is higher.
      const result = await getTopOpportunities({ limit: 50, genreZone: zone });
      const keywords = result.rows.map((r) => r.keyword);
      expect(keywords.indexOf("zzz-peak-rank-steady")).toBeLessThan(
        keywords.indexOf("zzz-peak-rank-old-glory"),
      );

      const oldGlory = result.rows.find((r) => r.keyword === "zzz-peak-rank-old-glory");
      expect(oldGlory?.peakOpportunity).toBeCloseTo(0.95, 2);
      expect(oldGlory?.opportunity).toBeCloseTo(0.05, 2);
      const steady = result.rows.find((r) => r.keyword === "zzz-peak-rank-steady");
      expect(steady?.peakOpportunity).toBeCloseTo(0.5, 2);
      expect(steady?.opportunity).toBeCloseTo(0.5, 2);
    });

    // Batch D item D3 (2026-07-22): a fresher `store = 'DE'` row must never
    // shadow the US latest-scan row or dominate `peakOpportunity` — see
    // `getTopOpportunities`'s doc comment.
    it("reads the US store's latest scan and peakOpportunity even when a NEWER, higher-opportunity DE row exists for the same keyword", async () => {
      const now = Math.floor(Date.now() / 1000);
      const zone = "zzz-d3-peak-zone";
      await upsertKeywords([
        { keyword: "zzz-d3-peak-de-shadow", genreZone: zone, source: "seed" },
      ]);
      // Older US scan.
      await insertScan(
        makeScan({
          keyword: "zzz-d3-peak-de-shadow",
          store: "app",
          demand: 11,
          opportunity: 0.3,
          scannedAt: now - 1000,
        }),
      );
      // NEWER DE scan, deliberately higher opportunity — this must NOT win.
      await insertScan(
        makeScan({
          keyword: "zzz-d3-peak-de-shadow",
          store: "DE",
          demand: 999,
          opportunity: 0.99,
          scannedAt: now,
        }),
      );

      const result = await getTopOpportunities({ limit: 50, genreZone: zone });
      const row = result.rows.find((r) => r.keyword === "zzz-d3-peak-de-shadow");
      expect(row).toBeDefined();
      expect(row?.store).toBe("app");
      expect(row?.demand).toBeCloseTo(11, 2);
      expect(row?.opportunity).toBeCloseTo(0.3, 2);
      // peakOpportunity must ALSO stay US-only — 0.3, not the DE row's 0.99.
      expect(row?.peakOpportunity).toBeCloseTo(0.3, 2);

      // No separate DE row appears in the leaderboard either — a second
      // (store, keyword) entry would prove the `s` CTE isn't pinned.
      const allRowsForKeyword = result.rows.filter((r) => r.keyword === "zzz-d3-peak-de-shadow");
      expect(allRowsForKeyword).toHaveLength(1);
    });

    it("paginates via limit/offset and reports the whole-corpus total, scoped by genreZone", async () => {
      const now = Math.floor(Date.now() / 1000);
      const zone = "zzz-page-zone";
      await upsertKeywords([
        { keyword: "zzz-page-test-a", genreZone: zone, source: "seed" },
        { keyword: "zzz-page-test-b", genreZone: zone, source: "seed" },
        { keyword: "zzz-page-test-c", genreZone: zone, source: "seed" },
      ]);
      await insertScan(makeScan({ keyword: "zzz-page-test-a", opportunity: 0.9, scannedAt: now }));
      await insertScan(makeScan({ keyword: "zzz-page-test-b", opportunity: 0.6, scannedAt: now }));
      await insertScan(makeScan({ keyword: "zzz-page-test-c", opportunity: 0.3, scannedAt: now }));

      const page0 = await getTopOpportunities({ limit: 1, offset: 0, genreZone: zone });
      expect(page0.total).toBe(3);
      expect(page0.rows).toHaveLength(1);
      expect(page0.rows[0]?.keyword).toBe("zzz-page-test-a");

      const page1 = await getTopOpportunities({ limit: 1, offset: 1, genreZone: zone });
      expect(page1.total).toBe(3);
      expect(page1.rows[0]?.keyword).toBe("zzz-page-test-b");

      const page2 = await getTopOpportunities({ limit: 1, offset: 2, genreZone: zone });
      expect(page2.rows[0]?.keyword).toBe("zzz-page-test-c");

      // Past the end of the matching set: empty page, same total.
      const page3 = await getTopOpportunities({ limit: 1, offset: 3, genreZone: zone });
      expect(page3.total).toBe(3);
      expect(page3.rows).toHaveLength(0);
    });
  });

  describe("getKeywordMeta", () => {
    it("returns firstFoundAt + source for a keyword in the corpus", async () => {
      await upsertKeywords([
        { keyword: "zzz-keyword-meta", genreZone: "health", source: "manual" },
      ]);

      const meta = await getKeywordMeta("zzz-keyword-meta");
      expect(meta).not.toBeNull();
      expect(meta?.source).toBe("manual");
      expect(typeof meta?.firstFoundAt).toBe("number");
    });

    it("returns null for a keyword not in the corpus", async () => {
      const meta = await getKeywordMeta("zzz-keyword-meta-absent");
      expect(meta).toBeNull();
    });
  });

  it("getScanHistory returns scans newest-first, bounded by limit", async () => {
    const base = Math.floor(Date.now() / 1000);
    await upsertKeywords([{ keyword: "zzz-gap-history", genreZone: "health", source: "seed" }]);
    await insertScan(
      makeScan({ keyword: "zzz-gap-history", opportunity: 0.1, scannedAt: base - 200 }),
    );
    await insertScan(
      makeScan({ keyword: "zzz-gap-history", opportunity: 0.2, scannedAt: base - 100 }),
    );
    await insertScan(makeScan({ keyword: "zzz-gap-history", opportunity: 0.3, scannedAt: base }));

    const history = await getScanHistory("zzz-gap-history", 2, "app");
    expect(history).toHaveLength(2);
    expect(history[0]?.scannedAt).toBe(base);
    expect(history[1]?.scannedAt).toBe(base - 100);
    // Bounded by limit — the oldest scan is excluded.
    expect(history.some((r) => r.scannedAt === base - 200)).toBe(false);
  });

  describe("getMostRecentScanAt", () => {
    it("returns the newest scanned_at among a zone's keywords", async () => {
      const base = Math.floor(Date.now() / 1000);
      await upsertKeywords([
        { keyword: "zzz-most-recent-scan-a", genreZone: "zzz-most-recent-zone", source: "seed" },
        { keyword: "zzz-most-recent-scan-b", genreZone: "zzz-most-recent-zone", source: "seed" },
      ]);
      await insertScan(
        makeScan({ keyword: "zzz-most-recent-scan-a", scannedAt: base - 100 }),
      );
      await insertScan(makeScan({ keyword: "zzz-most-recent-scan-b", scannedAt: base }));

      const last = await getMostRecentScanAt("zzz-most-recent-zone");
      expect(last).toBe(base);
    });

    it("returns null for a zone with no scans", async () => {
      const last = await getMostRecentScanAt("zzz-no-scans-zone");
      expect(last).toBeNull();
    });
  });

  describe("countScansSince", () => {
    it("counts scans recorded at or after the given epoch", async () => {
      const now = Math.floor(Date.now() / 1000);
      await upsertKeywords([
        { keyword: "zzz-count-scans-since", genreZone: "health", source: "seed" },
      ]);

      const before = await countScansSince(now - 10);
      await insertScan(makeScan({ keyword: "zzz-count-scans-since", scannedAt: now }));
      const after = await countScansSince(now - 10);

      // Tolerant of other real activity landing scans in this shared DB
      // concurrently — assert the delta from our own insert, not an exact
      // absolute count.
      expect(after).toBeGreaterThanOrEqual(before + 1);
    });

    it("excludes scans older than the given epoch", async () => {
      const now = Math.floor(Date.now() / 1000);
      await upsertKeywords([
        { keyword: "zzz-count-scans-since", genreZone: "health", source: "seed" },
      ]);
      await insertScan(
        makeScan({ keyword: "zzz-count-scans-since", scannedAt: now - 1000 }),
      );

      const count = await countScansSince(now + 1000);
      expect(count).toBe(0);
    });
  });

  describe("getWinnerKeywords", () => {
    it("returns only keywords clearing minOpportunity, with their genreZone", async () => {
      const now = Math.floor(Date.now() / 1000);
      await upsertKeywords([
        { keyword: "zzz-winner-high", genreZone: "finance", source: "seed" },
        { keyword: "zzz-winner-low", genreZone: "finance", source: "seed" },
      ]);
      await insertScan(makeScan({ keyword: "zzz-winner-high", opportunity: 0.9, scannedAt: now }));
      await insertScan(makeScan({ keyword: "zzz-winner-low", opportunity: 0.1, scannedAt: now }));

      const winners = await getWinnerKeywords(0.4, 50);
      const highs = winners.filter((w) => w.keyword === "zzz-winner-high");
      expect(highs).toHaveLength(1);
      expect(highs[0]?.genreZone).toBe("finance");
      expect(winners.some((w) => w.keyword === "zzz-winner-low")).toBe(false);
    });
  });

  // 2026-07-21 audit item B: the DE storefront lane (querying/mining data
  // only) must never leak into the US-scoped miner input, US scan-history
  // depth, or autocomplete winner-seed selection — regardless of how
  // high-opportunity or recent a DE row is.
  describe("DE storefront lane quarantine (2026-07-21 audit item B)", () => {
    const GERMAN_APP_NAME = "Zzz Deutsche Bahn Navigator";

    it("keeps a DE-store scan's app names out of the miner, its history out of the US series, and its opportunity out of winner-seed selection", async () => {
      const farFuture = Math.floor(Date.now() / 1000) + 2_000_000;
      await upsertKeywords([
        { keyword: "zzz-de-quarantine-keyword", genreZone: "finance", source: "seed" },
      ]);

      // A US-store scan for the same keyword, comfortably below any winner
      // threshold and with an ordinary (non-German) app name — this is what
      // getScanHistory('app', ...) / getWinnerKeywords should actually see.
      await insertScan(
        makeScan({
          keyword: "zzz-de-quarantine-keyword",
          store: "app",
          opportunity: 0.1,
          scannedAt: farFuture - 100,
          topApps: [makeTopApp({ id: "zzz-de-quarantine-us-app", name: "Zzz Ordinary US App" })],
        }),
      );

      // A DE-store scan for the SAME keyword: high opportunity (clears any
      // winner threshold) and a distinctly German app name — the exact leak
      // the audit flagged as worst (German SERP app names entering the US
      // keyword miner daily; a high-opportunity DE row silently qualifying
      // as an autocomplete seed).
      await insertScan(
        makeScan({
          keyword: "zzz-de-quarantine-keyword",
          store: "DE",
          opportunity: 0.95,
          scannedAt: farFuture,
          topApps: [makeTopApp({ id: "zzz-de-quarantine-de-app", name: GERMAN_APP_NAME })],
        }),
      );

      // (a) The miner never sees the German app name.
      const scannedNames = await getScannedAppNames(100_000);
      expect(scannedNames).not.toContain(GERMAN_APP_NAME);

      // (b) getScanHistory('app', ...) is exactly the US scan — unaffected
      // by the DE row's presence (not starved of a slot by it, and doesn't
      // return the DE row's content).
      const usHistory = await getScanHistory("zzz-de-quarantine-keyword", 10, "app");
      expect(usHistory).toHaveLength(1);
      expect(usHistory[0]?.store).toBe("app");
      expect(usHistory[0]?.topApps.some((a) => a.name === GERMAN_APP_NAME)).toBe(false);

      // (c) getWinnerKeywords never surfaces the DE-only high-opportunity
      // scan as an autocomplete seed, despite it clearing minOpportunity.
      const winners = await getWinnerKeywords(0.5, 100_000);
      expect(winners.some((w) => w.keyword === "zzz-de-quarantine-keyword")).toBe(false);
    });
  });

  describe("keywordsExist", () => {
    it("returns only the subset of candidate keywords already present in the corpus", async () => {
      await upsertKeywords([
        { keyword: "zzz-exist-check-present", genreZone: "finance", source: "seed" },
      ]);

      const existing = await keywordsExist(["zzz-exist-check-present", "zzz-exist-check-absent"]);
      expect(existing.has("zzz-exist-check-present")).toBe(true);
      expect(existing.has("zzz-exist-check-absent")).toBe(false);
    });

    it("returns an empty set for an empty input", async () => {
      const existing = await keywordsExist([]);
      expect(existing.size).toBe(0);
    });
  });

  // Seed-selection helpers backing broadened autocomplete corpus expansion
  // (anti rich-get-richer monoculture) — kept in its own describe block, own
  // zzz-prefixed keywords/zones, appended without touching the tests above.
  describe("getDiverseZoneSample / getExpansionSeeds", () => {
    it("round-robins the stalest keyword per zone before any zone's second-stalest", async () => {
      const now = Math.floor(Date.now() / 1000);
      await upsertKeywords([
        { keyword: "zzz-diverse-zone-a-stale", genreZone: "zzz-diverse-zone-a", source: "seed" },
        { keyword: "zzz-diverse-zone-a-fresh", genreZone: "zzz-diverse-zone-a", source: "seed" },
        { keyword: "zzz-diverse-zone-b-stale", genreZone: "zzz-diverse-zone-b", source: "seed" },
        { keyword: "zzz-diverse-zone-b-fresh", genreZone: "zzz-diverse-zone-b", source: "seed" },
      ]);
      await markScanned(["zzz-diverse-zone-a-stale"], now - 1000);
      await markScanned(["zzz-diverse-zone-a-fresh"], now - 10);
      await markScanned(["zzz-diverse-zone-b-stale"], now - 900);
      await markScanned(["zzz-diverse-zone-b-fresh"], now - 20);

      // Large enough to include our rows regardless of how much real corpus
      // data already exists in this shared DB.
      const sample = await getDiverseZoneSample(100_000);
      const keywords = sample.map((s) => s.keyword);
      const idxAStale = keywords.indexOf("zzz-diverse-zone-a-stale");
      const idxAFresh = keywords.indexOf("zzz-diverse-zone-a-fresh");
      const idxBStale = keywords.indexOf("zzz-diverse-zone-b-stale");
      const idxBFresh = keywords.indexOf("zzz-diverse-zone-b-fresh");
      expect(idxAStale).toBeGreaterThanOrEqual(0);
      expect(idxAFresh).toBeGreaterThanOrEqual(0);
      expect(idxBStale).toBeGreaterThanOrEqual(0);
      expect(idxBFresh).toBeGreaterThanOrEqual(0);

      // Each zone's stalest keyword ranks ahead of that same zone's fresher one.
      expect(idxAStale).toBeLessThan(idxAFresh);
      expect(idxBStale).toBeLessThan(idxBFresh);
      // Round robin: both zones' stalest ("rn=1") picks precede either
      // zone's second-stalest ("rn=2") pick.
      expect(idxAStale).toBeLessThan(idxBFresh);
      expect(idxBStale).toBeLessThan(idxAFresh);
    });

    it("returns an empty array for a non-positive limit", async () => {
      const sample = await getDiverseZoneSample(0);
      expect(sample).toEqual([]);
    });

    it("combines winners and a diverse sample, deduped, without double-counting overlap", async () => {
      const now = Math.floor(Date.now() / 1000);
      await upsertKeywords([
        { keyword: "zzz-expansion-winner", genreZone: "zzz-expansion-zone", source: "seed" },
        { keyword: "zzz-expansion-diverse", genreZone: "zzz-expansion-zone-2", source: "seed" },
      ]);
      await insertScan(
        makeScan({ keyword: "zzz-expansion-winner", opportunity: 0.9, scannedAt: now }),
      );

      const seeds = await getExpansionSeeds({
        minOpportunity: 0.4,
        winnerLimit: 50,
        diverseLimit: 50,
      });
      const keywords = seeds.map((s) => s.keyword);
      expect(keywords).toContain("zzz-expansion-winner");
      expect(keywords).toContain("zzz-expansion-diverse");
      // No duplicates, even though a large diverse sample could otherwise
      // re-select the winner keyword.
      expect(new Set(keywords).size).toBe(keywords.length);
    });
  });

  // 2026-07-21 audit item D: seed rotation state (appstore_seed_expansion_state,
  // migration 043) + autocomplete rank-hint persistence
  // (appstore_autocomplete_hints, migration 043).
  describe("seed rotation & autocomplete hints (2026-07-21 audit item D)", () => {
    it("getWinnerKeywords rotates: marking a top-opportunity winner expanded drops it behind a not-yet-expanded lower (but still qualifying) winner", async () => {
      const now = Math.floor(Date.now() / 1000);
      await upsertKeywords([
        { keyword: "zzz-rotate-winner-a", genreZone: "zzz-rotate-zone", source: "seed" },
        { keyword: "zzz-rotate-winner-b", genreZone: "zzz-rotate-zone", source: "seed" },
      ]);
      await insertScan(
        makeScan({ keyword: "zzz-rotate-winner-a", opportunity: 0.9, scannedAt: now }),
      );
      await insertScan(
        makeScan({ keyword: "zzz-rotate-winner-b", opportunity: 0.5, scannedAt: now }),
      );

      // Before any expansion: both never-expanded (NULLS FIRST tie), so
      // opportunity DESC decides — "a" (0.9) ranks ahead of "b" (0.5).
      const before = await getWinnerKeywords(0.4, 100_000);
      const beforeKeywords = before.map((w) => w.keyword);
      expect(beforeKeywords.indexOf("zzz-rotate-winner-a")).toBeLessThan(
        beforeKeywords.indexOf("zzz-rotate-winner-b"),
      );

      // Mark "a" (the higher-opportunity one) as just-expanded.
      await markSeedsExpanded(rotationUpdates(["zzz-rotate-winner-a"]), now);

      // After: "b" (never expanded, NULLS FIRST) now ranks ahead of "a"
      // (has a last_expanded_at), even though "a" still has higher raw
      // opportunity — proves rotation, not just opportunity, drives order.
      const after = await getWinnerKeywords(0.4, 100_000);
      const afterKeywords = after.map((w) => w.keyword);
      expect(afterKeywords.indexOf("zzz-rotate-winner-b")).toBeLessThan(
        afterKeywords.indexOf("zzz-rotate-winner-a"),
      );
    });

    it("getExpansionSeeds: two successive passes over the same qualifying pool select different seeds after markSeedsExpanded", async () => {
      const now = Math.floor(Date.now() / 1000);
      await upsertKeywords([
        { keyword: "zzz-rotate-winner-a", genreZone: "zzz-rotate-zone", source: "seed" },
        { keyword: "zzz-rotate-winner-b", genreZone: "zzz-rotate-zone", source: "seed" },
        { keyword: "zzz-rotate-winner-c", genreZone: "zzz-rotate-zone", source: "seed" },
        { keyword: "zzz-rotate-winner-d", genreZone: "zzz-rotate-zone", source: "seed" },
      ]);
      // 4 qualifying winners, distinct opportunity. `winnerLimit: 100_000`
      // (rather than a small number like 2) deliberately avoids competing
      // for a truncated slice against this shared, live-scraped dev DB's
      // real winner pool — filtering the (untruncated) result down to just
      // these 4 keywords by prefix and checking their RELATIVE order is
      // robust regardless of how many real keywords interleave around them
      // (same pattern as the getWinnerKeywords/getDiverseZoneSample
      // rotation tests above).
      await insertScan(makeScan({ keyword: "zzz-rotate-winner-a", opportunity: 0.9, scannedAt: now }));
      await insertScan(makeScan({ keyword: "zzz-rotate-winner-b", opportunity: 0.8, scannedAt: now }));
      await insertScan(makeScan({ keyword: "zzz-rotate-winner-c", opportunity: 0.7, scannedAt: now }));
      await insertScan(makeScan({ keyword: "zzz-rotate-winner-d", opportunity: 0.6, scannedAt: now }));

      const pass1 = await getExpansionSeeds({
        minOpportunity: 0.4,
        winnerLimit: 100_000,
        diverseLimit: 0,
      });
      const pass1Keywords = pass1
        .map((s) => s.keyword)
        .filter((k) => k.startsWith("zzz-rotate-winner-"));
      // Never-expanded (NULL tie): opportunity DESC decides among these 4.
      expect(pass1Keywords).toEqual([
        "zzz-rotate-winner-a",
        "zzz-rotate-winner-b",
        "zzz-rotate-winner-c",
        "zzz-rotate-winner-d",
      ]);

      // Simulate expandCorpus having just used the top 2 as seeds.
      await markSeedsExpanded(rotationUpdates(["zzz-rotate-winner-a", "zzz-rotate-winner-b"]), now);

      const pass2 = await getExpansionSeeds({
        minOpportunity: 0.4,
        winnerLimit: 100_000,
        diverseLimit: 0,
      });
      const pass2Keywords = pass2
        .map((s) => s.keyword)
        .filter((k) => k.startsWith("zzz-rotate-winner-"));
      // "c"/"d" (still never-expanded) now precede "a"/"b" (just-expanded),
      // even though "a"/"b" still have strictly higher raw opportunity —
      // rotation, not opportunity, decides once expansion state differs.
      expect(pass2Keywords).toEqual([
        "zzz-rotate-winner-c",
        "zzz-rotate-winner-d",
        "zzz-rotate-winner-a",
        "zzz-rotate-winner-b",
      ]);
    });

    it("getDiverseZoneSample rotates: marking a keyword expanded drops it behind a not-yet-expanded zone-mate", async () => {
      const now = Math.floor(Date.now() / 1000);
      await upsertKeywords([
        { keyword: "zzz-rotate-diverse-a", genreZone: "zzz-rotate-diverse-zone", source: "seed" },
        { keyword: "zzz-rotate-diverse-b", genreZone: "zzz-rotate-diverse-zone", source: "seed" },
      ]);
      // Same last_scanned_at so the secondary tiebreak can't decide —
      // isolates the assertion to the rotation state.
      await markScanned(["zzz-rotate-diverse-a", "zzz-rotate-diverse-b"], now - 1000);

      const before = await getDiverseZoneSample(100_000);
      const beforeKeywords = before.map((s) => s.keyword);
      expect(beforeKeywords.indexOf("zzz-rotate-diverse-a")).toBeLessThan(
        beforeKeywords.indexOf("zzz-rotate-diverse-b"),
      );

      await markSeedsExpanded(rotationUpdates(["zzz-rotate-diverse-a"]), now);

      const after = await getDiverseZoneSample(100_000);
      const afterKeywords = after.map((s) => s.keyword);
      expect(afterKeywords.indexOf("zzz-rotate-diverse-b")).toBeLessThan(
        afterKeywords.indexOf("zzz-rotate-diverse-a"),
      );
    });

    it("markSeedsExpanded upserts — a later call updates last_expanded_at rather than erroring on conflict", async () => {
      const now = Math.floor(Date.now() / 1000);
      await upsertKeywords([
        { keyword: "zzz-rotate-winner-a", genreZone: "zzz-rotate-zone", source: "seed" },
      ]);
      await markSeedsExpanded(rotationUpdates(["zzz-rotate-winner-a"]), now - 1000);
      await markSeedsExpanded(rotationUpdates(["zzz-rotate-winner-a"]), now); // must not throw

      const db = getDb();
      const rows = await db`
        SELECT last_expanded_at FROM appstore_seed_expansion_state WHERE keyword = 'zzz-rotate-winner-a'
      `;
      expect(Number((rows as ReadonlyArray<{ last_expanded_at: number | string }>)[0]?.last_expanded_at)).toBe(now);
    });

    it("is a no-op for an empty keyword list", async () => {
      await expect(markSeedsExpanded([], Math.floor(Date.now() / 1000))).resolves.toBeUndefined();
    });

    it("insertAutocompleteHints persists rows with correct seed/term/rank/seen_at", async () => {
      const seenAt = Math.floor(Date.now() / 1000);
      await insertAutocompleteHints([
        { seed: "zzz-rotate-winner-a", term: "zzz-rotate-winner-a planner", rank: 0, seenAt, kept: true },
        { seed: "zzz-rotate-winner-a", term: "zzz-rotate-winner-a bestie", rank: 1, seenAt, kept: true },
      ]);

      const db = getDb();
      const rows = await db`
        SELECT seed, term, rank, seen_at FROM appstore_autocomplete_hints
        WHERE seed = 'zzz-rotate-winner-a'
        ORDER BY rank ASC
      `;
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        seed: "zzz-rotate-winner-a",
        term: "zzz-rotate-winner-a planner",
        rank: 0,
      });
      expect(rows[1]).toMatchObject({
        seed: "zzz-rotate-winner-a",
        term: "zzz-rotate-winner-a bestie",
        rank: 1,
      });
      expect(Number((rows[0] as { seen_at: number | string }).seen_at)).toBe(seenAt);
    });

    it("insertAutocompleteHints is a no-op for an empty row list", async () => {
      await expect(insertAutocompleteHints([])).resolves.toBeUndefined();
    });

    // Throughput wave item 3 ("hint breadth") — migration 049's storefront
    // column on appstore_autocomplete_hints.
    it("insertAutocompleteHints persists the caller-supplied storefront (GB hints lane)", async () => {
      const seenAt = Math.floor(Date.now() / 1000);
      await insertAutocompleteHints([
        {
          seed: "zzz-rotate-gb-seed",
          term: "zzz-rotate-gb-seed term",
          rank: 0,
          seenAt,
          storefront: "gb",
          kept: true,
        },
      ]);

      const db = getDb();
      const rows = await db`
        SELECT seed, term, storefront FROM appstore_autocomplete_hints
        WHERE seed = 'zzz-rotate-gb-seed'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ seed: "zzz-rotate-gb-seed", storefront: "gb" });
    });

    it("insertAutocompleteHints defaults storefront to 'us' when omitted (backward compatible)", async () => {
      const seenAt = Math.floor(Date.now() / 1000);
      await insertAutocompleteHints([
        {
          seed: "zzz-rotate-default-storefront",
          term: "zzz-rotate-default-storefront term",
          rank: 0,
          seenAt,
          kept: true,
        },
      ]);

      const db = getDb();
      const rows = await db`
        SELECT storefront FROM appstore_autocomplete_hints WHERE seed = 'zzz-rotate-default-storefront'
      `;
      expect(rows[0]).toMatchObject({ storefront: "us" });
    });

    // Batch D item D1 (migration 052): `kept` distinguishes a genuine
    // expansion candidate from a raw parsed term that was filtered out.
    it("insertAutocompleteHints persists kept=false for a filtered-out term", async () => {
      const seenAt = Math.floor(Date.now() / 1000);
      await insertAutocompleteHints([
        { seed: "zzz-rotate-winner-a", term: "app", rank: 0, seenAt, kept: false },
      ]);

      const db = getDb();
      const rows = await db`
        SELECT kept FROM appstore_autocomplete_hints
        WHERE seed = 'zzz-rotate-winner-a' AND term = 'app'
      `;
      expect(rows[0]).toMatchObject({ kept: false });
    });
  });

  // Batch D item D1 (2026-07-22): reads the previously write-only
  // `appstore_autocomplete_hints` table as a demand-confidence signal.
  describe("getHintEvidence", () => {
    const SEEN_AT = Math.floor(Date.now() / 1000);

    it("aggregates MIN(rank)/COUNT(DISTINCT seed)/COUNT(DISTINCT storefront)/MAX(seen_at) across kept hints only", async () => {
      await insertAutocompleteHints([
        { seed: "zzz-hint-seed-a", term: "zzz-hint-evidence-term", rank: 3, seenAt: SEEN_AT - 100, kept: true, storefront: "us" },
        { seed: "zzz-hint-seed-b", term: "zzz-hint-evidence-term", rank: 1, seenAt: SEEN_AT, kept: true, storefront: "gb" },
        // A filtered-out (kept=false) row for the SAME term must NOT count
        // toward presence, even though it has a lower rank.
        { seed: "zzz-hint-seed-c", term: "zzz-hint-evidence-term", rank: 0, seenAt: SEEN_AT, kept: false, storefront: "us" },
      ]);

      const evidence = await getHintEvidence(["zzz-hint-evidence-term"]);
      const e = evidence.get("zzz-hint-evidence-term");
      expect(e?.bestRank).toBe(1); // the kept=true min, not the kept=false rank 0
      expect(e?.seedCount).toBe(2);
      expect(e?.storefrontCount).toBe(2);
      expect(e?.lastSeenAt).toBe(SEEN_AT);
      expect(e?.covered).toBe(true); // presence trivially implies coverage
    });

    it("marks a keyword as covered when a queried PREFIX of it (bare seed) was issued, even with zero hint presence", async () => {
      await insertAutocompleteHints([
        // "zzz-hint-coverage-seed" was queried, but never returned this
        // specific longer phrase as a hint.
        { seed: "zzz-hint-coverage-seed", term: "zzz-hint-coverage-seed unrelated", rank: 0, seenAt: SEEN_AT, kept: true },
      ]);

      const evidence = await getHintEvidence(["zzz-hint-coverage-seed extra words"]);
      const e = evidence.get("zzz-hint-coverage-seed extra words");
      expect(e?.seedCount).toBe(0);
      expect(e?.bestRank).toBeNull();
      expect(e?.covered).toBe(true);
    });

    it("marks a keyword as NOT covered when neither it nor any prefix of it was ever queried", async () => {
      const evidence = await getHintEvidence(["zzz-hint-never-queried-anything"]);
      const e = evidence.get("zzz-hint-never-queried-anything");
      expect(e?.seedCount).toBe(0);
      expect(e?.covered).toBe(false);
    });

    it("excludes hints outside the lookback window", async () => {
      const old = SEEN_AT - 400 * 86_400; // 400 days ago
      await insertAutocompleteHints([
        { seed: "zzz-hint-stale-seed", term: "zzz-hint-stale-term", rank: 0, seenAt: old, kept: true },
      ]);

      const evidence = await getHintEvidence(["zzz-hint-stale-term"], 30);
      const e = evidence.get("zzz-hint-stale-term");
      expect(e?.seedCount).toBe(0);
      // The seed itself was queried, but 400 days ago — outside a 30d
      // window, so coverage (like presence) reads as unknown, not confirmed.
      expect(e?.covered).toBe(false);
    });

    it("returns an empty map for an empty keyword list", async () => {
      const evidence = await getHintEvidence([]);
      expect(evidence.size).toBe(0);
    });
  });

  describe("pruneAutocompleteHints", () => {
    it("deletes rows older than the retention window and keeps newer ones", async () => {
      const now = Math.floor(Date.now() / 1000);
      const old = now - 200 * 86_400;
      await insertAutocompleteHints([
        { seed: "zzz-hint-prune-old", term: "zzz-hint-prune-old-term", rank: 0, seenAt: old, kept: true },
        { seed: "zzz-hint-prune-new", term: "zzz-hint-prune-new-term", rank: 0, seenAt: now, kept: true },
      ]);

      const pruned = await pruneAutocompleteHints(90);
      expect(pruned).toBeGreaterThanOrEqual(1);

      const db = getDb();
      const remaining = await db`
        SELECT seed FROM appstore_autocomplete_hints
        WHERE seed IN ('zzz-hint-prune-old', 'zzz-hint-prune-new')
      `;
      const seeds = (remaining as ReadonlyArray<{ seed: string }>).map((r) => r.seed);
      expect(seeds).not.toContain("zzz-hint-prune-old");
      expect(seeds).toContain("zzz-hint-prune-new");
    });
  });

  describe("getScannedAppNames", () => {
    // Nonce app names embedded in a seeded scan's `top_apps` JSON payload —
    // distinct enough not to collide with the shared DB's real scan history.
    const FIXTURE_APP_NAMES = ["Zzz Scanned App Alpha", "Zzz Scanned App Beta"] as const;

    function fixtureTopApp(name: string, id: string): TopApp {
      return makeTopApp({ id, name });
    }

    it("returns distinct app names embedded in a seeded scan's top_apps payload", async () => {
      await upsertKeywords([
        { keyword: "zzz-scanned-app-names-fixture", genreZone: "health", source: "seed" },
      ]);
      await insertScan(
        makeScan({
          keyword: "zzz-scanned-app-names-fixture",
          // Far in the future so this row sorts first under the
          // `ORDER BY scanned_at DESC` recency window regardless of how
          // much real, concurrently-scraped scan history already exists in
          // this shared DB.
          scannedAt: Math.floor(Date.now() / 1000) + 2_000_000,
          topApps: [
            fixtureTopApp(FIXTURE_APP_NAMES[0], "zzz-scanned-app-1"),
            fixtureTopApp(FIXTURE_APP_NAMES[1], "zzz-scanned-app-2"),
            // Duplicate name (different id) — the DISTINCT should collapse it.
            fixtureTopApp(FIXTURE_APP_NAMES[0], "zzz-scanned-app-3"),
          ],
        }),
      );

      const names = await getScannedAppNames(100_000);
      expect(names).toContain(FIXTURE_APP_NAMES[0]);
      expect(names).toContain(FIXTURE_APP_NAMES[1]);
      // Distinct — the duplicate-name entry didn't produce a second copy.
      expect(names.filter((n) => n === FIXTURE_APP_NAMES[0]).length).toBe(1);
    });

    it("returns an empty array when limit is non-positive", async () => {
      const names = await getScannedAppNames(0);
      expect(names).toEqual([]);
    });

    it("bounds the distinct names returned to the given limit", async () => {
      const names = await getScannedAppNames(1);
      expect(names.length).toBeLessThanOrEqual(1);
    });
  });

  describe("buildability", () => {
    it("drift guard: the SQL-computed buildability on every returned row matches computeBuildability within rounding tolerance", async () => {
      const now = Math.floor(Date.now() / 1000);
      const zone = "zzz-build-drift-zone";
      await upsertKeywords([
        { keyword: "zzz-build-drift-high", genreZone: zone, source: "seed" },
        { keyword: "zzz-build-drift-zero", genreZone: zone, source: "seed" },
      ]);
      // High buildability: strong demand, a weak (few-review, low-rated) leader.
      await insertScan(
        makeScan({
          keyword: "zzz-build-drift-high",
          demand: 200,
          topAppReviews: 10,
          avgRating: 2.0,
          scannedAt: now,
        }),
      );
      // Zero buildability: no demand at all.
      await insertScan(
        makeScan({
          keyword: "zzz-build-drift-zero",
          demand: 0,
          topAppReviews: 100,
          avgRating: 3.0,
          scannedAt: now,
        }),
      );

      const top = await getTopOpportunities({ limit: 50, genreZone: zone });
      const rows = top.rows.filter((r) =>
        ["zzz-build-drift-high", "zzz-build-drift-zero"].includes(r.keyword),
      );
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        const expected = computeBuildability({
          demand: row.demand,
          topAppReviews: row.topAppReviews,
          avgRating: row.avgRating,
        });
        expect(Math.abs(row.buildability - expected)).toBeLessThanOrEqual(1);
      }

      const high = rows.find((r) => r.keyword === "zzz-build-drift-high");
      const zero = rows.find((r) => r.keyword === "zzz-build-drift-zero");
      expect(high?.buildability).toBeGreaterThan(70);
      expect(zero?.buildability).toBe(0);
    });

    it("sorts by buildability ascending and descending", async () => {
      const now = Math.floor(Date.now() / 1000);
      const zone = "zzz-build-sort-zone";
      await upsertKeywords([
        { keyword: "zzz-build-sort-a", genreZone: zone, source: "seed" },
        { keyword: "zzz-build-sort-b", genreZone: zone, source: "seed" },
        { keyword: "zzz-build-sort-c", genreZone: zone, source: "seed" },
      ]);
      // a: lowest buildability (no demand). b: highest (strong demand, weak
      // incumbent). c: mid (moderate demand, moderate incumbent).
      await insertScan(
        makeScan({
          keyword: "zzz-build-sort-a",
          demand: 0,
          topAppReviews: 100,
          avgRating: 3.0,
          scannedAt: now,
        }),
      );
      await insertScan(
        makeScan({
          keyword: "zzz-build-sort-b",
          demand: 200,
          topAppReviews: 10,
          avgRating: 2.0,
          scannedAt: now,
        }),
      );
      await insertScan(
        makeScan({
          keyword: "zzz-build-sort-c",
          demand: 10,
          topAppReviews: 500,
          avgRating: 3.5,
          scannedAt: now,
        }),
      );

      const asc = await getTopOpportunities({
        limit: 50,
        genreZone: zone,
        sort: "buildability",
        dir: "asc",
      });
      expect(asc.rows.map((r) => r.keyword)).toEqual([
        "zzz-build-sort-a",
        "zzz-build-sort-c",
        "zzz-build-sort-b",
      ]);

      const desc = await getTopOpportunities({
        limit: 50,
        genreZone: zone,
        sort: "buildability",
        dir: "desc",
      });
      expect(desc.rows.map((r) => r.keyword)).toEqual([
        "zzz-build-sort-b",
        "zzz-build-sort-c",
        "zzz-build-sort-a",
      ]);
    });

    it("bounds by minBuildability, and total reflects the filtered count", async () => {
      const now = Math.floor(Date.now() / 1000);
      const zone = "zzz-build-filter-zone";
      await upsertKeywords([
        { keyword: "zzz-build-filter-high", genreZone: zone, source: "seed" },
        { keyword: "zzz-build-filter-low", genreZone: zone, source: "seed" },
      ]);
      await insertScan(
        makeScan({
          keyword: "zzz-build-filter-high",
          demand: 200,
          topAppReviews: 10,
          avgRating: 2.0,
          scannedAt: now,
        }),
      );
      await insertScan(
        makeScan({
          keyword: "zzz-build-filter-low",
          demand: 0,
          topAppReviews: 100,
          avgRating: 3.0,
          scannedAt: now,
        }),
      );

      const top = await getTopOpportunities({ limit: 50, genreZone: zone, minBuildability: 50 });
      const keywords = top.rows.map((r) => r.keyword);
      expect(keywords).toContain("zzz-build-filter-high");
      expect(keywords).not.toContain("zzz-build-filter-low");
      expect(top.total).toBe(1);
    });
  });

  describe("getStaleKeywordsTiered", () => {
    it("prioritizes a stale manual keyword and a stale seed keyword into tier 1", async () => {
      const now = Math.floor(Date.now() / 1000);
      await upsertKeywords([
        { keyword: "zzz-tier1-manual-stale", genreZone: "zzz-tier-zone", source: "manual" },
        { keyword: "zzz-tier1-seed-never-scanned", genreZone: "zzz-tier-zone", source: "seed" },
      ]);
      // Scanned far in the past (not just >24h ago) so it reliably sorts at
      // the very front of tier 1's own stalest-first ordering regardless of
      // how many other real manual/seed keywords are also stale — see the
      // `getStaleKeywordsAcrossZones` test above for why "ancient" beats a
      // large `LIMIT` as corpus size grows over time.
      await markScanned(["zzz-tier1-manual-stale"], now - 100_000_000);
      // zzz-tier1-seed-never-scanned is left with last_scanned_at = NULL.

      const stale = keywordsOf(
        await getStaleKeywordsTiered({
          batchLimit: 100_000,
          mineQuotaRemaining: 0,
          tier1StaleThresholdMs: TIER1_STALE_THRESHOLD_MS,
          perSweepCap: UNLIMITED_PER_SWEEP_CAP,
          tier1AutocompleteCap: UNLIMITED_TIER1_AUTOCOMPLETE_CAP,
        }),
      );
      expect(stale).toContain("zzz-tier1-manual-stale");
      expect(stale).toContain("zzz-tier1-seed-never-scanned");
    });

    it("prioritizes a stale autocomplete keyword into tier 1 (2026-07-21 retune)", async () => {
      const now = Math.floor(Date.now() / 1000);
      await upsertKeywords([
        { keyword: "zzz-tier1-autocomplete-stale", genreZone: "zzz-tier-zone", source: "autocomplete" },
      ]);
      await markScanned(["zzz-tier1-autocomplete-stale"], now - 100_000_000);

      const stale = keywordsOf(
        await getStaleKeywordsTiered({
          batchLimit: 100_000,
          mineQuotaRemaining: 0,
          tier1StaleThresholdMs: TIER1_STALE_THRESHOLD_MS,
          perSweepCap: UNLIMITED_PER_SWEEP_CAP,
          tier1AutocompleteCap: UNLIMITED_TIER1_AUTOCOMPLETE_CAP,
        }),
      );
      expect(stale).toContain("zzz-tier1-autocomplete-stale");
    });

    it("does NOT prioritize a fresh (recently-scanned) manual keyword into a small batch", async () => {
      const now = Math.floor(Date.now() / 1000);
      const decoys = Array.from({ length: 10 }, (_, i) => `zzz-tier1-fresh-decoy-${i}`);
      await upsertKeywords([
        { keyword: "zzz-tier1-manual-fresh", genreZone: "zzz-tier-zone", source: "manual" },
        ...decoys.map((keyword) => ({ keyword, genreZone: "zzz-tier-zone", source: "mined" as const })),
      ]);
      // 1h ago — comfortably fresh (well inside the 24h threshold, not a
      // tight race against it).
      await markScanned(["zzz-tier1-manual-fresh"], now - 3_600);
      // 48h ago — comfortably stale (well past the 24h threshold), and
      // structurally tier-1-INELIGIBLE (mined, no signature hit), so these
      // can only ever surface via the mined-exploration quota — exactly the
      // competition that quota needs to fill its slots ahead of the fresh
      // keyword.
      //
      // These decoys are NOT just a safety margin: without them, this test
      // only passes when the shared `appstore_keywords` table already has
      // enough OTHER stale mined rows to fill the small `LIMIT` ahead of the
      // lone fresh fixture — true against a real dev DB (100k+ accumulated
      // rows) but false against a freshly-migrated, empty CI Postgres. Self-
      // supplied decoys make this deterministic regardless of ambient corpus
      // size (see PR #321 CI failure).
      await markScanned(decoys, now - 172_800);

      // A fresh (just-scanned) keyword fails the tier-1 staleness predicate
      // outright, so it can only appear via the mined-exploration fallback —
      // and having just been scanned, it is one of the FRESHEST keywords in
      // the whole corpus, so a small batch (stalest-first) should never reach
      // it. (See keyword-tiering.test.ts's `isTier1Eligible` unit tests for
      // the exhaustive, DB-independent coverage of the staleness predicate
      // itself — this integration test only confirms the SQL wiring.) A
      // generous `mineQuotaRemaining` lets the mined decoys fill the batch.
      const smallSlice = keywordsOf(
        await getStaleKeywordsTiered({
          batchLimit: 5,
          mineQuotaRemaining: 100_000,
          tier1StaleThresholdMs: TIER1_STALE_THRESHOLD_MS,
          perSweepCap: UNLIMITED_PER_SWEEP_CAP,
          tier1AutocompleteCap: UNLIMITED_TIER1_AUTOCOMPLETE_CAP,
        }),
      );
      expect(smallSlice).not.toContain("zzz-tier1-manual-fresh");
    });

    it("prioritizes a stale keyword with a signature hit regardless of source, even without mined quota", async () => {
      const now = Math.floor(Date.now() / 1000);
      const db = getDb();
      await upsertKeywords([
        { keyword: "zzz-tier1-signature-hit", genreZone: "zzz-tier-zone", source: "mined" },
      ]);
      await markScanned(["zzz-tier1-signature-hit"], now - 100_000_000);
      await db`
        INSERT INTO appstore_signature_hits (keyword, first_detected_at, last_seen_at, status)
        VALUES ('zzz-tier1-signature-hit', ${now}, ${now}, 'active')
      `;

      // mineQuotaRemaining: 0 — a signature-hit keyword must reach tier 1
      // regardless of source, NEVER through the mined-exploration path.
      const stale = keywordsOf(
        await getStaleKeywordsTiered({
          batchLimit: 100_000,
          mineQuotaRemaining: 0,
          tier1StaleThresholdMs: TIER1_STALE_THRESHOLD_MS,
          perSweepCap: UNLIMITED_PER_SWEEP_CAP,
          tier1AutocompleteCap: UNLIMITED_TIER1_AUTOCOMPLETE_CAP,
        }),
      );
      expect(stale).toContain("zzz-tier1-signature-hit");
    });

    it("does NOT prioritize a mined keyword with no signature hit into tier 1 — only reachable via mined quota", async () => {
      const now = Math.floor(Date.now() / 1000);
      await upsertKeywords([
        { keyword: "zzz-tier2-mined-stale", genreZone: "zzz-tier-zone", source: "mined" },
      ]);
      await markScanned(["zzz-tier2-mined-stale"], now - 100_000_000);

      // No mined quota at all: a plain mined keyword must NOT appear.
      const noQuota = keywordsOf(
        await getStaleKeywordsTiered({
          batchLimit: 100_000,
          mineQuotaRemaining: 0,
          tier1StaleThresholdMs: TIER1_STALE_THRESHOLD_MS,
          perSweepCap: UNLIMITED_PER_SWEEP_CAP,
          tier1AutocompleteCap: UNLIMITED_TIER1_AUTOCOMPLETE_CAP,
        }),
      );
      expect(noQuota).not.toContain("zzz-tier2-mined-stale");

      // With quota, it becomes reachable via mined exploration.
      const withQuota = keywordsOf(
        await getStaleKeywordsTiered({
          batchLimit: 100_000,
          mineQuotaRemaining: 100_000,
          tier1StaleThresholdMs: TIER1_STALE_THRESHOLD_MS,
          perSweepCap: UNLIMITED_PER_SWEEP_CAP,
          tier1AutocompleteCap: UNLIMITED_TIER1_AUTOCOMPLETE_CAP,
        }),
      );
      expect(withQuota).toContain("zzz-tier2-mined-stale");
    });

    it("tier 1 is UNCAPPED (2026-07-21 retune): every eligible keyword fits, even in a batch smaller than the old fraction cap would have allowed", async () => {
      const now = Math.floor(Date.now() / 1000);
      await upsertKeywords([
        { keyword: "zzz-tier1-cap-manual-a", genreZone: "zzz-tier-cap-zone", source: "manual" },
        { keyword: "zzz-tier1-cap-manual-b", genreZone: "zzz-tier-cap-zone", source: "manual" },
        { keyword: "zzz-tier1-cap-manual-c", genreZone: "zzz-tier-cap-zone", source: "manual" },
      ]);
      // Ancient timestamp (see the ancient-vs-large-limit note on the
      // `getStaleKeywordsAcrossZones` test above) so these three reliably
      // sort ahead of any other real, ALREADY-SCANNED manual/seed/
      // autocomplete keyword in this shared DB — a merely-"2 days stale"
      // timestamp previously lost a batchLimit-3 race to real corpus rows.
      // NULLS FIRST still beats even an ancient non-null timestamp, though:
      // the live autocomplete-expansion pass continuously adds brand-new
      // tier-1-eligible keywords with `last_scanned_at IS NULL` that haven't
      // had their first sweep pass yet (observed live: ~4 at any moment,
      // scanned away again within about a minute) — a `batchLimit` of
      // exactly 3 previously lost to that transient NULL backlog too.
      await markScanned(
        ["zzz-tier1-cap-manual-a", "zzz-tier1-cap-manual-b", "zzz-tier1-cap-manual-c"],
        now - 100_000_000,
      );

      // Under the OLD 30%-fraction cap, a batch of 50 would floor to
      // tier1Cap = floor(50 * 0.3) = 15 — comfortably tight enough that the
      // OLD code would drop these 3 the moment more than ~12 other stale/
      // never-scanned tier-1-eligible keywords existed live. The retune
      // removed that cap entirely: all 3 must now fit regardless of how many
      // other tier-1-eligible keywords are also due. `batchLimit` bumped
      // from 50 to a generous value (2026-07-21 audit item A hot-lane
      // addition): the hot lane now competes for the SAME batch ahead of
      // tier 1 and is itself capped at `HOT_LANE_MAX_BATCH` (50) — this
      // shared, continuously-scraped dev DB has 275+ real signature-hit
      // keywords stale enough to fill that whole 50-slot hot-lane cap on its
      // own, which would leave a `batchLimit: 50` test with ZERO room left
      // for tier 1 purely from live hot-lane competition, unrelated to
      // tier-1's own uncapped-ness. A large batchLimit keeps this test about
      // tier 1's lack of a fraction cap, not a collision with the hot lane's
      // separate, intentional cap.
      const tinyBatch = keywordsOf(
        await getStaleKeywordsTiered({
          batchLimit: 100_000,
          mineQuotaRemaining: 0,
          tier1StaleThresholdMs: TIER1_STALE_THRESHOLD_MS,
          perSweepCap: UNLIMITED_PER_SWEEP_CAP,
          tier1AutocompleteCap: UNLIMITED_TIER1_AUTOCOMPLETE_CAP,
        }),
      );
      expect(tinyBatch).toContain("zzz-tier1-cap-manual-a");
      expect(tinyBatch).toContain("zzz-tier1-cap-manual-b");
      expect(tinyBatch).toContain("zzz-tier1-cap-manual-c");
    });

    it("mined exploration respects mineQuotaRemaining even when batch slots are available", async () => {
      const now = Math.floor(Date.now() / 1000);
      await upsertKeywords([
        { keyword: "zzz-mine-quota-a", genreZone: "zzz-mine-quota-zone", source: "mined" },
        { keyword: "zzz-mine-quota-b", genreZone: "zzz-mine-quota-zone", source: "mined" },
        { keyword: "zzz-mine-quota-c", genreZone: "zzz-mine-quota-zone", source: "mined" },
      ]);
      await markScanned(
        ["zzz-mine-quota-a", "zzz-mine-quota-b", "zzz-mine-quota-c"],
        now - 100_000_000,
      );

      // Plenty of batch room (50), but the mined quota is exhausted for the
      // day — none of these mined-only keywords should be drawn.
      const exhausted = keywordsOf(
        await getStaleKeywordsTiered({
          batchLimit: 50,
          mineQuotaRemaining: 0,
          tier1StaleThresholdMs: TIER1_STALE_THRESHOLD_MS,
          perSweepCap: UNLIMITED_PER_SWEEP_CAP,
          tier1AutocompleteCap: UNLIMITED_TIER1_AUTOCOMPLETE_CAP,
        }),
      );
      expect(exhausted).not.toContain("zzz-mine-quota-a");
      expect(exhausted).not.toContain("zzz-mine-quota-b");
      expect(exhausted).not.toContain("zzz-mine-quota-c");

      // Quota of exactly 1: at most 1 of the three eligible mined keywords
      // may be drawn.
      const capped = keywordsOf(
        await getStaleKeywordsTiered({
          batchLimit: 50,
          mineQuotaRemaining: 1,
          tier1StaleThresholdMs: TIER1_STALE_THRESHOLD_MS,
          perSweepCap: UNLIMITED_PER_SWEEP_CAP,
          tier1AutocompleteCap: UNLIMITED_TIER1_AUTOCOMPLETE_CAP,
        }),
      );
      const capturedCount = ["zzz-mine-quota-a", "zzz-mine-quota-b", "zzz-mine-quota-c"].filter(
        (k) => capped.includes(k),
      ).length;
      expect(capturedCount).toBeLessThanOrEqual(1);
    });

    it("perSweepCap bounds mined slots even when batchLimit and mineQuotaRemaining are both generous (2026-07-21 audit item A)", async () => {
      const now = Math.floor(Date.now() / 1000);
      await upsertKeywords([
        { keyword: "zzz-per-sweep-cap-a", genreZone: "zzz-per-sweep-cap-zone", source: "mined" },
        { keyword: "zzz-per-sweep-cap-b", genreZone: "zzz-per-sweep-cap-zone", source: "mined" },
        { keyword: "zzz-per-sweep-cap-c", genreZone: "zzz-per-sweep-cap-zone", source: "mined" },
      ]);
      await markScanned(
        ["zzz-per-sweep-cap-a", "zzz-per-sweep-cap-b", "zzz-per-sweep-cap-c"],
        now - 100_000_000,
      );

      // Generous batch room AND generous rolling daily quota — only the tight
      // perSweepCap (1) should bound how many of these three are drawn this
      // sweep, proving the per-sweep slice is enforced independently of the
      // other two ceilings (see `computeMineSlots`'s unit tests in
      // keyword-tiering.test.ts for the pure-math coverage; this integration
      // test confirms the SQL wiring honors the same cap).
      const capped = keywordsOf(
        await getStaleKeywordsTiered({
          batchLimit: 100_000,
          mineQuotaRemaining: 100_000,
          tier1StaleThresholdMs: TIER1_STALE_THRESHOLD_MS,
          perSweepCap: 1,
          tier1AutocompleteCap: UNLIMITED_TIER1_AUTOCOMPLETE_CAP,
        }),
      );
      const capturedCount = [
        "zzz-per-sweep-cap-a",
        "zzz-per-sweep-cap-b",
        "zzz-per-sweep-cap-c",
      ].filter((k) => capped.includes(k)).length;
      expect(capturedCount).toBeLessThanOrEqual(1);
    });

    it("hot lane (open signature hit, stale >6h) preempts plain tier-1/mined slots in output ordering (2026-07-21 audit item A)", async () => {
      const db = getDb();
      const now = Math.floor(Date.now() / 1000);

      // Hot-lane fixture: `source: "mined"` (NOT tier-1-eligible by source
      // alone) with an active signature hit, stale well past the hot lane's
      // 6h threshold. Ancient (not just-past-6h) is deliberate: this shared,
      // continuously-scraped dev DB has 275+ REAL signature-hit keywords
      // already stale by >6h at any given moment (live-measured 2026-07-21),
      // comfortably filling the hot lane's own LIMIT-50 cap on their own — a
      // fixture merely "7h stale" reliably loses that race to real, staler
      // competitors. An ancient timestamp reliably wins the `ORDER BY
      // last_scanned_at ASC` race against them instead (same "ancient beats
      // a large LIMIT" idiom used elsewhere in this file for tier 1/mined —
      // see the `getStaleKeywordsAcrossZones` test above). Being ancient
      // also independently clears tier 1's OWN signature-hit threshold, but
      // that doesn't undermine this test: the point being proved is
      // PREEMPTION (hot lane claims it before tier 1 gets a chance — tier
      // 1's query explicitly excludes already hot-claimed keywords), not
      // staleness-window exclusivity (see the dedicated "does NOT reach the
      // hot lane merely by being stale" test below for that).
      await upsertKeywords([
        { keyword: "zzz-hot-lane-open-hit", genreZone: "zzz-hot-lane-zone", source: "mined" },
        { keyword: "zzz-hot-lane-tier1-decoy", genreZone: "zzz-hot-lane-zone", source: "manual" },
        { keyword: "zzz-hot-lane-mined-decoy", genreZone: "zzz-hot-lane-zone", source: "mined" },
      ]);
      await markScanned(["zzz-hot-lane-open-hit"], now - 100_000_000);
      // Ancient — comfortably tier-1-eligible (manual source) and comfortably
      // eligible for the mined-exploration quota, so both decoys reliably
      // appear in a generous-batch pull alongside the hot fixture.
      await markScanned(
        ["zzz-hot-lane-tier1-decoy", "zzz-hot-lane-mined-decoy"],
        now - 100_000_000,
      );
      await db`
        INSERT INTO appstore_signature_hits (keyword, first_detected_at, last_seen_at, status)
        VALUES ('zzz-hot-lane-open-hit', ${now}, ${now}, 'active')
      `;

      const result = keywordsOf(
        await getStaleKeywordsTiered({
          batchLimit: 100_000,
          mineQuotaRemaining: 100_000,
          tier1StaleThresholdMs: TIER1_STALE_THRESHOLD_MS,
          perSweepCap: UNLIMITED_PER_SWEEP_CAP,
          tier1AutocompleteCap: UNLIMITED_TIER1_AUTOCOMPLETE_CAP,
        }),
      );

      expect(result).toContain("zzz-hot-lane-open-hit");
      expect(result).toContain("zzz-hot-lane-tier1-decoy");
      expect(result).toContain("zzz-hot-lane-mined-decoy");

      const hotIndex = result.indexOf("zzz-hot-lane-open-hit");
      const tier1Index = result.indexOf("zzz-hot-lane-tier1-decoy");
      const minedIndex = result.indexOf("zzz-hot-lane-mined-decoy");
      expect(hotIndex).toBeLessThan(tier1Index);
      expect(hotIndex).toBeLessThan(minedIndex);
    });

    it("does NOT reach the hot lane merely by being stale — an active signature hit is required", async () => {
      const now = Math.floor(Date.now() / 1000);
      await upsertKeywords([
        { keyword: "zzz-hot-lane-mined-decoy", genreZone: "zzz-hot-lane-zone", source: "mined" },
      ]);
      // 7h stale — past the hot lane's threshold — but no signature_hits row
      // at all, so it must NOT be reachable without mined quota.
      await markScanned(["zzz-hot-lane-mined-decoy"], now - 7 * 60 * 60);

      const withoutQuota = keywordsOf(
        await getStaleKeywordsTiered({
          batchLimit: 100_000,
          mineQuotaRemaining: 0,
          tier1StaleThresholdMs: TIER1_STALE_THRESHOLD_MS,
          perSweepCap: UNLIMITED_PER_SWEEP_CAP,
          tier1AutocompleteCap: UNLIMITED_TIER1_AUTOCOMPLETE_CAP,
        }),
      );
      expect(withoutQuota).not.toContain("zzz-hot-lane-mined-decoy");
    });

    // Batch A budget rescue (2026-07-22) — structural guard: autocomplete no
    // longer competes UNCAPPED in the guaranteed tier-1 lane the way
    // manual/seed do.
    it("tier1AutocompleteCap bounds how many autocomplete keywords tier 1 draws per sweep, even with generous batch room", async () => {
      const now = Math.floor(Date.now() / 1000);
      const autocompleteKeywords = Array.from(
        { length: 5 },
        (_, i) => `zzz-tier1-ac-cap-${i}`,
      );
      await upsertKeywords(
        autocompleteKeywords.map((keyword) => ({
          keyword,
          genreZone: "zzz-tier1-ac-cap-zone",
          source: "autocomplete" as const,
        })),
      );
      // Ancient — reliably stale under every band, so the cap (not
      // staleness) is what's under test.
      await markScanned(autocompleteKeywords, now - 100_000_000);

      const capped = keywordsOf(
        await getStaleKeywordsTiered({
          batchLimit: 100_000,
          mineQuotaRemaining: 0,
          tier1StaleThresholdMs: TIER1_STALE_THRESHOLD_MS,
          perSweepCap: UNLIMITED_PER_SWEEP_CAP,
          tier1AutocompleteCap: 2,
        }),
      );
      const capturedCount = autocompleteKeywords.filter((k) => capped.includes(k)).length;
      expect(capturedCount).toBeLessThanOrEqual(2);
    });

    it("the autocomplete cap never crowds out manual/seed keywords — those stay uncapped", async () => {
      const now = Math.floor(Date.now() / 1000);
      await upsertKeywords([
        { keyword: "zzz-tier1-ac-cap-manual-decoy", genreZone: "zzz-tier1-ac-cap-zone", source: "manual" },
        { keyword: "zzz-tier1-ac-cap-seed-decoy", genreZone: "zzz-tier1-ac-cap-zone", source: "seed" },
        { keyword: "zzz-tier1-ac-cap-autocomplete", genreZone: "zzz-tier1-ac-cap-zone", source: "autocomplete" },
      ]);
      await markScanned(
        [
          "zzz-tier1-ac-cap-manual-decoy",
          "zzz-tier1-ac-cap-seed-decoy",
          "zzz-tier1-ac-cap-autocomplete",
        ],
        now - 100_000_000,
      );

      // Cap of 0 — NO autocomplete keyword may be drawn this sweep, but
      // manual/seed must still come through untouched.
      const result = keywordsOf(
        await getStaleKeywordsTiered({
          batchLimit: 100_000,
          mineQuotaRemaining: 0,
          tier1StaleThresholdMs: TIER1_STALE_THRESHOLD_MS,
          perSweepCap: UNLIMITED_PER_SWEEP_CAP,
          tier1AutocompleteCap: 0,
        }),
      );
      expect(result).toContain("zzz-tier1-ac-cap-manual-decoy");
      expect(result).toContain("zzz-tier1-ac-cap-seed-decoy");
      expect(result).not.toContain("zzz-tier1-ac-cap-autocomplete");
    });
  });

  describe("countMinedScansSince", () => {
    it("counts only source: 'mined' scans recorded at or after the given epoch", async () => {
      const now = Math.floor(Date.now() / 1000);
      await upsertKeywords([
        { keyword: "zzz-mined-scan-count-mined", genreZone: "zzz-mined-count-zone", source: "mined" },
        { keyword: "zzz-mined-scan-count-seed", genreZone: "zzz-mined-count-zone", source: "seed" },
      ]);

      const before = await countMinedScansSince(now - 10);
      await insertScan(makeScan({ keyword: "zzz-mined-scan-count-mined", scannedAt: now }));
      await insertScan(makeScan({ keyword: "zzz-mined-scan-count-seed", scannedAt: now }));
      const after = await countMinedScansSince(now - 10);

      // Only the mined-source scan should count toward the delta — tolerant
      // of other real activity landing scans in this shared DB concurrently.
      expect(after).toBeGreaterThanOrEqual(before + 1);
    });
  });

  describe("getMinedDeactivationStats", () => {
    it("reports scan count, max demand ever, and signature-hit presence for a keyword", async () => {
      const now = Math.floor(Date.now() / 1000);
      const db = getDb();
      await upsertKeywords([
        { keyword: "zzz-mined-stats-fixture", genreZone: "zzz-mined-stats-zone", source: "mined" },
      ]);
      await insertScan(makeScan({ keyword: "zzz-mined-stats-fixture", demand: 2, scannedAt: now - 200 }));
      await insertScan(makeScan({ keyword: "zzz-mined-stats-fixture", demand: 9, scannedAt: now - 100 }));
      await insertScan(makeScan({ keyword: "zzz-mined-stats-fixture", demand: 1, scannedAt: now }));

      const noHit = await getMinedDeactivationStats("zzz-mined-stats-fixture");
      expect(noHit.scanCount).toBe(3);
      expect(noHit.maxDemand).toBe(9); // MAX across history, not the latest scan's demand (1)
      expect(noHit.hasSignatureHit).toBe(false);

      await db`
        INSERT INTO appstore_signature_hits (keyword, first_detected_at, last_seen_at, status)
        VALUES ('zzz-mined-stats-fixture', ${now}, ${now}, 'dismissed')
      `;
      const withHit = await getMinedDeactivationStats("zzz-mined-stats-fixture");
      // ANY row counts, even a dismissed one — this is a permanent exemption.
      expect(withHit.hasSignatureHit).toBe(true);
    });

    it("returns zeroed stats for a keyword with no scan history", async () => {
      const stats = await getMinedDeactivationStats("zzz-mined-stats-absent");
      expect(stats.scanCount).toBe(0);
      expect(stats.maxDemand).toBe(0);
      expect(stats.hasSignatureHit).toBe(false);
    });
  });

  describe("backfillMinedDeactivation", () => {
    it("deactivates a mined keyword that never reached demand 5, and NEVER touches a signature-hit or non-mined one", async () => {
      const now = Math.floor(Date.now() / 1000);
      const db = getDb();
      await upsertKeywords([
        { keyword: "zzz-backfill-mined-hopeless", genreZone: "zzz-backfill-zone", source: "mined" },
        { keyword: "zzz-backfill-mined-sighit", genreZone: "zzz-backfill-zone", source: "mined" },
        { keyword: "zzz-backfill-manual-protected", genreZone: "zzz-backfill-zone", source: "manual" },
      ]);
      // Hopeless: 2 scans, demand always < 5, no signature hit.
      await insertScan(
        makeScan({ keyword: "zzz-backfill-mined-hopeless", demand: 1, scannedAt: now - 200 }),
      );
      await insertScan(
        makeScan({ keyword: "zzz-backfill-mined-hopeless", demand: 2, scannedAt: now }),
      );
      // Same low-demand shape, but has a signature hit — must be exempt.
      await insertScan(
        makeScan({ keyword: "zzz-backfill-mined-sighit", demand: 1, scannedAt: now - 200 }),
      );
      await insertScan(
        makeScan({ keyword: "zzz-backfill-mined-sighit", demand: 1, scannedAt: now }),
      );
      await db`
        INSERT INTO appstore_signature_hits (keyword, first_detected_at, last_seen_at, status)
        VALUES ('zzz-backfill-mined-sighit', ${now}, ${now}, 'dismissed')
      `;
      // Same low-demand shape, but source is 'manual' — protected outright.
      await insertScan(
        makeScan({ keyword: "zzz-backfill-manual-protected", demand: 1, scannedAt: now - 200 }),
      );
      await insertScan(
        makeScan({ keyword: "zzz-backfill-manual-protected", demand: 1, scannedAt: now }),
      );

      await backfillMinedDeactivation();

      const rows = await db`
        SELECT keyword, active FROM appstore_keywords
        WHERE keyword IN ('zzz-backfill-mined-hopeless', 'zzz-backfill-mined-sighit', 'zzz-backfill-manual-protected')
      `;
      const byKeyword = new Map(
        (rows as ReadonlyArray<{ keyword: string; active: boolean }>).map((r) => [r.keyword, r.active]),
      );
      expect(byKeyword.get("zzz-backfill-mined-hopeless")).toBe(false);
      expect(byKeyword.get("zzz-backfill-mined-sighit")).toBe(true);
      expect(byKeyword.get("zzz-backfill-manual-protected")).toBe(true);
    });

    it("is idempotent — a second call deactivates nothing further for the same keyword", async () => {
      const now = Math.floor(Date.now() / 1000);
      await upsertKeywords([
        { keyword: "zzz-backfill-idempotent", genreZone: "zzz-backfill-zone", source: "mined" },
      ]);
      await insertScan(makeScan({ keyword: "zzz-backfill-idempotent", demand: 0, scannedAt: now - 200 }));
      await insertScan(makeScan({ keyword: "zzz-backfill-idempotent", demand: 0, scannedAt: now }));

      await backfillMinedDeactivation();
      const db = getDb();
      const rows = await db`SELECT active FROM appstore_keywords WHERE keyword = 'zzz-backfill-idempotent'`;
      expect((rows as ReadonlyArray<{ active: boolean }>)[0]?.active).toBe(false);

      // Second call: already inactive, so the WHERE k.active = TRUE clause
      // excludes it — no error, no re-processing.
      await backfillMinedDeactivation();
      const rows2 = await db`SELECT active FROM appstore_keywords WHERE keyword = 'zzz-backfill-idempotent'`;
      expect((rows2 as ReadonlyArray<{ active: boolean }>)[0]?.active).toBe(false);
    });
  });

  describe("getTier1ProtectedKeywords", () => {
    it("returns active seed/manual/autocomplete keywords, excluding mined and inactive rows", async () => {
      const db = getDb();
      await upsertKeywords([
        { keyword: "zzz-de-lane-seed", genreZone: "zzz-de-lane-zone", source: "seed" },
        { keyword: "zzz-de-lane-manual", genreZone: "zzz-de-lane-zone", source: "manual" },
        { keyword: "zzz-de-lane-autocomplete", genreZone: "zzz-de-lane-zone", source: "autocomplete" },
        { keyword: "zzz-de-lane-mined-excluded", genreZone: "zzz-de-lane-zone", source: "mined" },
        { keyword: "zzz-de-lane-inactive", genreZone: "zzz-de-lane-zone", source: "seed" },
      ]);
      await db`UPDATE appstore_keywords SET active = FALSE WHERE keyword = 'zzz-de-lane-inactive'`;

      const protectedKeywords = await getTier1ProtectedKeywords(100_000);
      expect(protectedKeywords).toContain("zzz-de-lane-seed");
      expect(protectedKeywords).toContain("zzz-de-lane-manual");
      expect(protectedKeywords).toContain("zzz-de-lane-autocomplete");
      expect(protectedKeywords).not.toContain("zzz-de-lane-mined-excluded");
      expect(protectedKeywords).not.toContain("zzz-de-lane-inactive");
    });

    // Batch A budget rescue (2026-07-22): the DE lane's resume cursor.
    it("respects `limit`, returning only that many keywords", async () => {
      const keywords = Array.from({ length: 5 }, (_, i) => `zzz-de-chunk-limit-${i}`);
      await upsertKeywords(
        keywords.map((keyword) => ({ keyword, genreZone: "zzz-de-chunk-zone", source: "seed" as const })),
      );

      const chunk = await getTier1ProtectedKeywords(3);
      expect(chunk.length).toBeLessThanOrEqual(3);
    });

    it("orders stalest-by-DE-scan first (NULLS FIRST) — never-DE-scanned keywords sort ahead of DE-scanned ones", async () => {
      const now = Math.floor(Date.now() / 1000);
      await upsertKeywords([
        { keyword: "zzz-de-cursor-old", genreZone: "zzz-de-cursor-zone", source: "seed" },
        { keyword: "zzz-de-cursor-never", genreZone: "zzz-de-cursor-zone", source: "seed" },
      ]);
      await markDeScanned(["zzz-de-cursor-old"], now - 100_000_000);
      // zzz-de-cursor-never is left with last_de_scanned_at = NULL.

      const chunk = await getTier1ProtectedKeywords(100_000);
      const neverIndex = chunk.indexOf("zzz-de-cursor-never");
      const oldIndex = chunk.indexOf("zzz-de-cursor-old");
      expect(neverIndex).toBeGreaterThanOrEqual(0);
      expect(oldIndex).toBeGreaterThanOrEqual(0);
      expect(neverIndex).toBeLessThan(oldIndex);
    });

    it("a keyword DE-scanned MORE RECENTLY than another sorts LATER (resume cursor)", async () => {
      const now = Math.floor(Date.now() / 1000);
      await upsertKeywords([
        { keyword: "zzz-de-cursor-stale", genreZone: "zzz-de-cursor-zone", source: "seed" },
        { keyword: "zzz-de-cursor-fresh", genreZone: "zzz-de-cursor-zone", source: "seed" },
      ]);
      await markDeScanned(["zzz-de-cursor-stale"], now - 100_000_000);
      await markDeScanned(["zzz-de-cursor-fresh"], now);

      const chunk = await getTier1ProtectedKeywords(100_000);
      const staleIndex = chunk.indexOf("zzz-de-cursor-stale");
      const freshIndex = chunk.indexOf("zzz-de-cursor-fresh");
      expect(staleIndex).toBeGreaterThanOrEqual(0);
      expect(freshIndex).toBeGreaterThanOrEqual(0);
      expect(staleIndex).toBeLessThan(freshIndex);
    });
  });

  describe("markDeScanned", () => {
    it("updates last_de_scanned_at for the given keywords, leaving last_scanned_at untouched", async () => {
      const db = getDb();
      const now = Math.floor(Date.now() / 1000);
      await upsertKeywords([
        { keyword: "zzz-mark-de-scanned", genreZone: "zzz-de-cursor-zone", source: "seed" },
      ]);

      await markDeScanned(["zzz-mark-de-scanned"], now);

      const rows = await db`
        SELECT last_de_scanned_at, last_scanned_at FROM appstore_keywords
        WHERE keyword = 'zzz-mark-de-scanned'
      `;
      const row = (rows as ReadonlyArray<{ last_de_scanned_at: number | null; last_scanned_at: number | null }>)[0];
      expect(row?.last_de_scanned_at).toBe(now);
      expect(row?.last_scanned_at).toBeNull();
    });

    it("is a no-op for an empty keyword list", async () => {
      await expect(markDeScanned([], Math.floor(Date.now() / 1000))).resolves.toBeUndefined();
    });
  });

  describe("deactivateJunkKeywords", () => {
    it("deactivates a mined keyword", async () => {
      await upsertKeywords([
        { keyword: "zzz-deactivate-mined", genreZone: "zzz-deactivate-zone", source: "mined" },
      ]);

      const count = await deactivateJunkKeywords(["zzz-deactivate-mined"]);
      expect(count).toBe(1);

      const db = getDb();
      const rows = await db`SELECT active FROM appstore_keywords WHERE keyword = 'zzz-deactivate-mined'`;
      expect((rows as ReadonlyArray<{ active: boolean }>)[0]?.active).toBe(false);
    });

    it("NEVER deactivates source 'manual', even when explicitly listed", async () => {
      await upsertKeywords([
        {
          keyword: "zzz-deactivate-manual-protected",
          genreZone: "zzz-deactivate-zone",
          source: "manual",
        },
      ]);

      const count = await deactivateJunkKeywords(["zzz-deactivate-manual-protected"]);
      expect(count).toBe(0);

      const db = getDb();
      const rows = await db`SELECT active FROM appstore_keywords WHERE keyword = 'zzz-deactivate-manual-protected'`;
      expect((rows as ReadonlyArray<{ active: boolean }>)[0]?.active).toBe(true);
    });

    it("NEVER deactivates source 'seed', even when explicitly listed", async () => {
      await upsertKeywords([
        {
          keyword: "zzz-deactivate-seed-protected",
          genreZone: "zzz-deactivate-zone",
          source: "seed",
        },
      ]);

      const count = await deactivateJunkKeywords(["zzz-deactivate-seed-protected"]);
      expect(count).toBe(0);

      const db = getDb();
      const rows = await db`SELECT active FROM appstore_keywords WHERE keyword = 'zzz-deactivate-seed-protected'`;
      expect((rows as ReadonlyArray<{ active: boolean }>)[0]?.active).toBe(true);
    });

    it("is reversible — flipping active back on undoes it", async () => {
      await upsertKeywords([
        {
          keyword: "zzz-deactivate-already-inactive",
          genreZone: "zzz-deactivate-zone",
          source: "mined",
        },
      ]);
      await deactivateJunkKeywords(["zzz-deactivate-already-inactive"]);

      const db = getDb();
      await db`UPDATE appstore_keywords SET active = TRUE WHERE keyword = 'zzz-deactivate-already-inactive'`;
      const rows = await db`SELECT active FROM appstore_keywords WHERE keyword = 'zzz-deactivate-already-inactive'`;
      expect((rows as ReadonlyArray<{ active: boolean }>)[0]?.active).toBe(true);
    });

    it("returns 0 for an empty input list", async () => {
      const count = await deactivateJunkKeywords([]);
      expect(count).toBe(0);
    });

    it("re-deactivating an already-inactive keyword is a no-op (count 0)", async () => {
      await upsertKeywords([
        { keyword: "zzz-deactivate-mined", genreZone: "zzz-deactivate-zone", source: "mined" },
      ]);
      const first = await deactivateJunkKeywords(["zzz-deactivate-mined"]);
      expect(first).toBe(1);
      const second = await deactivateJunkKeywords(["zzz-deactivate-mined"]);
      expect(second).toBe(0);
    });
  });

  // B3 retention prune. NOTE: `pruneKeywordScans` is GLOBAL by design (no
  // keyword filter) — it deletes ANY row older than the cutoff. These tests
  // stay safe because every fixture row is aged ~200 days back while a 90-day
  // cutoff is used, and all real corpus scans are far newer than 90 days
  // (oldest live scan 2026-07-09). Assertions therefore check the FIXTURE
  // partitions' exact remaining counts and only that at least the fixture
  // overflow was pruned, never an exact global `pruned` total.
  describe("pruneKeywordScans", () => {
    const NINETY_DAYS_SECONDS = 90 * 24 * 60 * 60;
    const OLD_OFFSET_SECONDS = 200 * 24 * 60 * 60; // ~200 days back — well past the 90d cutoff

    async function scanCount(keyword: string): Promise<number> {
      const db = getDb();
      const rows = await db`
        SELECT count(*)::int AS c FROM appstore_keyword_scans WHERE keyword = ${keyword}
      `;
      return Number((rows as ReadonlyArray<{ c: number }>)[0]?.c ?? 0);
    }

    async function insertOldScans(keyword: string, count: number): Promise<void> {
      const db = getDb();
      const base = Math.floor(Date.now() / 1000) - OLD_OFFSET_SECONDS;
      await db`
        INSERT INTO appstore_keyword_scans
          (keyword, store, scanned_at, competitiveness, demand, incumbent_weakness,
           opportunity, trend, top_app_reviews, avg_rating, avg_age_days, top_apps, low_confidence)
        SELECT ${keyword}, 'app', ${base} + g, 20, 13, 0.8, 0.53, 'heating', 11, 3.4, 500,
               '[]'::jsonb, false
        FROM generate_series(1, ${count}) AS g
      `;
    }

    it("keeps every old row when a partition has fewer than the keep-newest guard", async () => {
      await insertOldScans("zzz-prune-age-guarded", 3);

      const { pruned } = await pruneKeywordScans({
        maxAgeSeconds: NINETY_DAYS_SECONDS,
        keepNewestPerKeyword: 200,
        chunkSize: 5_000,
        maxChunks: 1_000,
      });

      // Nothing from this partition can be pruned — 3 < 200-row guard.
      expect(await scanCount("zzz-prune-age-guarded")).toBe(3);
      expect(pruned).toBeGreaterThanOrEqual(0);
    });

    it("prunes old rows beyond the keep-newest guard (chunked) and leaves recent rows untouched", async () => {
      // 205 old rows for one partition; 200 must survive the keep-newest guard.
      await insertOldScans("zzz-prune-age-over-cap", 205);
      // Recent rows (now) for a different keyword — never candidates.
      const nowSec = Math.floor(Date.now() / 1000);
      await insertScan(makeScan({ keyword: "zzz-prune-recent-untouched", scannedAt: nowSec }));
      await insertScan(makeScan({ keyword: "zzz-prune-recent-untouched", scannedAt: nowSec - 1 }));
      await insertScan(makeScan({ keyword: "zzz-prune-recent-untouched", scannedAt: nowSec - 2 }));

      const { pruned } = await pruneKeywordScans({
        maxAgeSeconds: NINETY_DAYS_SECONDS,
        keepNewestPerKeyword: 200,
        chunkSize: 50, // forces multiple chunk-DELETEs for the 5 over-cap rows
        maxChunks: 1_000,
      });

      // Exactly the 5 oldest over-cap rows in this partition are gone; the
      // newest 200 survive. Recent rows for the other keyword are untouched.
      expect(await scanCount("zzz-prune-age-over-cap")).toBe(200);
      expect(await scanCount("zzz-prune-recent-untouched")).toBe(3);
      // At minimum this partition's 5 overflow rows were pruned (global count
      // may be higher only if the DB holds other >90d rows — none do today).
      expect(pruned).toBeGreaterThanOrEqual(5);
    });

    it("clamps keepNewestPerKeyword up to the 200-row floor", async () => {
      // Ask to keep only 1, but the floor forces 200 — so 3 old rows survive.
      await insertOldScans("zzz-prune-age-guarded", 3);

      await pruneKeywordScans({
        maxAgeSeconds: NINETY_DAYS_SECONDS,
        keepNewestPerKeyword: 1,
        chunkSize: 5_000,
        maxChunks: 1_000,
      });

      expect(await scanCount("zzz-prune-age-guarded")).toBe(3);
    });
  });
});
