import { describe, expect, it, beforeAll, afterAll, afterEach } from "bun:test";
import { initDb, getDb } from "../../store/db";
import { computeBuildability } from "./keyword-scoring";
import {
  upsertKeywords,
  getStaleKeywords,
  getStaleKeywordsAcrossZones,
  markScanned,
  insertScan,
  getLatestScan,
  getTopOpportunities,
  getScanHistory,
  getMostRecentScanAt,
  countScansSince,
  getWinnerKeywords,
  keywordsExist,
  getDiverseZoneSample,
  getExpansionSeeds,
  getKeywordMeta,
  getScannedAppNames,
} from "./keyword-store";
import type { KeywordGapProfile, TopApp } from "./keyword-types";

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
];

async function cleanupTestKeywords(): Promise<void> {
  const db = getDb();
  await db`DELETE FROM appstore_keyword_scans WHERE keyword IN ${db(TEST_KEYWORDS)}`;
  await db`DELETE FROM appstore_keywords WHERE keyword IN ${db(TEST_KEYWORDS)}`;
}

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
      // "a" was scanned longer ago than "b" — despite living in a different
      // genre zone, "a" must sort ahead of "b" since the cross-zone query
      // has no genre_zone filter.
      await markScanned(["zzz-cross-zone-stale-a"], now - 500);
      await markScanned(["zzz-cross-zone-stale-b"], now - 100);

      // Large enough limit to include both test rows regardless of how much
      // real seed-corpus data is already loaded into this DB.
      const stale = await getStaleKeywordsAcrossZones(100_000);
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

    const history = await getScanHistory("zzz-gap-history", 2);
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
});
