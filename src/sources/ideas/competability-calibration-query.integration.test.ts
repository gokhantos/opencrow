/**
 * Integration test for the READ-ONLY competability calibration query.
 *
 * Requires Postgres (`docker compose up -d postgres` first). initDb runs all
 * migrations idempotently, so migration 028 (competability_decisions) is applied
 * before these assertions run.
 *
 * As of migration 028 the calibration read sources the COMPLETE gate population
 * from `competability_decisions` (KEPT + KILLED), NOT the survivor-biased
 * `generated_ideas`. We seed a mix of GATED (killed) and PASSED decisions under a
 * UNIQUE test run id, then filter the GLOBAL query result down to our seeded rows
 * (by their distinctive overall values) and assert:
 *   1. A GATED (killed) decision with a full scorecard maps to {overall, gated:true, dimensions}.
 *   2. A PASSED decision maps to {overall, gated:false, dimensions}.
 *   3. A decision with NO dims maps to dimensions:undefined.
 *   4. The killed (low, gated) record is PRESENT — the survivor bias is cured.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { CompetabilityPersisted } from "../../pipelines/ideas/competability";
import { closeDb, getDb, initDb } from "../../store/db";
import { getCompetabilityScoredIdeas } from "./competability-calibration-query";
import {
  type CompetabilityDecisionInput,
  persistCompetabilityDecisions,
} from "./competability-decisions-store";

// Unique run id so we touch ONLY our own rows (the integration DB may be a shared
// opencrow-postgres-1; we never truncate shared tables).
const TEST_RUN_ID = `calib-query-itest-${crypto.randomUUID()}`;
const DECIDED_AT = 1_700_000_000;

// Distinctive overall values so we can identify our seeded rows in the global
// query result. Chosen to be unlikely to collide with real data.
const GATED_OVERALL = 0.823_1;
const PASS_OVERALL = 4.913_7;
const NO_DIMS_OVERALL = 2.117_9;

async function cleanup(): Promise<void> {
  const db = getDb();
  await db`DELETE FROM competability_decisions WHERE pipeline_run_id = ${TEST_RUN_ID}`;
}

const GATED_PERSISTED: CompetabilityPersisted = {
  dimensions: { capital: 5, networkEffect: 5, logistics: 4, regulated: 1 },
  overall: GATED_OVERALL,
  reason: "uncompetable",
  gated: true,
};

const PASS_PERSISTED: CompetabilityPersisted = {
  dimensions: { capital: 1, networkEffect: 1, logistics: 0, regulated: 0 },
  overall: PASS_OVERALL,
  reason: "wide open",
  gated: false,
};

// Persisted scorecard with NO dimensions object → query yields dimensions:undefined.
const NO_DIMS_PERSISTED = {
  overall: NO_DIMS_OVERALL,
  reason: "no dims persisted",
  gated: false,
} as unknown as CompetabilityPersisted;

function decision(
  persisted: CompetabilityPersisted,
  gated: boolean,
): CompetabilityDecisionInput {
  return {
    source: "pipeline",
    pipelineRunId: TEST_RUN_ID,
    ideaTitle: "calibration query itest idea",
    persisted,
    gated,
    enforced: true,
    decidedAt: DECIDED_AT,
  };
}

describe("getCompetabilityScoredIdeas (integration)", () => {
  beforeEach(async () => {
    await initDb(process.env.DATABASE_URL);
    await cleanup();
  });

  afterEach(async () => {
    await cleanup();
    await closeDb();
  });

  it("reads KILLED and PASSED decisions; the killed record is present (no survivor bias)", async () => {
    const persisted = await persistCompetabilityDecisions([
      decision(GATED_PERSISTED, true),
      decision(PASS_PERSISTED, false),
      decision(NO_DIMS_PERSISTED, false),
    ]);
    expect(persisted).toBe(3);

    const all = await getCompetabilityScoredIdeas();

    const near = (a: number, b: number) => Math.abs(a - b) < 1e-3;
    const gated = all.find((r) => near(r.overall, GATED_OVERALL));
    const pass = all.find((r) => near(r.overall, PASS_OVERALL));
    const noDims = all.find((r) => near(r.overall, NO_DIMS_OVERALL));

    // The KILLED (low, gated) record is present — the whole point of migration 028.
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

    // We seeded exactly 3 scored decisions under this run.
    const seeded = all.filter(
      (r) =>
        near(r.overall, GATED_OVERALL) ||
        near(r.overall, PASS_OVERALL) ||
        near(r.overall, NO_DIMS_OVERALL),
    );
    expect(seeded.length).toBe(3);

    // The killed record moves the kill metric: among our seeded rows the gated
    // fraction is non-zero (1 of 3), proving the survivor bias is cured.
    const seededGated = seeded.filter((r) => r.gated).length;
    expect(seededGated).toBe(1);
  });
});
