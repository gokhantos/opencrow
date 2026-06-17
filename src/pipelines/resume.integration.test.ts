import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "../store/db";
import {
  acquirePipelineLock,
  markRunFailed,
  incrementResumeAttempts,
  getPipelineRun,
} from "./store";
import {
  resumeRunById,
  resumeAllInterrupted,
  type PipelineDispatcher,
} from "./resume";
import type { PipelineConfig } from "./types";

const TEST_PIPELINE = "test-resume-by-id";

async function cleanup(): Promise<void> {
  const db = getDb();
  await db.unsafe(`DELETE FROM pipeline_runs WHERE pipeline_id = $1`, [
    TEST_PIPELINE,
  ]);
}

/** A dispatcher spy that records its calls and never fires a real pipeline. */
function spyDispatcher(): {
  fn: PipelineDispatcher;
  calls: Array<{ pipelineId: string; config: PipelineConfig; runId: string }>;
} {
  const calls: Array<{ pipelineId: string; config: PipelineConfig; runId: string }> = [];
  const fn: PipelineDispatcher = async (pipelineId, config, runId) => {
    calls.push({ pipelineId, config, runId });
    return undefined;
  };
  return { fn, calls };
}

describe("resumeRunById", () => {
  beforeEach(async () => {
    await initDb(process.env.DATABASE_URL);
    await cleanup();
  });

  afterEach(async () => {
    await cleanup();
    await closeDb();
  });

  it("returns not_found and does not dispatch for an unknown run id", async () => {
    const spy = spyDispatcher();
    const result = await resumeRunById(crypto.randomUUID(), null, spy.fn);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_found");
    expect(spy.calls).toHaveLength(0);
  });

  it("re-dispatches a failed run with its stored config and resets state", async () => {
    const { runId } = await acquirePipelineLock(TEST_PIPELINE);
    // Drive it into a failed state with a spent resume budget, like a run that
    // exhausted auto-resume.
    await incrementResumeAttempts(runId!);
    await incrementResumeAttempts(runId!);
    await markRunFailed(runId!, "Exceeded max resume attempts (3)");

    const spy = spyDispatcher();
    const result = await resumeRunById(runId!, null, spy.fn);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.runId).toBe(runId!);
      expect(result.pipelineId).toBe(TEST_PIPELINE);
    }

    // Dispatched exactly once, with this run's id + pipeline.
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]!.runId).toBe(runId!);
    expect(spy.calls[0]!.pipelineId).toBe(TEST_PIPELINE);

    // Run reset to running, error cleared, attempt cap reset, finish time cleared.
    const run = await getPipelineRun(runId!);
    expect(run!.status).toBe("running");
    expect(run!.error).toBeNull();
    expect(run!.finishedAt).toBeNull();
    const resumable = (await getDb()`
      SELECT resume_attempts FROM pipeline_runs WHERE id = ${runId!}
    `) as Array<{ resume_attempts: number }>;
    expect(Number(resumable[0]!.resume_attempts)).toBe(0);
  });
});

describe("resumeAllInterrupted", () => {
  beforeEach(async () => {
    await initDb(process.env.DATABASE_URL);
    await cleanup();
  });

  afterEach(async () => {
    await cleanup();
    await closeDb();
  });

  it("re-dispatches every interrupted ('running') run, not the failed ones", async () => {
    const a = await acquirePipelineLock(TEST_PIPELINE); // running
    const b = await acquirePipelineLock(TEST_PIPELINE); // running
    const dead = await acquirePipelineLock(TEST_PIPELINE);
    await markRunFailed(dead.runId!, "real failure");

    const spy = spyDispatcher();
    const count = await resumeAllInterrupted(null, spy.fn);

    const dispatchedIds = spy.calls.map((c) => c.runId);
    // Membership (the shared DB may hold other 'running' rows): both of ours
    // were dispatched, the genuinely-failed one was not.
    expect(dispatchedIds).toContain(a.runId!);
    expect(dispatchedIds).toContain(b.runId!);
    expect(dispatchedIds).not.toContain(dead.runId!);
    expect(count).toBeGreaterThanOrEqual(2);
  });
});
