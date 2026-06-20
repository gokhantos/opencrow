/**
 * Integration test for the competability persistence round-trip (PR #208
 * follow-up #2): migration 027 columns + the store's insert/read mappers.
 *
 * Requires Postgres (`docker compose up -d postgres` first). initDb runs all
 * migrations idempotently, so migration 027 (competability_overall +
 * competability_json) is applied before these assertions run.
 *
 * Verifies:
 *   1. An idea written WITH a competability scorecard reads back with the
 *      overall score and the full JSONB scorecard intact (round-trip).
 *   2. An idea written WITHOUT competability reads back with NULL columns.
 *   3. The competability_json column is real queryable JSONB (->> extraction).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "../../store/db";
import {
  insertIdea,
  getIdeaById,
  type CompetabilityPersistedJson,
} from "./store";

const TEST_AGENT = "competability-itest-agent";

async function cleanup(): Promise<void> {
  const db = getDb();
  await db`DELETE FROM generated_ideas WHERE agent_id = ${TEST_AGENT}`;
}

const SCORECARD: CompetabilityPersistedJson = {
  dimensions: { capital: 5, networkEffect: 5, logistics: 4, regulated: 1 },
  overall: 1.5,
  reason: "overall 1.5 <= always-reject (clearly uncompetable)",
  gated: true,
};

describe("competability persistence round-trip", () => {
  beforeEach(async () => {
    await initDb(process.env.DATABASE_URL);
    await cleanup();
  });

  afterEach(async () => {
    await cleanup();
    await closeDb();
  });

  it("round-trips the overall score and the full scorecard JSON", async () => {
    const created = await insertIdea({
      agent_id: TEST_AGENT,
      title: "Build a DoorDash",
      summary: "A national food delivery marketplace.",
      reasoning: "It bypassed the pipeline competability gate.",
      sources_used: "sige",
      category: "sige",
      quality_score: 3,
      competability_overall: SCORECARD.overall,
      competability_json: SCORECARD,
    });

    expect(created.competability_overall).toBe(1.5);
    expect(created.competability_json).not.toBeNull();
    expect(created.competability_json!.gated).toBe(true);

    const read = await getIdeaById(created.id);
    expect(read).not.toBeNull();
    expect(read!.competability_overall).toBe(1.5);
    expect(read!.competability_json).toEqual(SCORECARD);
    expect(read!.competability_json!.dimensions.networkEffect).toBe(5);
    expect(read!.competability_json!.reason).toContain("uncompetable");
  });

  it("stores NULL competability columns when not scored", async () => {
    const created = await insertIdea({
      agent_id: TEST_AGENT,
      title: "An un-scored idea",
      summary: "No competability gate ran for this one.",
      reasoning: "shadow-off path",
      sources_used: "test",
      category: "general",
      quality_score: 2,
    });

    expect(created.competability_overall).toBeNull();
    expect(created.competability_json).toBeNull();

    const read = await getIdeaById(created.id);
    expect(read!.competability_overall).toBeNull();
    expect(read!.competability_json).toBeNull();
  });

  it("persists competability_json as queryable JSONB", async () => {
    const created = await insertIdea({
      agent_id: TEST_AGENT,
      title: "JSONB queryability",
      summary: "Confirms the column is real jsonb.",
      reasoning: "jsonb",
      sources_used: "test",
      category: "general",
      quality_score: 4,
      competability_overall: SCORECARD.overall,
      competability_json: SCORECARD,
    });

    const db = getDb();
    const rows = (await db`
      SELECT (competability_json->>'gated') AS gated,
             (competability_json->'dimensions'->>'capital') AS capital
      FROM generated_ideas
      WHERE id = ${created.id}
    `) as Array<{ gated: string; capital: string }>;

    expect(rows[0]!.gated).toBe("true");
    expect(rows[0]!.capital).toBe("5");
  });
});
