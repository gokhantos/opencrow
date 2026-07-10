import { describe, expect, it, beforeAll, afterAll, afterEach } from "bun:test";
import { initDb, getDb } from "../../store/db";
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
    expect(top.some((r) => r.keyword === "zzz-gap-test")).toBe(true);
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
      const keywords = top.map((r) => r.keyword);
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
      const keywords = top.map((r) => r.keyword);
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
      const keywords = top.map((r) => r.keyword);
      expect(keywords).toContain("zzz-gap-filter-combo-match");
      expect(keywords).not.toContain("zzz-gap-filter-combo-decoy-trend");
      expect(keywords).not.toContain("zzz-gap-filter-combo-decoy-genre");
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
});
