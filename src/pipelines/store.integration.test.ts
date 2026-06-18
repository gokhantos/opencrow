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
  failIncompleteStepsForRun,
  getPipelineIdeas,
} from "./store";
import type { PipelineResultSummary } from "./types";

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

  describe("failIncompleteStepsForRun", () => {
    it("marks running and pending steps as interrupted, leaves completed untouched, returns count", async () => {
      const { runId } = await acquirePipelineLock(TEST_PIPELINE);

      // One completed step (checkpoint to preserve).
      const comp = await createPipelineStep({ runId: runId!, stepName: "landscape" });
      await updatePipelineStep(comp.id, {
        status: "completed",
        outputSummary: "done",
        outputJson: { ok: true },
      });

      // One running step (ghost — should be interrupted).
      await createPipelineStep({ runId: runId!, stepName: "reviews" });
      // left 'running'

      const count = await failIncompleteStepsForRun(runId!, "test reason");
      expect(count).toBe(1);

      const steps = await getStepsForRun(runId!);
      const byName = new Map(steps.map((s) => [s.stepName, s]));

      expect(byName.get("landscape")!.status).toBe("completed"); // preserved
      expect(byName.get("reviews")!.status).toBe("interrupted");
      expect(byName.get("reviews")!.error).toBe("test reason");
      expect(byName.get("reviews")!.finishedAt).not.toBeNull();
      expect(byName.get("reviews")!.lastHeartbeat).toBeNull();
    });

    it("returns 0 and is a no-op when no incomplete steps exist", async () => {
      const { runId } = await acquirePipelineLock(TEST_PIPELINE);
      const comp = await createPipelineStep({ runId: runId!, stepName: "landscape" });
      await updatePipelineStep(comp.id, { status: "completed", outputSummary: "done" });

      const count = await failIncompleteStepsForRun(runId!, "no-op");
      expect(count).toBe(0);
    });

    it("returns 0 for an unknown run id (no rows touched)", async () => {
      const count = await failIncompleteStepsForRun(crypto.randomUUID(), "ghost run");
      expect(count).toBe(0);
    });
  });

  describe("JSONB encoding (write path)", () => {
    it("stores output_json as a proper JSONB object (not double-encoded string)", async () => {
      const { runId } = await acquirePipelineLock(TEST_PIPELINE);
      const step = await createPipelineStep({ runId: runId!, stepName: "landscape" });
      const payload = {
        trendingCategories: [{ category: "fitness", score: 0.8 }],
        nested: { a: [1, 2, 3] },
      };
      await updatePipelineStep(step.id, {
        status: "completed",
        outputSummary: "done",
        outputJson: payload,
      });

      const db = getDb();
      const rows = (await db.unsafe(
        `SELECT jsonb_typeof(output_json) as t, output_json as v FROM pipeline_steps WHERE id = $1`,
        [step.id],
      )) as Array<{ t: string; v: unknown }>;
      expect(rows[0]!.t).toBe("object"); // was 'string' before fix
      expect(rows[0]!.v).toEqual(payload);
    });

    it("stores result_summary as a proper JSONB object (not double-encoded string)", async () => {
      const { runId } = await acquirePipelineLock(TEST_PIPELINE);
      const summary: PipelineResultSummary = {
        totalSourcesQueried: 8,
        totalSignalsFound: 42,
        totalIdeasGenerated: 5,
        totalIdeasKept: 3,
        totalIdeasDuplicate: 1,
        topThemes: ["fitness", "productivity"],
        ideaIds: ["abc", "def"],
        durationMs: 12345,
      };
      await updatePipelineRun(runId!, { status: "completed", resultSummary: summary });

      const db = getDb();
      const rows = (await db.unsafe(
        `SELECT jsonb_typeof(result_summary) as t, result_summary as v FROM pipeline_runs WHERE id = $1`,
        [runId!],
      )) as Array<{ t: string; v: unknown }>;
      expect(rows[0]!.t).toBe("object");
      expect(rows[0]!.v).toEqual(summary);
    });

    it("backward-compat: findCompletedStep reads a legacy double-encoded row correctly", async () => {
      const { runId } = await acquirePipelineLock(TEST_PIPELINE);
      const db = getDb();
      const legacyPayload = { hello: "legacy", items: [1, 2, 3] };
      const legacyJson = JSON.stringify(legacyPayload);
      // Insert a step with a manually double-encoded output_json (simulates pre-fix rows).
      const stepId = crypto.randomUUID();
      await db.unsafe(
        `INSERT INTO pipeline_steps (id, run_id, step_name, status, started_at, last_heartbeat)
         VALUES ($1, $2, 'legacy_step', 'completed', extract(epoch from now())::int, NULL)`,
        [stepId, runId!],
      );
      // Set output_json as a double-encoded value (string stored in jsonb).
      await db.unsafe(
        `UPDATE pipeline_steps SET output_json = to_json($1::text)::jsonb WHERE id = $2`,
        [legacyJson, stepId],
      );

      // Verify it is actually double-encoded.
      const check = (await db.unsafe(
        `SELECT jsonb_typeof(output_json) as t FROM pipeline_steps WHERE id = $1`,
        [stepId],
      )) as Array<{ t: string }>;
      expect(check[0]!.t).toBe("string"); // confirm legacy encoding

      // findCompletedStep must still recover the payload via parseJson.
      const result = await findCompletedStep(runId!, "legacy_step");
      expect(result.found).toBe(true);
      expect(result.hasOutput).toBe(true);
      expect(result.outputJson).toEqual(legacyPayload);
    });
  });
});

// ── getPipelineIdeas — sort ordering and injection guard ───────────────────────

const IDEAS_PIPELINE = "test-ideas-sort-pipeline";

async function cleanupIdeasPipeline(): Promise<void> {
  const db = getDb();
  await db.unsafe(
    `DELETE FROM generated_ideas WHERE pipeline_run_id IN
       (SELECT id FROM pipeline_runs WHERE pipeline_id = $1)`,
    [IDEAS_PIPELINE],
  );
  await db.unsafe(
    `DELETE FROM pipeline_steps WHERE run_id IN
       (SELECT id FROM pipeline_runs WHERE pipeline_id = $1)`,
    [IDEAS_PIPELINE],
  );
  await db.unsafe(`DELETE FROM pipeline_runs WHERE pipeline_id = $1`, [
    IDEAS_PIPELINE,
  ]);
}

/**
 * Insert a generated_idea directly (bypass store helpers) so we can control
 * created_at and quality_score precisely for ordering assertions.
 */
async function insertIdea(
  db: ReturnType<typeof getDb>,
  opts: {
    readonly runId: string;
    readonly title: string;
    readonly createdAt: number;
    readonly qualityScore: number;
  },
): Promise<void> {
  await db.unsafe(
    `INSERT INTO generated_ideas
       (id, agent_id, title, summary, reasoning, sources_used, category,
        quality_score, pipeline_run_id, created_at)
     VALUES ($1, 'agent-sort-test', $2, 'summary', 'reasoning', '', 'mobile_app',
             $3, $4, $5)`,
    [crypto.randomUUID(), opts.title, opts.qualityScore, opts.runId, opts.createdAt],
  );
}

describe("getPipelineIdeas — sort ordering and injection guard", () => {
  beforeEach(async () => {
    await initDb(process.env.DATABASE_URL);
    await cleanupIdeasPipeline();
  });

  afterEach(async () => {
    await cleanupIdeasPipeline();
    await closeDb();
  });

  it("sort='newest' returns ideas ordered by created_at DESC (most recent first)", async () => {
    const db = getDb();
    const { runId } = await acquirePipelineLock(IDEAS_PIPELINE);

    const now = Math.floor(Date.now() / 1000);
    await insertIdea(db, { runId: runId!, title: "Oldest", createdAt: now - 200, qualityScore: 3 });
    await insertIdea(db, { runId: runId!, title: "Middle", createdAt: now - 100, qualityScore: 3 });
    await insertIdea(db, { runId: runId!, title: "Newest", createdAt: now, qualityScore: 3 });

    const ideas = await getPipelineIdeas({ runId: runId!, sort: "newest" });
    const titles = ideas.map((r) => r["title"] as string);

    expect(titles[0]).toBe("Newest");
    expect(titles[titles.length - 1]).toBe("Oldest");
  });

  it("sort='oldest' returns ideas ordered by created_at ASC (oldest first)", async () => {
    const db = getDb();
    const { runId } = await acquirePipelineLock(IDEAS_PIPELINE);

    const now = Math.floor(Date.now() / 1000);
    await insertIdea(db, { runId: runId!, title: "Oldest", createdAt: now - 200, qualityScore: 3 });
    await insertIdea(db, { runId: runId!, title: "Middle", createdAt: now - 100, qualityScore: 3 });
    await insertIdea(db, { runId: runId!, title: "Newest", createdAt: now, qualityScore: 3 });

    const ideas = await getPipelineIdeas({ runId: runId!, sort: "oldest" });
    const titles = ideas.map((r) => r["title"] as string);

    expect(titles[0]).toBe("Oldest");
    expect(titles[titles.length - 1]).toBe("Newest");
  });

  it("sort='score' returns ideas ordered by quality_score DESC (highest first)", async () => {
    const db = getDb();
    const { runId } = await acquirePipelineLock(IDEAS_PIPELINE);

    const now = Math.floor(Date.now() / 1000);
    await insertIdea(db, { runId: runId!, title: "LowScore", createdAt: now - 200, qualityScore: 1 });
    await insertIdea(db, { runId: runId!, title: "MidScore", createdAt: now - 100, qualityScore: 3 });
    await insertIdea(db, { runId: runId!, title: "HighScore", createdAt: now, qualityScore: 5 });

    const ideas = await getPipelineIdeas({ runId: runId!, sort: "score" });
    const titles = ideas.map((r) => r["title"] as string);

    expect(titles[0]).toBe("HighScore");
    expect(titles[titles.length - 1]).toBe("LowScore");
  });

  it("unknown sort value falls back to created_at DESC safely (does not throw or inject)", async () => {
    const db = getDb();
    const { runId } = await acquirePipelineLock(IDEAS_PIPELINE);

    const now = Math.floor(Date.now() / 1000);
    await insertIdea(db, { runId: runId!, title: "Alpha", createdAt: now - 50, qualityScore: 3 });
    await insertIdea(db, { runId: runId!, title: "Beta", createdAt: now, qualityScore: 3 });

    // Injection-style value must not error and must fall back to the default ordering
    const ideas = await getPipelineIdeas({
      runId: runId!,
      // Type-cast simulates what would happen if validation were bypassed at the boundary.
      sort: "x; DROP TABLE generated_ideas;--" as "newest",
    });

    // The table must still exist and the two ideas must be returned
    expect(ideas.length).toBe(2);
    // Fallback ordering is newest (created_at DESC) — Beta was inserted later
    const titles = ideas.map((r) => r["title"] as string);
    expect(titles[0]).toBe("Beta");
  });

  it("absent sort defaults to newest (created_at DESC)", async () => {
    const db = getDb();
    const { runId } = await acquirePipelineLock(IDEAS_PIPELINE);

    const now = Math.floor(Date.now() / 1000);
    await insertIdea(db, { runId: runId!, title: "Earlier", createdAt: now - 50, qualityScore: 3 });
    await insertIdea(db, { runId: runId!, title: "Later", createdAt: now, qualityScore: 3 });

    const ideas = await getPipelineIdeas({ runId: runId! });
    const titles = ideas.map((r) => r["title"] as string);
    expect(titles[0]).toBe("Later");
  });
});
