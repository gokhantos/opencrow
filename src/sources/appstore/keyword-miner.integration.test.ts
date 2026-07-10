import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { initDb, getDb } from "../../store/db";
import { mineKeywords } from "./keyword-miner";
import { upsertRankings } from "./store";
import type { AppRankingRow } from "./store";

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

  it("mines a new candidate keyword from ranking data and upserts it with source 'mined'", async () => {
    const result = await mineKeywords({ listType: TEST_LIST_TYPE, maxNew: 500 });
    expect(result.scanned).toBeGreaterThan(0);
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
    await mineKeywords({ listType: TEST_LIST_TYPE, maxNew: 500 });

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

    const result = await mineKeywords({ listType: TEST_LIST_TYPE, maxNew: 1 });
    expect(result.added).toBeLessThanOrEqual(1);
  });
});
