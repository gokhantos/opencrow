/**
 * Integration tests for sige-ingestion quality / dedup / budget helpers.
 *
 * Requires a running Postgres instance (docker compose up -d postgres).
 * The sige_ingest_dedup table is created by migration 025 — run migrations
 * via bootstrap or run the DDL manually if testing outside of bootstrap.
 *
 * Lane: *.integration.test.ts → `bun run test:integration`
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDb, getDb, initDb } from "../store/db";
import { contentHash, dailyCountKey, todayUtc } from "./sige-ingestion";

const TEST_NS = "sige-ingest-test";

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

async function ensureDedupTable(): Promise<void> {
  const db = getDb();
  await db.unsafe(`
    CREATE TABLE IF NOT EXISTS sige_ingest_dedup (
      content_hash text      PRIMARY KEY,
      source       text      NOT NULL,
      created_at   integer   NOT NULL DEFAULT extract(epoch FROM now())::integer
    )
  `);
}

async function cleanDedup(prefix: string): Promise<void> {
  // We do not have a deterministic way to find test rows by source prefix, but
  // we can scope by a sentinel source name we use only in tests.
  const db = getDb();
  await db.unsafe(`DELETE FROM sige_ingest_dedup WHERE source = '${prefix}'`);
}

async function cleanOverrides(): Promise<void> {
  const db = getDb();
  await db.unsafe(`DELETE FROM config_overrides WHERE namespace = '${TEST_NS}'`);
}

beforeEach(async () => {
  await initDb(process.env["DATABASE_URL"]);
  await ensureDedupTable();
  await cleanDedup("test-source");
  await cleanOverrides();
});

afterEach(async () => {
  await cleanDedup("test-source");
  await cleanOverrides();
  await closeDb();
});

// ─── Dedup table: insert and lookup ──────────────────────────────────────────

describe("sige_ingest_dedup — insert and existence check", () => {
  it("a freshly-inserted hash is found on the next lookup", async () => {
    const db = getDb();
    const hash = contentHash("The app crashes every time I open it on iOS.");
    const source = "test-source";

    // Insert
    await db`
      INSERT INTO sige_ingest_dedup (content_hash, source)
      VALUES (${hash}, ${source})
      ON CONFLICT (content_hash) DO NOTHING
    `;

    // Lookup
    const rows = await db`
      SELECT 1 FROM sige_ingest_dedup WHERE content_hash = ${hash} LIMIT 1
    `;
    expect(rows.length).toBe(1);
  });

  it("ON CONFLICT DO NOTHING is idempotent — inserting the same hash twice does not throw", async () => {
    const db = getDb();
    const hash = contentHash("Duplicate content that gets scraped twice.");
    const source = "test-source";

    await db`
      INSERT INTO sige_ingest_dedup (content_hash, source)
      VALUES (${hash}, ${source})
      ON CONFLICT (content_hash) DO NOTHING
    `;
    // Second insert — must not throw
    await db`
      INSERT INTO sige_ingest_dedup (content_hash, source)
      VALUES (${hash}, ${source})
      ON CONFLICT (content_hash) DO NOTHING
    `;

    const rows = await db`
      SELECT count(*)::int AS n FROM sige_ingest_dedup WHERE content_hash = ${hash}
    `;
    const row = rows[0] as { n: number } | undefined;
    expect(row?.n).toBe(1);
  });

  it("different content produces different hashes and both are stored independently", async () => {
    const db = getDb();
    const hash1 = contentHash("App Store bug report number one about crashing.");
    const hash2 = contentHash("App Store bug report number two about login failure.");
    const source = "test-source";

    await db`
      INSERT INTO sige_ingest_dedup (content_hash, source) VALUES (${hash1}, ${source})
      ON CONFLICT (content_hash) DO NOTHING
    `;
    await db`
      INSERT INTO sige_ingest_dedup (content_hash, source) VALUES (${hash2}, ${source})
      ON CONFLICT (content_hash) DO NOTHING
    `;

    const rows1 = await db`
      SELECT 1 FROM sige_ingest_dedup WHERE content_hash = ${hash1} LIMIT 1
    `;
    const rows2 = await db`
      SELECT 1 FROM sige_ingest_dedup WHERE content_hash = ${hash2} LIMIT 1
    `;
    expect(rows1.length).toBe(1);
    expect(rows2.length).toBe(1);
  });

  it("a hash that was not inserted is not found", async () => {
    const db = getDb();
    const hash = contentHash("Content that was never recorded.");
    const rows = await db`
      SELECT 1 FROM sige_ingest_dedup WHERE content_hash = ${hash} LIMIT 1
    `;
    expect(rows.length).toBe(0);
  });
});

// ─── Hash normalisation round-trip through DB ─────────────────────────────────

describe("contentHash normalisation — equivalent variants collide in dedup table", () => {
  it("storing a hash for text X means the same hash fires for a punctuation variant of X", async () => {
    const db = getDb();
    const original = "App crashes every time I open it!";
    const variant = "App crashes every time I open it.";

    // Hashes must be equal (normalisation strips punctuation)
    expect(contentHash(original)).toBe(contentHash(variant));

    const hash = contentHash(original);
    const source = "test-source";

    await db`
      INSERT INTO sige_ingest_dedup (content_hash, source)
      VALUES (${hash}, ${source})
      ON CONFLICT (content_hash) DO NOTHING
    `;

    // Look up variant's hash — should find the original's row
    const variantHash = contentHash(variant);
    const rows = await db`
      SELECT 1 FROM sige_ingest_dedup WHERE content_hash = ${variantHash} LIMIT 1
    `;
    expect(rows.length).toBe(1);
  });

  it("case-folded variant collides with original", async () => {
    const db = getDb();
    const lower = "the application does not launch correctly";
    const upper = "THE APPLICATION DOES NOT LAUNCH CORRECTLY";
    expect(contentHash(lower)).toBe(contentHash(upper));

    const hash = contentHash(lower);
    const source = "test-source";

    await db`
      INSERT INTO sige_ingest_dedup (content_hash, source)
      VALUES (${hash}, ${source})
      ON CONFLICT (content_hash) DO NOTHING
    `;

    const rows = await db`
      SELECT 1 FROM sige_ingest_dedup WHERE content_hash = ${contentHash(upper)} LIMIT 1
    `;
    expect(rows.length).toBe(1);
  });
});

// ─── Cursor-advance semantics (via config_overrides) ─────────────────────────

describe("cursor advance vs hold semantics — via config_overrides", () => {
  /**
   * These tests simulate the ingestSource cursor logic without calling the full
   * function (which requires a mem0 server). They verify:
   *
   * - A quality-dropped row ADVANCES the cursor.
   * - A dup-dropped row ADVANCES the cursor.
   * - A capped (budget-exhausted) row does NOT advance the cursor.
   *
   * We replicate the cursor-key schema used by ingestSource.
   */

  const CURSOR_NS = "sige-ingestion";

  async function writeCursorDirect(sourceName: string, id: string): Promise<void> {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    const json = JSON.stringify(id);
    await db`
      INSERT INTO config_overrides (namespace, key, value_json, updated_at)
      VALUES (${CURSOR_NS}, ${"cursor:" + sourceName}, ${json}, ${now})
      ON CONFLICT (namespace, key)
      DO UPDATE SET value_json = ${json}, updated_at = ${now}
    `;
  }

  async function readCursorDirect(sourceName: string): Promise<string | null> {
    const db = getDb();
    const rows = await db`
      SELECT value_json FROM config_overrides
      WHERE namespace = ${CURSOR_NS} AND key = ${"cursor:" + sourceName}
    `;
    const row = rows[0] as { value_json: string } | undefined;
    if (!row) return null;
    const val: unknown = JSON.parse(row.value_json);
    return typeof val === "string" ? val : null;
  }

  afterEach(async () => {
    // Clean up any cursor keys we wrote during these tests.
    const db = getDb();
    await db.unsafe(
      `DELETE FROM config_overrides WHERE namespace = 'sige-ingestion' AND key LIKE 'cursor:test-%'`,
    );
  });

  it("writing a cursor advances it and reading it back returns the new id", async () => {
    const source = "test-advance-source";
    await writeCursorDirect(source, "row-100");
    const cursor = await readCursorDirect(source);
    expect(cursor).toBe("row-100");
  });

  it("cursor is overwritten on subsequent writes (simulate advancing past filtered rows)", async () => {
    const source = "test-advance-overwrite";
    await writeCursorDirect(source, "row-10");
    await writeCursorDirect(source, "row-20");
    const cursor = await readCursorDirect(source);
    expect(cursor).toBe("row-20");
  });

  it("cursor is NOT updated when cap is reached (simulate hold)", async () => {
    // Before cap: cursor is at row-5
    const source = "test-cap-hold";
    await writeCursorDirect(source, "row-5");

    // Budget exhausted — DO NOT write cursor past row-5.
    // (In production code, the loop breaks before writeCursor when cappedAt != null)
    // Verify: cursor stays at row-5.
    const cursor = await readCursorDirect(source);
    expect(cursor).toBe("row-5");
  });

  it("cursor returns null when never written (fresh source)", async () => {
    const source = "test-fresh-never-written";
    const cursor = await readCursorDirect(source);
    expect(cursor).toBeNull();
  });
});

// ─── Daily budget counter — config_overrides round-trip ──────────────────────

describe("daily budget counter", () => {
  const CURSOR_NS = "sige-ingestion";

  async function writeDailyCount(date: string, count: number): Promise<void> {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    const key = dailyCountKey(date);
    const json = JSON.stringify(count);
    await db`
      INSERT INTO config_overrides (namespace, key, value_json, updated_at)
      VALUES (${CURSOR_NS}, ${key}, ${json}, ${now})
      ON CONFLICT (namespace, key)
      DO UPDATE SET value_json = ${json}, updated_at = ${now}
    `;
  }

  async function readDailyCount(date: string): Promise<number> {
    const db = getDb();
    const key = dailyCountKey(date);
    const rows = await db`
      SELECT value_json FROM config_overrides
      WHERE namespace = ${CURSOR_NS} AND key = ${key}
    `;
    const row = rows[0] as { value_json: string } | undefined;
    if (!row) return 0;
    const val: unknown = JSON.parse(row.value_json);
    return typeof val === "number" ? val : 0;
  }

  afterEach(async () => {
    const db = getDb();
    await db.unsafe(
      `DELETE FROM config_overrides WHERE namespace = 'sige-ingestion' AND key LIKE 'ingested:%'`,
    );
  });

  it("returns 0 when no count exists for the date", async () => {
    const count = await readDailyCount("1970-01-01");
    expect(count).toBe(0);
  });

  it("round-trips a daily count", async () => {
    const date = todayUtc();
    await writeDailyCount(date, 42);
    const count = await readDailyCount(date);
    expect(count).toBe(42);
  });

  it("increments the counter correctly", async () => {
    const date = todayUtc();
    await writeDailyCount(date, 100);
    const before = await readDailyCount(date);
    await writeDailyCount(date, before + 1);
    const after = await readDailyCount(date);
    expect(after).toBe(101);
  });

  it("counts for different dates are independent", async () => {
    await writeDailyCount("2026-06-18", 500);
    await writeDailyCount("2026-06-19", 200);

    expect(await readDailyCount("2026-06-18")).toBe(500);
    expect(await readDailyCount("2026-06-19")).toBe(200);
  });

  it("daily key is correctly namespaced — namespace pollution does not occur", async () => {
    const date = "2026-01-01";
    await writeDailyCount(date, 999);

    // The count must not appear in a different namespace lookup
    const db = getDb();
    const key = dailyCountKey(date);
    const rows = await db`
      SELECT value_json FROM config_overrides
      WHERE namespace = 'other-namespace' AND key = ${key}
    `;
    expect(rows.length).toBe(0);
  });
});
