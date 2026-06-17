import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "../store/db";
import {
  acquirePipelineLock,
  createPipelineStep,
  getPipelineRun,
  getStepsForRun,
} from "./store";
import { reapStuckRuns } from "./reaper";
import { beginRun, __resetActiveRuns } from "./active-runs";

const TEST_PIPELINE = "test-reaper-pipeline";

async function cleanup(): Promise<void> {
  const db = getDb();
  await db.unsafe(
    `DELETE FROM pipeline_steps WHERE run_id IN
       (SELECT id FROM pipeline_runs WHERE pipeline_id = $1)`,
    [TEST_PIPELINE],
  );
  await db.unsafe(`DELETE FROM pipeline_runs WHERE pipeline_id = $1`, [TEST_PIPELINE]);
}

describe("reapStuckRuns", () => {
  beforeEach(async () => {
    await initDb(process.env.DATABASE_URL);
    __resetActiveRuns();
    await cleanup();
  });

  afterEach(async () => {
    __resetActiveRuns();
    await cleanup();
    await closeDb();
  });

  it("reaps a run with a stale heartbeat and no active executor", async () => {
    const { runId } = await acquirePipelineLock(TEST_PIPELINE);
    const step = await createPipelineStep({ runId: runId!, stepName: "synthesis" });
    // Age the heartbeat past the threshold.
    await getDb().unsafe(
      `UPDATE pipeline_steps SET last_heartbeat = last_heartbeat - 400 WHERE id = $1`,
      [step.id],
    );

    const { reaped } = await reapStuckRuns(300);
    expect(reaped).toBeGreaterThanOrEqual(1);

    const run = await getPipelineRun(runId!);
    expect(run!.status).toBe("failed");
    expect(run!.error).toContain("Reaped");

    const steps = await getStepsForRun(runId!);
    expect(steps.every((s) => s.status !== "running")).toBe(true);
  });

  it("does NOT reap a run active in this process", async () => {
    const { runId } = await acquirePipelineLock(TEST_PIPELINE);
    const step = await createPipelineStep({ runId: runId!, stepName: "synthesis" });
    await getDb().unsafe(
      `UPDATE pipeline_steps SET last_heartbeat = last_heartbeat - 400 WHERE id = $1`,
      [step.id],
    );
    beginRun(runId!); // mark as executing in this process

    await reapStuckRuns(300);
    // Our run must NOT be reaped.
    const run = await getPipelineRun(runId!);
    expect(run!.status).toBe("running");
  });

  it("does NOT reap a run with a fresh heartbeat (alive in another process)", async () => {
    const { runId } = await acquirePipelineLock(TEST_PIPELINE);
    await createPipelineStep({ runId: runId!, stepName: "synthesis" }); // fresh heartbeat

    await reapStuckRuns(300);
    const run = await getPipelineRun(runId!);
    expect(run!.status).toBe("running"); // untouched
  });

  it("returns reaped=0 when no runs are stuck", async () => {
    const { reaped } = await reapStuckRuns(300);
    expect(reaped).toBe(0);
  });
});
