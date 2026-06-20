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

// A builder-profile scorecard: top-level dims/overall are the EFFECTIVE
// (profile-discounted, decided) values; `raw` preserves the pre-profile barriers;
// `matchedExpertiseDomain` records the domain that discounted the dominant moat.
const PROFILE_SCORECARD: CompetabilityPersistedJson = {
  dimensions: { capital: 2.5, networkEffect: 4.5, logistics: 0, regulated: 1 },
  overall: 3.2,
  reason: "overall 3.2 >= 2.5",
  gated: false,
  raw: {
    dimensions: { capital: 5, networkEffect: 5, logistics: 4, regulated: 1 },
    overall: 1.5,
  },
  matchedExpertiseDomain: "fintech",
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

  it("round-trips BOTH raw and effective (profile-adjusted) scores", async () => {
    const created = await insertIdea({
      agent_id: TEST_AGENT,
      title: "A fintech compliance tool",
      summary: "Solo dev with fintech expertise; effective barriers lower.",
      reasoning: "builder profile applied",
      sources_used: "pipeline",
      category: "general",
      quality_score: 4,
      // The column carries the EFFECTIVE overall (3.2), not the raw (1.5).
      competability_overall: PROFILE_SCORECARD.overall,
      competability_json: PROFILE_SCORECARD,
    });

    // competability_overall is a REAL column → compare with float tolerance.
    expect(created.competability_overall).toBeCloseTo(3.2, 5);

    const read = await getIdeaById(created.id);
    expect(read).not.toBeNull();
    // Column = effective (decided) overall.
    expect(read!.competability_overall).toBeCloseTo(3.2, 5);
    // Full scorecard round-trips, raw + matched domain included.
    expect(read!.competability_json).toEqual(PROFILE_SCORECARD);
    expect(read!.competability_json!.raw!.overall).toBe(1.5);
    expect(read!.competability_json!.raw!.dimensions.networkEffect).toBe(5);
    // Effective networkEffect was discounted below raw.
    expect(read!.competability_json!.dimensions.networkEffect).toBe(4.5);
    expect(read!.competability_json!.matchedExpertiseDomain).toBe("fintech");
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
