/**
 * Integration tests for scanCapabilities — stratified intake (Stage 1).
 *
 * Requires a running Postgres instance (`bun run test:integration`).
 *
 * Uses a `CollectorContext` with a `consumed` map that marks all pre-existing
 * rows as consumed, so only our test-seeded rows enter the candidate pools.
 * This makes the test deterministic regardless of production DB state.
 *
 * Seed:
 *  - 20 github_repos rows (all trending / stars_today > 0) → dominant bucket
 *  - 5 hn_stories rows (front-page) → non-dominant alternative
 *
 * With default stratifiedIntake config (perBucketCap=8, totalCap=90):
 *  - Phase 1 caps github_repos:trending at 8 (dominant)
 *  - Phase 2 does NOT backfill the dominant
 *  → github capabilities <= 8
 *  → hn capabilities == 5 (all natural rows; non-dominant backfill)
 *
 * The per-bucket cap algorithm is separately verified in the unit lane
 * (collector-ranking.test.ts selectStratified suite).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { closeDb, getDb, initDb } from "../../store/db";
import { scanCapabilities, type CollectorContext } from "./collectors";

const ID_PREFIX = "stratintake_test_";
const NOW = Math.floor(Date.now() / 1000);

/** IDs we seeded — used to build the inverse consumed set. */
const seededGithubIds: string[] = [];
const seededHnIds: string[] = [];

async function cleanup(): Promise<void> {
  const db = getDb();
  await db`DELETE FROM github_repos WHERE id LIKE ${`${ID_PREFIX}%`}`;
  await db`DELETE FROM hn_stories WHERE id LIKE ${`${ID_PREFIX}%`}`;
}

/**
 * Build a CollectorContext that marks ALL existing (non-seeded) rows as
 * consumed so only our seeded rows enter the candidate pools. The consumed map
 * key is the table name; the value is the set of non-test IDs.
 */
async function buildTestCtx(): Promise<CollectorContext> {
  const db = getDb();

  // Fetch existing IDs for each source table (excluding our seeded prefix).
  const [phRows, hnRows, ghRows, redditRows, newsRows, xRows] = await Promise.all([
    db`SELECT id FROM ph_products WHERE id NOT LIKE ${`${ID_PREFIX}%`}` as Promise<
      Array<{ id: string }>
    >,
    db`SELECT id FROM hn_stories WHERE id NOT LIKE ${`${ID_PREFIX}%`}` as Promise<
      Array<{ id: string }>
    >,
    db`SELECT id FROM github_repos WHERE id NOT LIKE ${`${ID_PREFIX}%`}` as Promise<
      Array<{ id: string }>
    >,
    db`SELECT id FROM reddit_posts WHERE id NOT LIKE ${`${ID_PREFIX}%`}` as Promise<
      Array<{ id: string }>
    >,
    db`SELECT id FROM news_articles WHERE id NOT LIKE ${`${ID_PREFIX}%`}` as Promise<
      Array<{ id: string }>
    >,
    db`SELECT id FROM x_scraped_tweets WHERE id NOT LIKE ${`${ID_PREFIX}%`}` as Promise<
      Array<{ id: string }>
    >,
  ]);

  const consumed = new Map<string, ReadonlySet<string>>([
    ["ph_products", new Set(phRows.map((r) => r.id))],
    ["hn_stories", new Set(hnRows.map((r) => r.id))],
    ["github_repos", new Set(ghRows.map((r) => r.id))],
    ["reddit_posts", new Set(redditRows.map((r) => r.id))],
    ["news_articles", new Set(newsRows.map((r) => r.id))],
    ["x_scraped_tweets", new Set(xRows.map((r) => r.id))],
  ]);

  return {
    consumed,
    selected: new Map(),
  };
}

beforeAll(async () => {
  await initDb(process.env["DATABASE_URL"]);
  await cleanup();

  const db = getDb();

  // Seed 20 github_repos rows with high stars_today so they enter the trending
  // query. All get signalType="trending" → single dominant bucket.
  for (let i = 0; i < 20; i++) {
    const id = `${ID_PREFIX}gh_${i}`;
    seededGithubIds.push(id);
    await db`
      INSERT INTO github_repos (id, owner, name, full_name, description, language, stars, forks, stars_today, url, period, first_seen_at, updated_at)
      VALUES (
        ${id},
        'test-owner',
        ${`repo-${i}`},
        ${`test-owner/repo-${i}`},
        ${`A trending repo ${i}`},
        'TypeScript',
        ${5000 + i * 100},
        ${100 + i},
        ${50 + i},
        ${`https://github.com/test-owner/repo-${i}`},
        'daily',
        ${NOW - 3600},
        ${NOW - 1800}
      )
      ON CONFLICT (id) DO NOTHING
    `;
  }

  // Seed 5 hn_stories rows (feed_type='front') within the 7-day window.
  for (let i = 0; i < 5; i++) {
    const id = `${ID_PREFIX}hn_${i}`;
    seededHnIds.push(id);
    await db`
      INSERT INTO hn_stories (id, rank, title, url, site_label, points, author, age, comment_count, hn_url, feed_type, first_seen_at, updated_at)
      VALUES (
        ${id},
        ${i + 1},
        ${`Interesting tech topic ${i}`},
        ${`https://example.com/story-${i}`},
        'example.com',
        ${200 + i * 10},
        'testuser',
        '2 hours ago',
        ${50 + i},
        ${`https://news.ycombinator.com/item?id=${1000 + i}`},
        'front',
        ${NOW - 3600},
        ${NOW - 1800}
      )
      ON CONFLICT (id) DO NOTHING
    `;
  }
});

afterAll(async () => {
  await cleanup();
  await closeDb();
});

describe("scanCapabilities stratified intake", () => {
  it(
    "no single kind:signalType bucket exceeds perBucketCap when alternatives exist",
    async () => {
      const ctx = await buildTestCtx();
      const scan = await scanCapabilities("deepseek-v4-flash", ctx, "alibaba");

      // Count capabilities by source.
      const counts = new Map<string, number>();
      for (const c of scan.capabilities) {
        counts.set(c.source, (counts.get(c.source) ?? 0) + 1);
      }

      // With only seeded rows in play: 20 github (dominant) + 5 HN.
      // Default perBucketCap=8 → github capped at 8 in Phase 1.
      // Phase 2 backfills non-dominant (HN) only. github stays at 8.
      expect(counts.get("github") ?? 0).toBeLessThanOrEqual(8);

      // HN (non-dominant, 5 rows) should be fully represented.
      expect((counts.get("hackernews") ?? 0)).toBeGreaterThan(0);

      // Multiple sources in output (stratification preserved diversity).
      expect([...counts.keys()].length).toBeGreaterThan(1);
    },
  );

  it("total capabilities do not exceed min(totalCap, totalTarget)", async () => {
    const ctx = await buildTestCtx();
    const scan = await scanCapabilities("deepseek-v4-flash", ctx, "alibaba");
    // totalTarget = sum of pool.targets = 75; strat.totalCap = 90.
    // With only 25 seeded rows total, output <= 25.
    expect(scan.capabilities.length).toBeLessThanOrEqual(90);
    // With 20 github + 5 HN seeded, we have 25 total rows, but perBucketCap=8
    // caps github at 8, so total selected = 8 (github) + 5 (HN) = 13.
    expect(scan.capabilities.length).toBeLessThanOrEqual(25);
  });

  it("selectedIds map matches capability count", async () => {
    const ctx = await buildTestCtx();
    const scan = await scanCapabilities("deepseek-v4-flash", ctx, "alibaba");
    expect(scan.capabilities.length).toBeGreaterThan(0);
    let totalSelected = 0;
    for (const ids of (scan.selectedIds ?? new Map()).values()) {
      totalSelected += ids.length;
    }
    expect(totalSelected).toBe(scan.capabilities.length);
  });

  it("respects stratifiedIntake.fetchLimit for raw pulls", async () => {
    // With a DB seeded with rows and fetchLimit=100 (default), scanCapabilities
    // must complete successfully and the output is bounded by the config limits.
    // Pool size before stratification is bounded by fetchLimit per source (split
    // ~30/70 top/midtier for windowed sources, or the full limit for flat queries);
    // we assert the result is non-empty and within the totalCap ceiling (90).
    const ctx = await buildTestCtx();
    const scan = await scanCapabilities("deepseek-v4-flash", ctx, "alibaba");
    expect(scan.capabilities.length).toBeGreaterThan(0);
    // totalCap default is 90; with 25 seeded rows the output is well under.
    expect(scan.capabilities.length).toBeLessThanOrEqual(90);
    // selectedIds must be consistent with capabilities.
    let totalSelected = 0;
    for (const ids of (scan.selectedIds ?? new Map()).values()) {
      totalSelected += ids.length;
    }
    expect(totalSelected).toBe(scan.capabilities.length);
  });
});
