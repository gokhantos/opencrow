/**
 * Integration tests for `persistCompetabilityDecisions` — specifically the
 * `idea_id` column added in migration 036.
 *
 * Requires Postgres (`docker compose up -d postgres` first, or the native brew
 * stack via `opencrow native up`). `initDb` runs all migrations idempotently, so
 * migration 036 (idea_id column) is applied before these assertions run.
 *
 * Verifies:
 *   1. A decision WITH an ideaId persists and reads back the id from the DB.
 *   2. A decision WITHOUT an ideaId (omitted, pipeline path) persists as NULL.
 *   3. A decision WITH ideaId: null (explicit pipeline path) persists as NULL.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { CompetabilityPersisted } from "../../pipelines/ideas/competability";
import { closeDb, getDb, initDb } from "../../store/db";
import {
  type CompetabilityDecisionInput,
  persistCompetabilityDecisions,
} from "./competability-decisions-store";

// Unique run id so we touch ONLY our own rows (the integration DB may be shared).
const TEST_RUN_ID = `decisions-store-itest-${crypto.randomUUID()}`;
const DECIDED_AT = 1_700_000_000;

// Distinctive overall value to identify our seeded rows in the global table.
const ITEST_OVERALL = 3.141_592;

async function cleanup(): Promise<void> {
  const db = getDb();
  await db`DELETE FROM competability_decisions WHERE pipeline_run_id = ${TEST_RUN_ID}`;
}

const PERSISTED: CompetabilityPersisted = {
  dimensions: { capital: 2, networkEffect: 3, logistics: 1, regulated: 0 },
  overall: ITEST_OVERALL,
  reason: "integration test scorecard",
  gated: false,
};

function makeInput(
  partial: Partial<CompetabilityDecisionInput> = {},
): CompetabilityDecisionInput {
  return {
    source: "pipeline",
    pipelineRunId: TEST_RUN_ID,
    ideaTitle: "integration test idea",
    persisted: PERSISTED,
    gated: false,
    enforced: false,
    decidedAt: DECIDED_AT,
    ...partial,
  };
}

describe("persistCompetabilityDecisions idea_id round-trip (integration)", () => {
  beforeEach(async () => {
    await initDb(process.env.DATABASE_URL);
    await cleanup();
  });

  afterEach(async () => {
    await cleanup();
    await closeDb();
  });

  it("persists and reads back a non-null idea_id (SIGE path)", async () => {
    const IDEA_ID = `idea-sige-${crypto.randomUUID()}`;
    const count = await persistCompetabilityDecisions([
      makeInput({ source: "sige", pipelineRunId: null, sessionId: "sess-1", ideaId: IDEA_ID }),
    ]);
    expect(count).toBe(1);

    const db = getDb();
    const rows = (await db`
      SELECT idea_id
      FROM competability_decisions
      WHERE session_id = 'sess-1'
        AND idea_id = ${IDEA_ID}
      LIMIT 1
    `) as Array<{ idea_id: string | null }>;

    expect(rows.length).toBe(1);
    expect(rows[0]!.idea_id).toBe(IDEA_ID);
  });

  it("persists null idea_id when ideaId is omitted (pipeline path — no DB id yet)", async () => {
    const count = await persistCompetabilityDecisions([
      makeInput(), // no ideaId field
    ]);
    expect(count).toBe(1);

    const db = getDb();
    const rows = (await db`
      SELECT idea_id
      FROM competability_decisions
      WHERE pipeline_run_id = ${TEST_RUN_ID}
      LIMIT 1
    `) as Array<{ idea_id: string | null }>;

    expect(rows.length).toBe(1);
    expect(rows[0]!.idea_id).toBeNull();
  });

  it("persists null idea_id when ideaId is explicitly null (pipeline path)", async () => {
    const count = await persistCompetabilityDecisions([
      makeInput({ ideaId: null }),
    ]);
    expect(count).toBe(1);

    const db = getDb();
    const rows = (await db`
      SELECT idea_id
      FROM competability_decisions
      WHERE pipeline_run_id = ${TEST_RUN_ID}
      LIMIT 1
    `) as Array<{ idea_id: string | null }>;

    expect(rows.length).toBe(1);
    expect(rows[0]!.idea_id).toBeNull();
  });
});
