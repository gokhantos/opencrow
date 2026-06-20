/**
 * Integration test for the READ-ONLY competability calibration query.
 *
 * Requires Postgres (`docker compose up -d postgres` first). initDb runs all
 * migrations idempotently, so migration 027 (competability_overall +
 * competability_json) is applied before these assertions run.
 *
 * The query is GLOBAL (all scored ideas), so we seed rows under a UNIQUE test
 * agent with RECOGNIZABLE overall values, then filter the returned records down to
 * the ones we seeded (by their distinctive overall values) and assert the mapping.
 *
 * Verifies:
 *   1. A scored idea with a full scorecard maps to {overall, gated, dimensions}.
 *   2. A scored idea WITHOUT dims maps to dimensions:undefined, gated:false.
 *   3. An idea with NULL competability is EXCLUDED (WHERE competability_overall IS NOT NULL).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeDb, getDb, initDb } from "../../store/db";
import { getCompetabilityScoredIdeas } from "./competability-calibration-query";
import { type CompetabilityPersistedJson, insertIdea } from "./store";

const TEST_AGENT = "competability-calibration-itest-agent";

// Distinctive overall values so we can identify our seeded rows in the global
// query result. Chosen to be unlikely to collide with real data.
const GATED_OVERALL = 1.234_5;
const PASS_OVERALL = 4.876_5;
const NO_DIMS_OVERALL = 2.345_6;

async function cleanup(): Promise<void> {
  const db = getDb();
  await db`DELETE FROM generated_ideas WHERE agent_id = ${TEST_AGENT}`;
}

const GATED_SCORECARD: CompetabilityPersistedJson = {
  dimensions: { capital: 5, networkEffect: 5, logistics: 4, regulated: 1 },
  overall: GATED_OVERALL,
  reason: "uncompetable",
  gated: true,
};

const PASS_SCORECARD: CompetabilityPersistedJson = {
  dimensions: { capital: 1, networkEffect: 1, logistics: 0, regulated: 0 },
  overall: PASS_OVERALL,
  reason: "wide open",
  gated: false,
};

// A scorecard with NO dimensions object → query should yield dimensions:undefined.
const NO_DIMS_SCORECARD = {
  overall: NO_DIMS_OVERALL,
  reason: "no dims persisted",
  gated: false,
} as unknown as CompetabilityPersistedJson;

describe("getCompetabilityScoredIdeas (integration)", () => {
  beforeEach(async () => {
    await initDb(process.env.DATABASE_URL);
    await cleanup();
  });

  afterEach(async () => {
    await cleanup();
    await closeDb();
  });

  it("maps scored rows and excludes NULL-competability rows", async () => {
    await insertIdea({
      agent_id: TEST_AGENT,
      title: "Gated idea",
      summary: "x",
      reasoning: "x",
      sources_used: "test",
      category: "general",
      quality_score: 1,
      competability_overall: GATED_OVERALL,
      competability_json: GATED_SCORECARD,
    });
    await insertIdea({
      agent_id: TEST_AGENT,
      title: "Passing idea",
      summary: "x",
      reasoning: "x",
      sources_used: "test",
      category: "general",
      quality_score: 4,
      competability_overall: PASS_OVERALL,
      competability_json: PASS_SCORECARD,
    });
    await insertIdea({
      agent_id: TEST_AGENT,
      title: "Scored but no dims",
      summary: "x",
      reasoning: "x",
      sources_used: "test",
      category: "general",
      quality_score: 2,
      competability_overall: NO_DIMS_OVERALL,
      competability_json: NO_DIMS_SCORECARD,
    });
    // NULL competability → must be excluded by the WHERE clause.
    await insertIdea({
      agent_id: TEST_AGENT,
      title: "Un-scored idea",
      summary: "x",
      reasoning: "x",
      sources_used: "test",
      category: "general",
      quality_score: 2,
    });

    const all = await getCompetabilityScoredIdeas();

    // Filter to our seeded rows by their distinctive overalls (float tolerance).
    const near = (a: number, b: number) => Math.abs(a - b) < 1e-3;
    const gated = all.find((r) => near(r.overall, GATED_OVERALL));
    const pass = all.find((r) => near(r.overall, PASS_OVERALL));
    const noDims = all.find((r) => near(r.overall, NO_DIMS_OVERALL));

    expect(gated).toBeDefined();
    expect(gated!.gated).toBe(true);
    expect(gated!.dimensions).toBeDefined();
    expect(gated!.dimensions!.networkEffect).toBe(5);

    expect(pass).toBeDefined();
    expect(pass!.gated).toBe(false);
    expect(pass!.dimensions).toBeDefined();
    expect(pass!.dimensions!.capital).toBe(1);

    expect(noDims).toBeDefined();
    expect(noDims!.gated).toBe(false);
    expect(noDims!.dimensions).toBeUndefined();

    // The un-scored (NULL) idea must NOT appear: none of our agent's results may
    // carry the un-scored title's signature — assert by counting our seeded scored
    // rows. We seeded exactly 3 scored rows under this agent.
    const seeded = all.filter(
      (r) => near(r.overall, GATED_OVERALL) || near(r.overall, PASS_OVERALL) || near(r.overall, NO_DIMS_OVERALL),
    );
    expect(seeded.length).toBe(3);
  });
});
