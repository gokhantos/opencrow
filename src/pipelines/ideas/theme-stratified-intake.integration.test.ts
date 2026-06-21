/**
 * Integration tests for Theme-Stratified Intake (real Postgres).
 *
 * Requires a running Postgres instance (`bun run test:integration`).
 *
 * Covers:
 *  (a) the `signal_category` column exists and is writable (migration 031),
 *  (b) the column write-back (PG array literal cast `::text[]`, mirroring the
 *      indexer helper) fans a category onto the targeted rows only,
 *  (c) a collector-shaped SELECT returns `signal_category` so the mapped
 *      RawCandidate.category reflects the mirrored theme (read path), giving the
 *      hybrid bucket key distinct themes to spread across.
 *
 * The selection algorithm (per-bucket cap / anti-starvation) is verified in the
 * unit lane (collector-ranking.test.ts); the pure bucket-key derivation in
 * stratified-bucket-key.test.ts (including the spread property over
 * selectStratified). This test asserts the DB column + write-back + read wiring
 * against a real Postgres, avoiding the full scanCapabilities LLM tail.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { closeDb, getDb, initDb } from "../../store/db";

const ID_PREFIX = "themestrat_test_";
const NOW = Math.floor(Date.now() / 1000);

const seededGithubIds: string[] = [];

async function cleanup(): Promise<void> {
  const db = getDb();
  await db`DELETE FROM github_repos WHERE id LIKE ${`${ID_PREFIX}%`}`;
}

beforeAll(async () => {
  await initDb(process.env["DATABASE_URL"]);
  await cleanup();

  const db = getDb();

  // Seed 24 trending github_repos. Categories are assigned in a round-robin
  // across 4 distinct themes so a single category cannot exceed perBucketCap (8)
  // — the hybrid theme buckets must spread the kept rows across the themes.
  const categories = ["fintech", "devtools", "healthcare", "consumer-social"];
  for (let i = 0; i < 24; i++) {
    const id = `${ID_PREFIX}gh_${i}`;
    seededGithubIds.push(id);
    const category = categories[i % categories.length];
    await db`
      INSERT INTO github_repos (id, owner, name, full_name, description, language, stars, forks, stars_today, url, period, first_seen_at, updated_at, signal_category)
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
        ${NOW - 1800},
        ${category}
      )
      ON CONFLICT (id) DO NOTHING
    `;
  }
});

afterAll(async () => {
  await cleanup();
  await closeDb();
});

describe("Theme-Stratified Intake — column + write-back", () => {
  it("signal_category column exists and is writable (migration 031)", async () => {
    const db = getDb();
    const id = `${ID_PREFIX}gh_0`;
    await db`UPDATE github_repos SET signal_category = ${"fintech"} WHERE id = ${id}`;
    const rows = (await db`
      SELECT signal_category FROM github_repos WHERE id = ${id}
    `) as Array<{ signal_category: string | null }>;
    expect(rows[0]?.signal_category).toBe("fintech");
  });

  it("write-back via ANY(::text[]) fans a category onto the targeted rows only", async () => {
    const db = getDb();
    // Mirror the indexer's write-back shape: PG array literal cast ::text[].
    const targetIds = [`${ID_PREFIX}gh_4`, `${ID_PREFIX}gh_8`, `${ID_PREFIX}gh_12`];
    const idArray = `{${targetIds.join(",")}}`;
    await db`
      UPDATE github_repos SET signal_category = ${"robotics"}
      WHERE id = ANY(${idArray}::text[])
    `;
    const rows = (await db`
      SELECT id, signal_category FROM github_repos
      WHERE id = ANY(${idArray}::text[])
    `) as Array<{ id: string; signal_category: string | null }>;
    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(r.signal_category).toBe("robotics");
    }
    // A non-targeted seeded row is untouched.
    const other = (await db`
      SELECT signal_category FROM github_repos WHERE id = ${`${ID_PREFIX}gh_5`}
    `) as Array<{ signal_category: string | null }>;
    expect(other[0]?.signal_category).not.toBe("robotics");
  });
});

describe("Theme-Stratified Intake — read path returns signal_category", () => {
  it("a collector-shaped SELECT exposes signal_category for RawCandidate.category", async () => {
    // Mirror the per-source collector projection: the windowed `ranked` CTE now
    // carries `signal_category`, so the row the builder maps into
    // RawCandidate.category reflects the mirrored theme (not "unknown").
    const db = getDb();
    const categories = ["fintech", "devtools", "healthcare", "consumer-social"];
    await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        db`
          UPDATE github_repos SET signal_category = ${categories[i % categories.length]}
          WHERE id = ${`${ID_PREFIX}gh_${i}`}
        `,
      ),
    );

    const rows = (await db`
      SELECT id, full_name, signal_category
      FROM github_repos
      WHERE id LIKE ${`${ID_PREFIX}%`}
      ORDER BY id
    `) as Array<{ id: string; full_name: string; signal_category: string | null }>;

    expect(rows.length).toBe(24);
    // Map row → RawCandidate.category exactly as collectors.ts does.
    const distinctThemes = new Set(
      rows.map((r) => (r.signal_category as string) ?? "unknown"),
    );
    // 4 distinct themes present → the hybrid bucket key would spread these rows
    // across 4 `${category}:github_repos` theme buckets instead of collapsing
    // into the single legacy `github_repos:trending` bucket.
    expect(distinctThemes.size).toBe(4);
    expect(distinctThemes.has("unknown")).toBe(false);
  });
});
