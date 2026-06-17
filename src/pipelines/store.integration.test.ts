import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { initDb, closeDb, getDb } from "../store/db";
import {
  acquirePipelineLock,
  createPipelineStep,
  updatePipelineStep,
  touchPipelineStep,
  updatePipelineRun,
  getPipelineRun,
  getStepsForRun,
  findCompletedStep,
  findResumableRuns,
  incrementResumeAttempts,
  markRunFailed,
} from "./store";

const TEST_PIPELINE = "test-resume-pipeline";

async function cleanup(): Promise<void> {
  const db = getDb();
  await db.unsafe(
    `DELETE FROM generated_ideas WHERE pipeline_run_id IN
       (SELECT id FROM pipeline_runs WHERE pipeline_id = $1)`,
    [TEST_PIPELINE],
  );
  await db.unsafe(
    `DELETE FROM pipeline_steps WHERE run_id IN
       (SELECT id FROM pipeline_runs WHERE pipeline_id = $1)`,
    [TEST_PIPELINE],
  );
  await db.unsafe(`DELETE FROM pipeline_runs WHERE pipeline_id = $1`, [
    TEST_PIPELINE,
  ]);
}

describe("pipeline resume store layer", () => {
  beforeEach(async () => {
    await initDb(process.env.DATABASE_URL);
    await cleanup();
  });

  afterEach(async () => {
    await cleanup();
    await closeDb();
  });

  describe("findCompletedStep", () => {
    it("returns a cache hit with the structured payload for a completed step", async () => {
      const { runId } = await acquirePipelineLock(TEST_PIPELINE);
      const step = await createPipelineStep({ runId: runId!, stepName: "landscape" });
      const payload = {
        trendingCategories: [{ category: "fitness", score: 0.8 }],
        summary: "line1\nline2",
        insights: true,
      };
      await updatePipelineStep(step.id, {
        status: "completed",
        outputSummary: "2 categories",
        outputJson: payload,
      });

      const result = await findCompletedStep(runId!, "landscape");
      expect(result.found).toBe(true);
      expect(result.hasOutput).toBe(true);
      expect(result.outputJson).toEqual(payload);
    });

    it("round-trips a deeply nested payload without loss (serialization contract)", async () => {
      const { runId } = await acquirePipelineLock(TEST_PIPELINE);
      const step = await createPipelineStep({ runId: runId!, stepName: "synthesis" });
      const payload = {
        candidates: [
          { title: "A", keyFeatures: ["x", "y"], giant: { demand: 3.5, moat: 2 } },
          { title: "B", sourceLinks: [{ url: "http://e.com", source: "ph" }] },
        ],
        totalGenerated: 2,
        nested: { a: { b: { c: [1, 2, 3] } } },
      };
      await updatePipelineStep(step.id, {
        status: "completed",
        outputSummary: "2 candidates",
        outputJson: payload,
      });

      const result = await findCompletedStep(runId!, "synthesis");
      expect(result.outputJson).toEqual(payload);
    });

    it("is a cache miss when the completed step has no stored payload", async () => {
      const { runId } = await acquirePipelineLock(TEST_PIPELINE);
      const step = await createPipelineStep({ runId: runId!, stepName: "reviews" });
      // Completed, but NO outputJson (mirrors a pre-migration row).
      await updatePipelineStep(step.id, {
        status: "completed",
        outputSummary: "done",
      });

      const result = await findCompletedStep(runId!, "reviews");
      expect(result.found).toBe(true);
      expect(result.hasOutput).toBe(false);
    });

    it("is a cache miss when the step exists but is not completed", async () => {
      const { runId } = await acquirePipelineLock(TEST_PIPELINE);
      await createPipelineStep({ runId: runId!, stepName: "capabilities" });
      // left 'running' (no update)

      const result = await findCompletedStep(runId!, "capabilities");
      expect(result.found).toBe(false);
      expect(result.hasOutput).toBe(false);
    });

    it("is a cache miss when no step exists for the name", async () => {
      const { runId } = await acquirePipelineLock(TEST_PIPELINE);
      const result = await findCompletedStep(runId!, "nonexistent");
      expect(result.found).toBe(false);
    });
  });

  describe("running step status + heartbeat", () => {
    it("creates a step in 'running' status with an initial heartbeat", async () => {
      const { runId } = await acquirePipelineLock(TEST_PIPELINE);
      const step = await createPipelineStep({ runId: runId!, stepName: "synthesis" });

      expect(step.status).toBe("running");
      expect(step.startedAt).not.toBeNull();
      expect(step.lastHeartbeat).not.toBeNull();
      // Heartbeat starts at (or after) the step's start.
      expect(step.lastHeartbeat!).toBeGreaterThanOrEqual(step.startedAt!);
    });

    it("touchPipelineStep advances last_heartbeat of a running step", async () => {
      const { runId } = await acquirePipelineLock(TEST_PIPELINE);
      const step = await createPipelineStep({ runId: runId!, stepName: "synthesis" });

      const db = getDb();
      // Force the heartbeat into the past so the touch is observable at 1s resolution.
      await db.unsafe(
        `UPDATE pipeline_steps SET last_heartbeat = last_heartbeat - 60 WHERE id = $1`,
        [step.id],
      );

      await touchPipelineStep(step.id);

      const [refreshed] = await getStepsForRun(runId!);
      expect(refreshed!.lastHeartbeat!).toBeGreaterThan(step.lastHeartbeat! - 60);
    });

    it("touchPipelineStep does NOT resurrect a finished step", async () => {
      const { runId } = await acquirePipelineLock(TEST_PIPELINE);
      const step = await createPipelineStep({ runId: runId!, stepName: "synthesis" });
      await updatePipelineStep(step.id, { status: "completed", outputSummary: "done" });

      const db = getDb();
      const [beforeRow] = (await db.unsafe(
        `SELECT status, last_heartbeat FROM pipeline_steps WHERE id = $1`,
        [step.id],
      )) as Array<{ status: string; last_heartbeat: number | null }>;

      await touchPipelineStep(step.id);

      const [afterRow] = (await db.unsafe(
        `SELECT status, last_heartbeat FROM pipeline_steps WHERE id = $1`,
        [step.id],
      )) as Array<{ status: string; last_heartbeat: number | null }>;

      expect(afterRow!.status).toBe("completed");
      // A completed step is no longer 'running', so its heartbeat must be untouched.
      expect(afterRow!.last_heartbeat).toBe(beforeRow!.last_heartbeat);
    });
  });

  describe("findResumableRuns", () => {
    it("returns only runs still marked 'running'", async () => {
      const running = await acquirePipelineLock(TEST_PIPELINE);
      const completed = await acquirePipelineLock(TEST_PIPELINE);
      const failed = await acquirePipelineLock(TEST_PIPELINE);

      await updatePipelineRun(completed.runId!, { status: "completed" });
      await markRunFailed(failed.runId!, "boom");

      const resumable = await findResumableRuns();
      const ids = resumable.map((r) => r.id);

      expect(ids).toContain(running.runId!);
      expect(ids).not.toContain(completed.runId!);
      expect(ids).not.toContain(failed.runId!);
    });

    it("carries the pipeline id and resume attempt count", async () => {
      const { runId } = await acquirePipelineLock(TEST_PIPELINE);
      await incrementResumeAttempts(runId!);

      const resumable = await findResumableRuns();
      const mine = resumable.find((r) => r.id === runId);
      expect(mine).toBeDefined();
      expect(mine!.pipelineId).toBe(TEST_PIPELINE);
      expect(mine!.resumeAttempts).toBe(1);
    });
  });

  describe("incrementResumeAttempts", () => {
    it("increments monotonically and returns the new count", async () => {
      const { runId } = await acquirePipelineLock(TEST_PIPELINE);
      expect(await incrementResumeAttempts(runId!)).toBe(1);
      expect(await incrementResumeAttempts(runId!)).toBe(2);
      expect(await incrementResumeAttempts(runId!)).toBe(3);
    });
  });

  describe("markRunFailed", () => {
    it("sets status=failed with the given reason and a finish time", async () => {
      const { runId } = await acquirePipelineLock(TEST_PIPELINE);
      await markRunFailed(runId!, "Exceeded max resume attempts (3)");

      const run = await getPipelineRun(runId!);
      expect(run).not.toBeNull();
      expect(run!.status).toBe("failed");
      expect(run!.error).toBe("Exceeded max resume attempts (3)");
      expect(run!.finishedAt).not.toBeNull();
    });
  });

  describe("store-step idempotency primitive", () => {
    it("deletes ideas attached to a run id (used before a re-store on resume)", async () => {
      const { runId } = await acquirePipelineLock(TEST_PIPELINE);
      const db = getDb();
      await db.unsafe(
        `INSERT INTO generated_ideas (id, agent_id, title, summary, reasoning, sources_used, category, pipeline_run_id)
         VALUES ($1,'idea-pipeline','T','S','R','src','mobile_app',$2)`,
        [crypto.randomUUID(), runId!],
      );

      const before = await db.unsafe(
        `SELECT COUNT(*)::int AS c FROM generated_ideas WHERE pipeline_run_id = $1`,
        [runId!],
      );
      expect((before[0] as { c: number }).c).toBe(1);

      await db.unsafe(`DELETE FROM generated_ideas WHERE pipeline_run_id = $1`, [
        runId!,
      ]);

      const after = await db.unsafe(
        `SELECT COUNT(*)::int AS c FROM generated_ideas WHERE pipeline_run_id = $1`,
        [runId!],
      );
      expect((after[0] as { c: number }).c).toBe(0);
    });
  });
});
