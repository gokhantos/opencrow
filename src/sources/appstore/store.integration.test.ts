import { describe, expect, it, beforeAll, afterAll, afterEach } from "bun:test";
import { initDb, getDb } from "../../store/db";
import {
  getRankings,
  getRankingsByCategory,
  insertRankingHistory,
  upsertRankings,
  upsertReviews,
  type AppRankingRow,
  type AppReviewRow,
} from "./store";

// Deep-scrape build Stage 3 (charts): `appstore_ranking_history.storefront`
// (migration 046) — round-trips the new column and verifies the US-scoped
// readers (`getRankings` / `getRankingsByCategory`) never let a more-recently
// scraped INTL row win the `DISTINCT ON (app_id, list_type)` "latest" slot
// (both share list_type tags across storefronts — see charts.ts's
// `dedupeRankingsByListKey` doc comment).

const TEST_APP_ID = "zzz-store-intl-app-1";
const TEST_LIST_TYPE = "zzz-store-intl-list";
const TEST_CATEGORY = "zzz-store-intl-category";

async function cleanup(): Promise<void> {
  const db = getDb();
  await db`DELETE FROM appstore_ranking_history WHERE app_id = ${TEST_APP_ID}`;
  await db`DELETE FROM appstore_apps WHERE id = ${TEST_APP_ID}`;
}

function makeRow(overrides: Partial<AppRankingRow> = {}): AppRankingRow {
  return {
    id: TEST_APP_ID,
    name: "Intl Store Test App",
    artist: "Zzz Test Dev",
    category: TEST_CATEGORY,
    rank: 1,
    list_type: TEST_LIST_TYPE,
    icon_url: "",
    store_url: "",
    description: "",
    price: "Free",
    bundle_id: "",
    release_date: "",
    updated_at: Math.floor(Date.now() / 1000),
    indexed_at: null,
    ...overrides,
  };
}

describe("store (intl storefront, migration 046)", () => {
  beforeAll(async () => {
    await initDb(process.env.DATABASE_URL);
    await cleanup();
  });

  afterEach(cleanup);
  afterAll(cleanup);

  it("re-running initDb (through migration 046) does not throw — migration is idempotent on double-apply", async () => {
    // A second (Nth, really — every integration test file in this suite
    // already calls initDb() in its own beforeAll) application of migration
    // 046 against the same live DB must not throw — reaching this
    // assertion at all is the proof; initDb resolves to the `sql` client,
    // not undefined, so there's nothing more specific to assert on it.
    await initDb(process.env.DATABASE_URL);
    expect(true).toBe(true);
  });

  it("defaults storefront to 'us' when insertRankingHistory is called without one", async () => {
    await insertRankingHistory([
      { app_id: TEST_APP_ID, list_type: TEST_LIST_TYPE, rank: 1, scraped_at: Math.floor(Date.now() / 1000) },
    ]);
    const db = getDb();
    const rows = await db`
      SELECT storefront FROM appstore_ranking_history
      WHERE app_id = ${TEST_APP_ID} AND list_type = ${TEST_LIST_TYPE}
    `;
    expect(rows).toHaveLength(1);
    expect((rows[0] as { storefront: string }).storefront).toBe("us");
  });

  it("persists an explicit storefront through insertRankingHistory", async () => {
    await insertRankingHistory([
      {
        app_id: TEST_APP_ID,
        list_type: TEST_LIST_TYPE,
        rank: 5,
        scraped_at: Math.floor(Date.now() / 1000),
        storefront: "gb",
      },
    ]);
    const db = getDb();
    const rows = await db`
      SELECT storefront, rank FROM appstore_ranking_history
      WHERE app_id = ${TEST_APP_ID} AND list_type = ${TEST_LIST_TYPE} AND rank = 5
    `;
    expect(rows).toHaveLength(1);
    expect((rows[0] as { storefront: string }).storefront).toBe("gb");
  });

  it("persists per-row storefront through upsertRankings", async () => {
    await upsertRankings([
      makeRow({ rank: 1, storefront: "us" }),
      makeRow({ rank: 2, storefront: "gb" }),
    ]);
    const db = getDb();
    const rows = await db`
      SELECT storefront FROM appstore_ranking_history
      WHERE app_id = ${TEST_APP_ID} AND list_type = ${TEST_LIST_TYPE}
      ORDER BY rank ASC
    `;
    expect(rows.map((r: { storefront: string }) => r.storefront)).toEqual(["us", "gb"]);
  });

  it("getRankings excludes a more-recent non-US row sharing the same list_type", async () => {
    // US row written first (rank 3)...
    await upsertRankings([makeRow({ rank: 3, storefront: "us" })]);
    // ...then a GB row for the SAME (app_id, list_type), scraped later (rank 99).
    await upsertRankings([makeRow({ rank: 99, storefront: "gb" })]);

    const rankings = await getRankings(TEST_LIST_TYPE, 50);
    const mine = rankings.filter((r) => r.id === TEST_APP_ID);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.rank).toBe(3); // the US row, not the later GB one
  });

  it("getRankingsByCategory excludes a more-recent non-US row sharing the same list_type", async () => {
    await upsertRankings([makeRow({ rank: 4, storefront: "us" })]);
    await upsertRankings([makeRow({ rank: 88, storefront: "au" })]);

    const rankings = await getRankingsByCategory(TEST_CATEGORY, 50);
    const mine = rankings.filter((r) => r.id === TEST_APP_ID);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.rank).toBe(4);
  });

  it("getRankings returns nothing for an app that has ONLY intl-storefront rows", async () => {
    await upsertRankings([makeRow({ rank: 7, storefront: "gb" })]);

    const rankings = await getRankings(TEST_LIST_TYPE, 50);
    const mine = rankings.filter((r) => r.id === TEST_APP_ID);
    expect(mine).toHaveLength(0);
  });
});

// Deep-scrape build Stage 4 (reviews): `upsertReviews`'s new columns
// (`review_date`/`storefront`/`vote_count`/`vote_sum`, migration 047) and
// its `RETURNING (xmax = 0)`-derived `newIds` — the signal
// `review-harvester.ts`'s `shouldStopPaging` early-stop relies on.

const TEST_REVIEW_APP_ID = "zzz-store-review-app-1";
const TEST_REVIEW_ID_1 = "zzz-store-review-1";
const TEST_REVIEW_ID_2 = "zzz-store-review-2";

async function cleanupReviews(): Promise<void> {
  const db = getDb();
  await db`DELETE FROM appstore_reviews WHERE app_id = ${TEST_REVIEW_APP_ID}`;
}

function makeReviewRow(overrides: Partial<AppReviewRow> = {}): AppReviewRow {
  return {
    id: TEST_REVIEW_ID_1,
    app_id: TEST_REVIEW_APP_ID,
    app_name: "Review Test App",
    author: "Someone",
    rating: 4,
    title: "Good",
    content: "Works well.",
    version: "1.0",
    first_seen_at: Math.floor(Date.now() / 1000),
    indexed_at: null,
    ...overrides,
  };
}

describe("upsertReviews (migration 047)", () => {
  beforeAll(async () => {
    await initDb(process.env.DATABASE_URL);
    await cleanupReviews();
  });

  afterEach(cleanupReviews);
  afterAll(cleanupReviews);

  it("persists review_date/storefront/vote_count/vote_sum on first insert", async () => {
    const result = await upsertReviews([
      makeReviewRow({ review_date: 1_700_000_000, storefront: "gb", vote_count: 5, vote_sum: 3 }),
    ]);
    expect(result.upserted).toBe(1);
    expect(result.newIds).toEqual([TEST_REVIEW_ID_1]);

    const db = getDb();
    const rows = await db`SELECT * FROM appstore_reviews WHERE id = ${TEST_REVIEW_ID_1}`;
    const row = rows[0] as {
      review_date: number | string | null;
      storefront: string;
      vote_count: number | null;
      vote_sum: number | null;
    };
    expect(Number(row.review_date)).toBe(1_700_000_000);
    expect(row.storefront).toBe("gb");
    expect(row.vote_count).toBe(5);
    expect(row.vote_sum).toBe(3);
  });

  it("defaults storefront to 'us' and leaves vote fields NULL when omitted", async () => {
    await upsertReviews([makeReviewRow()]);
    const db = getDb();
    const rows = await db`SELECT storefront, vote_count, vote_sum FROM appstore_reviews WHERE id = ${TEST_REVIEW_ID_1}`;
    const row = rows[0] as { storefront: string; vote_count: number | null; vote_sum: number | null };
    expect(row.storefront).toBe("us");
    expect(row.vote_count).toBeNull();
    expect(row.vote_sum).toBeNull();
  });

  it("newIds distinguishes a genuinely-new row from a repeat sighting (xmax = 0 idiom)", async () => {
    const first = await upsertReviews([makeReviewRow({ rating: 3 })]);
    expect(first.newIds).toEqual([TEST_REVIEW_ID_1]);

    // Re-upsert the SAME id — an update, not an insert.
    const second = await upsertReviews([makeReviewRow({ rating: 5, content: "Changed my mind, love it." })]);
    expect(second.upserted).toBe(1);
    expect(second.newIds).toEqual([]);

    const db = getDb();
    const rows = await db`SELECT rating, content FROM appstore_reviews WHERE id = ${TEST_REVIEW_ID_1}`;
    const row = rows[0] as { rating: number; content: string };
    // rating/content DO get refreshed on conflict (unchanged pre-Stage-4 behavior).
    expect(row.rating).toBe(5);
    expect(row.content).toBe("Changed my mind, love it.");
  });

  it("preserves the FIRST review_date/storefront/vote fields on a later conflicting upsert (write-once)", async () => {
    await upsertReviews([
      makeReviewRow({ review_date: 1_700_000_000, storefront: "gb", vote_count: 2, vote_sum: 1 }),
    ]);
    // A later re-sighting with DIFFERENT vote/date/storefront values must
    // not clobber the original — a review's own posted-date/storefront/vote
    // snapshot from its first sighting is authoritative.
    await upsertReviews([
      makeReviewRow({ review_date: 1_800_000_000, storefront: "au", vote_count: 99, vote_sum: 99, rating: 1 }),
    ]);

    const db = getDb();
    const rows = await db`SELECT review_date, storefront, vote_count, vote_sum, rating FROM appstore_reviews WHERE id = ${TEST_REVIEW_ID_1}`;
    const row = rows[0] as {
      review_date: number | string | null;
      storefront: string;
      vote_count: number | null;
      vote_sum: number | null;
      rating: number;
    };
    expect(Number(row.review_date)).toBe(1_700_000_000);
    expect(row.storefront).toBe("gb");
    expect(row.vote_count).toBe(2);
    expect(row.vote_sum).toBe(1);
    // rating is NOT write-once (unchanged pre-Stage-4 behavior) — it DID refresh.
    expect(row.rating).toBe(1);
  });

  it("returns newIds only for the ids actually inserted, within a mixed-batch upsert", async () => {
    await upsertReviews([makeReviewRow({ id: TEST_REVIEW_ID_1 })]);
    const result = await upsertReviews([
      makeReviewRow({ id: TEST_REVIEW_ID_1, rating: 2 }), // repeat
      makeReviewRow({ id: TEST_REVIEW_ID_2, rating: 5 }), // new
    ]);
    expect(result.upserted).toBe(2);
    expect(result.newIds).toEqual([TEST_REVIEW_ID_2]);
  });

  it("returns { upserted: 0, newIds: [] } for an empty input", async () => {
    expect(await upsertReviews([])).toEqual({ upserted: 0, newIds: [] });
  });
});
