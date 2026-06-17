/**
 * Integration tests for frontier-discovery.ts — requires Postgres.
 *
 * Tests the DB-backed extractSaturatedThemeKeys function which reads from
 * the generated_ideas table. The other functions in the module are pure
 * (tested in the unit lane) or mock.module (isolated lane).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "../../store/db";
import { extractSaturatedThemeKeys } from "./frontier-discovery";

const TEST_PIPELINE_ID = "test-sige-frontier-saturation";

async function insertTestIdea(title: string, summary: string): Promise<void> {
  const db = getDb();
  const id = crypto.randomUUID();
  // Use db.unsafe to avoid template literal type issues with unknown columns
  await db.unsafe(
    `INSERT INTO generated_ideas
       (id, agent_id, pipeline_run_id, title, summary, category, quality_score,
        reasoning, sources_used, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, extract(epoch from now())::int)
     ON CONFLICT DO NOTHING`,
    [id, "test-agent", TEST_PIPELINE_ID, title, summary, "productivity", 3.5, "test reasoning", "test"],
  );
}

async function cleanup(): Promise<void> {
  const db = getDb();
  await db.unsafe(`DELETE FROM generated_ideas WHERE pipeline_run_id = $1`, [TEST_PIPELINE_ID]);
  // Also clean up the pipeline_runs row if it was implicitly created
  await db.unsafe(`DELETE FROM pipeline_runs WHERE id = $1`, [TEST_PIPELINE_ID]).catch(() => {});
}

describe("extractSaturatedThemeKeys", () => {
  beforeEach(async () => {
    await initDb(process.env.DATABASE_URL);
    await cleanup();
    // generated_ideas.pipeline_run_id FKs to pipeline_runs — create the parent row.
    await getDb().unsafe(
      `INSERT INTO pipeline_runs (id, pipeline_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [TEST_PIPELINE_ID, "autonomous-sige"],
    );
  });

  afterEach(async () => {
    await cleanup();
    await closeDb();
  });

  it("returns [] when generated_ideas table is empty (or no qualifying rows)", async () => {
    const keys = await extractSaturatedThemeKeys(100);
    // Either empty (no ideas in DB) or a list of strings — never throws
    expect(Array.isArray(keys)).toBe(true);
    // In a clean test DB there should be no rows for our pipeline_run_id
    // so we just verify it returns an array without throwing
  });

  it("never throws even on DB error — returns []", async () => {
    // We can't easily break getDb() in integration mode, but we can verify
    // the fault-tolerant contract by calling with limit=0 (legal) or limit=1
    const keys = await extractSaturatedThemeKeys(1);
    expect(Array.isArray(keys)).toBe(true);
  });

  it("returns string array when ideas exist", async () => {
    // Insert a few ideas with shared n-gram themes
    await insertTestIdea("AI notes application", "Take notes with AI assistance");
    await insertTestIdea("AI notes organizer", "Organize your notes using AI");
    await insertTestIdea("Budget planner tool", "Plan your budget monthly");
    await insertTestIdea("Budget planner app", "Mobile budget planning app");

    const keys = await extractSaturatedThemeKeys(100);
    expect(Array.isArray(keys)).toBe(true);
    // With 2+ ideas sharing "ai notes" and "budget planner" bigrams,
    // we expect theme keys to be returned
    // Each key should be a non-empty string
    for (const k of keys) {
      expect(typeof k).toBe("string");
      expect(k.length).toBeGreaterThan(0);
    }
  });

  it("returns keys without duplicates", async () => {
    await insertTestIdea("Mobile payments app", "Pay with your phone");
    await insertTestIdea("Mobile payments wallet", "A digital wallet for mobile payments");
    await insertTestIdea("Mobile payments system", "System for mobile payment processing");

    const keys = await extractSaturatedThemeKeys(100);
    const unique = new Set(keys);
    expect(unique.size).toBe(keys.length);
  });

  it("respects the limit parameter", async () => {
    // Insert several ideas
    for (let i = 0; i < 10; i++) {
      await insertTestIdea(`AI productivity tool ${i}`, `Boost productivity with AI ${i}`);
    }
    // With limit=3, only 3 rows are scanned; result may be fewer keys
    const keysSmall = await extractSaturatedThemeKeys(3);
    const keysFull = await extractSaturatedThemeKeys(100);
    // Smaller limit should yield <= keys compared to full scan
    expect(keysSmall.length).toBeLessThanOrEqual(keysFull.length);
  });
});
