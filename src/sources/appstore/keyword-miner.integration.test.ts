import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { initDb, getDb } from "../../store/db";
import { mineKeywords } from "./keyword-miner";
import { insertScan } from "./keyword-store";
import { upsertRankings } from "./store";
import type { AppRankingRow } from "./store";
import type { KeywordGapProfile, TopApp } from "./keyword-types";

/**
 * A distinctly-named, unlikely-to-collide fixture app so the mined keywords
 * it produces don't already exist in a shared local corpus (avoiding a
 * false "not added" result from a stale prior run's data).
 */
const TEST_APP_ID = "zzz-miner-test-app-1";
// A `list_type` unique to this test file, so `mineKeywords({ listType })`
// scans ONLY this fixture instead of the whole (potentially large, shared)
// rankings table — keeps the test fast and its assertions deterministic
// regardless of how much other data lives in the local integration DB.
const TEST_LIST_TYPE = "zzz-miner-test-list";
const TEST_KEYWORDS: readonly string[] = [
  "wobblefrobnicator tracker",
  "wobblefrobnicator",
  "tracker",
];

function fixtureRanking(): AppRankingRow {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: TEST_APP_ID,
    name: "Zzzminertestbrand: Wobblefrobnicator Tracker",
    artist: "Zzzminertestbrand Inc",
    category: "Health & Fitness",
    rank: 1,
    list_type: TEST_LIST_TYPE,
    icon_url: "",
    store_url: "",
    description: "",
    price: "Free",
    bundle_id: "",
    release_date: "",
    updated_at: now,
    indexed_at: null,
  };
}

async function cleanup(): Promise<void> {
  const db = getDb();
  await db`DELETE FROM appstore_keywords WHERE keyword IN ${db(TEST_KEYWORDS)}`;
  await db`DELETE FROM appstore_ranking_history WHERE app_id = ${TEST_APP_ID}`;
  await db`DELETE FROM appstore_apps WHERE id = ${TEST_APP_ID}`;
}

describe("keyword-miner integration", () => {
  beforeAll(async () => {
    initDb();
    await cleanup();
    await upsertRankings([fixtureRanking()]);
  });

  afterAll(async () => {
    await cleanup();
  });

  // `scannedAppsLimit: 0` isolates these to the rankings fixture only — the
  // top_apps-derived source (see below) reads from the WHOLE shared
  // `appstore_keyword_scans` table with no `listType`-style filter, so
  // leaving it on its default here would make these counts/assertions
  // non-deterministic against a shared local DB.
  it("mines a new candidate keyword from ranking data and upserts it with source 'mined'", async () => {
    const result = await mineKeywords({
      listType: TEST_LIST_TYPE,
      scannedAppsLimit: 0,
      maxNew: 500,
    });
    expect(result.scanned).toBeGreaterThan(0);
    expect(result.scannedFromRankings).toBeGreaterThan(0);
    expect(result.scannedFromTopApps).toBe(0);
    expect(result.added).toBeGreaterThan(0);

    const db = getDb();
    const rows = await db`
      SELECT source, genre_zone FROM appstore_keywords WHERE keyword = ${"wobblefrobnicator tracker"}
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]?.source).toBe("mined");
    expect(rows[0]?.genre_zone).toBe("health");
  });

  it("does not re-add an already-mined keyword on a second pass", async () => {
    await mineKeywords({ listType: TEST_LIST_TYPE, scannedAppsLimit: 0, maxNew: 500 });

    const db = getDb();
    const rows = await db`
      SELECT keyword FROM appstore_keywords WHERE keyword = ${"wobblefrobnicator tracker"}
    `;
    // Still exactly one row — the second pass deduped against the corpus
    // rather than inserting a duplicate.
    expect(rows.length).toBe(1);
  });

  it("respects maxNew across a batch containing multiple new candidates", async () => {
    const db = getDb();
    await db`DELETE FROM appstore_keywords WHERE keyword IN ${db(TEST_KEYWORDS)}`;

    const result = await mineKeywords({ listType: TEST_LIST_TYPE, scannedAppsLimit: 0, maxNew: 1 });
    expect(result.added).toBeLessThanOrEqual(1);
  });
});

describe("keyword-miner integration — scanned top_apps source", () => {
  // Subject keyword for the seeded scan row itself (unrelated to the
  // candidate keywords its `top_apps` payload yields) — just needs a nonce
  // name for cleanup.
  const SCAN_SOURCE_KEYWORD = "zzz-miner-scan-source-fixture";
  // No colon/dash brand separator and no artist (top_apps carries none), so
  // extraction runs the plain name-only path: tokens
  // [wobblesnizzle, gadget, helper] -> n-grams below.
  const SCAN_SOURCE_APP_NAME = "Wobblesnizzle Gadget Helper";
  const SCAN_SOURCE_CANDIDATE_KEYWORDS: readonly string[] = [
    "wobblesnizzle",
    "wobblesnizzle gadget",
    "gadget",
    "gadget helper",
    "helper",
  ];
  // A `list_type` seeded with no rankings fixture, so `getRankings` returns
  // empty and only the top_apps source can contribute candidates — isolates
  // this describe block's assertions to that source.
  const EMPTY_LIST_TYPE = "zzz-miner-scan-source-empty-list";

  function scanFixtureTopApp(): TopApp {
    return {
      id: "zzz-miner-scan-source-app-1",
      name: SCAN_SOURCE_APP_NAME,
      reviews: 10,
      rating: 4.0,
      ageDays: 100,
      ratingsPerDay: 0.1,
      titleMatch: true,
    };
  }

  function scanFixtureProfile(): KeywordGapProfile {
    return {
      keyword: SCAN_SOURCE_KEYWORD,
      store: "app",
      competitiveness: 10,
      demand: 5,
      incumbentWeakness: 0.5,
      opportunity: 0.3,
      trend: "new",
      topAppReviews: 10,
      avgRating: 4.0,
      avgAgeDays: 100,
      topApps: [scanFixtureTopApp()],
      // Far in the future so this row sorts first under `ORDER BY scanned_at
      // DESC` regardless of how much real, concurrently-scraped scan
      // history already lives in this shared DB — guarantees it's within
      // `getScannedAppNames`'s bounded recent-rows window.
      scannedAt: Math.floor(Date.now() / 1000) + 1_000_000,
    };
  }

  async function cleanupScanSource(): Promise<void> {
    const db = getDb();
    await db`DELETE FROM appstore_keywords WHERE keyword IN ${db(SCAN_SOURCE_CANDIDATE_KEYWORDS)}`;
    await db`DELETE FROM appstore_keyword_scans WHERE keyword = ${SCAN_SOURCE_KEYWORD}`;
  }

  beforeAll(async () => {
    await cleanupScanSource();
    await insertScan(scanFixtureProfile());
  });

  afterAll(async () => {
    await cleanupScanSource();
  });

  it("mines candidates from app names embedded in the top_apps scan pool, with no rankings contribution", async () => {
    const result = await mineKeywords({
      listType: EMPTY_LIST_TYPE,
      scannedAppsLimit: 500,
      maxNew: 500,
    });
    expect(result.scannedFromRankings).toBe(0);
    expect(result.scannedFromTopApps).toBeGreaterThan(0);

    const db = getDb();
    const rows = await db`
      SELECT keyword, source, genre_zone FROM appstore_keywords
      WHERE keyword = ${"wobblesnizzle gadget"}
    `;
    expect(rows.length).toBe(1);
    expect(rows[0]?.source).toBe("mined");
    // No category on a top_apps-derived name -> falls back to DEFAULT_ZONE.
    expect(rows[0]?.genre_zone).toBe("lifestyle");
  });
});
