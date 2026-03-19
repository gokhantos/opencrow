/**
 * API routes for pipeline management and execution.
 */

import { Hono } from "hono";
import { z } from "zod";
import { PIPELINE_DEFINITIONS } from "../../pipelines/types";
import type { PipelineConfig } from "../../pipelines/types";
import {
  getPipelineRuns,
  getPipelineRun,
  getStepsForRun,
  getIdeasForRun,
  getLatestRun,
  acquirePipelineLock,
  getPipelineIdeas,
  getPipelineIdeasCount,
  getPipelineRunsList,
} from "../../pipelines/store";
import { updateIdeaStage } from "../../sources/ideas/store";
import { runIdeasPipeline } from "../../pipelines/ideas/pipeline";
import type { MemoryManager } from "../../memory/types";
import { createLogger } from "../../logger";

const log = createLogger("routes:pipelines");

const VALID_SOURCES = [
  "appstore",
  "playstore",
  "producthunt",
  "hackernews",
  "reddit",
  "github",
  "news",
  "x",
] as const;

const VALID_CATEGORIES = [
  "mobile_app",
  "crypto_project",
  "ai_app",
  "open_source",
  "general",
] as const;

const ALLOWED_MODELS = [
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
] as const;


const runConfigSchema = z
  .object({
    category: z.enum(VALID_CATEGORIES).optional(),
    maxIdeas: z.number().int().min(1).max(20).optional(),
    minQualityScore: z.number().min(0).max(5).optional(),
    sourcesToInclude: z
      .array(z.enum(VALID_SOURCES))
      .min(1)
      .max(8)
      .optional(),
    model: z.enum(ALLOWED_MODELS).optional(),
  })
  .strict();

function projectRunForApi(run: {
  readonly id: string;
  readonly status: string;
  readonly resultSummary: unknown;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  readonly createdAt: number;
}) {
  return {
    id: run.id,
    status: run.status,
    resultSummary: run.resultSummary,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    createdAt: run.createdAt,
  };
}

export function createPipelineRoutes(deps?: {
  readonly memoryManager?: MemoryManager | null;
}): Hono {
  const app = new Hono();

  // List available pipelines with their latest run info
  app.get("/pipelines", async (c) => {
    const pipelines = await Promise.all(
      PIPELINE_DEFINITIONS.map(async (def) => {
        const latestRun = await getLatestRun(def.id);
        return {
          ...def,
          latestRun: latestRun ? projectRunForApi(latestRun) : null,
        };
      }),
    );

    return c.json({ success: true, data: pipelines });
  });

  // Get a specific pipeline definition
  app.get("/pipelines/:id", async (c) => {
    const id = c.req.param("id");
    const def = PIPELINE_DEFINITIONS.find((p) => p.id === id);
    if (!def) {
      return c.json({ success: false, error: "Pipeline not found" }, 404);
    }

    const latestRun = await getLatestRun(id);
    return c.json({
      success: true,
      data: {
        ...def,
        latestRun: latestRun ? projectRunForApi(latestRun) : null,
      },
    });
  });

  // Trigger a pipeline run
  app.post("/pipelines/:id/run", async (c) => {
    const id = c.req.param("id");
    const def = PIPELINE_DEFINITIONS.find((p) => p.id === id);
    if (!def) {
      return c.json({ success: false, error: "Pipeline not found" }, 404);
    }

    // Parse and validate config overrides
    let overrides: z.infer<typeof runConfigSchema> = {};
    try {
      const body = await c.req.json().catch(() => ({}));
      if (body && typeof body === "object") {
        const parsed = runConfigSchema.safeParse(body);
        if (!parsed.success) {
          return c.json(
            {
              success: false,
              error: `Invalid config: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
            },
            400,
          );
        }
        overrides = parsed.data;
      }
    } catch {
      // No body — use defaults
    }

    const config: PipelineConfig = {
      ...def.defaultConfig,
      ...(overrides.category && { category: overrides.category }),
      ...(overrides.maxIdeas !== undefined && { maxIdeas: overrides.maxIdeas }),
      ...(overrides.minQualityScore !== undefined && {
        minQualityScore: overrides.minQualityScore,
      }),
      ...(overrides.sourcesToInclude && {
        sourcesToInclude: overrides.sourcesToInclude,
      }),
      ...(overrides.model && { model: overrides.model }),
    };

    // Atomic lock: try to insert a "running" row; fails if one already exists
    // Also enforces a cooldown period between runs
    const lockResult = await acquirePipelineLock(id);
    if (!lockResult.acquired) {
      return c.json(
        {
          success: false,
          error: lockResult.reason,
          runId: lockResult.existingRunId ?? undefined,
        },
        409,
      );
    }

    // Start pipeline in background using the pre-created run ID
    log.info("Starting pipeline run", {
      pipelineId: id,
      runId: lockResult.runId,
      category: config.category,
    });

    runIdeasPipeline(id, config, lockResult.runId!, deps?.memoryManager).catch((err) => {
      log.error("Pipeline run failed", { pipelineId: id, err });
    });

    return c.json(
      {
        success: true,
        message: "Pipeline started",
        runId: lockResult.runId,
      },
      202,
    );
  });

  // List runs for a pipeline
  app.get("/pipelines/:id/runs", async (c) => {
    const id = c.req.param("id");
    const limitParam = c.req.query("limit");
    const limit = limitParam
      ? Math.min(Math.max(1, Number(limitParam)), 50)
      : 20;

    const runs = await getPipelineRuns(id, limit);
    return c.json({ success: true, data: runs });
  });

  // Get all recent runs across all pipelines
  app.get("/pipelines-runs", async (c) => {
    const limitParam = c.req.query("limit");
    const limit = limitParam
      ? Math.min(Math.max(1, Number(limitParam)), 50)
      : 20;

    const runs = await getPipelineRuns(undefined, limit);
    return c.json({ success: true, data: runs });
  });

  // Get a specific run with steps
  app.get("/pipelines-runs/:runId", async (c) => {
    const runId = c.req.param("runId");
    const run = await getPipelineRun(runId);
    if (!run) {
      return c.json({ success: false, error: "Run not found" }, 404);
    }

    const steps = await getStepsForRun(runId);
    return c.json({ success: true, data: { ...run, steps } });
  });

  // Get ideas generated by a specific run
  app.get("/pipelines-runs/:runId/ideas", async (c) => {
    const runId = c.req.param("runId");
    const ideas = await getIdeasForRun(runId);
    return c.json({ success: true, data: ideas });
  });

  // ── Pipeline Ideas endpoints ──────────────────────────────────────

  // List all pipeline-generated ideas with filters
  app.get("/pipeline-ideas", async (c) => {
    const runId = c.req.query("run_id") || undefined;
    const category = c.req.query("category") || undefined;
    const stage = c.req.query("stage") || undefined;
    const minScoreParam = c.req.query("min_score");
    const minScore = minScoreParam ? Number(minScoreParam) : undefined;
    const search = c.req.query("search") || undefined;
    const sort = (c.req.query("sort") as "newest" | "oldest" | "score") || "newest";
    const limitParam = c.req.query("limit");
    const limit = limitParam ? Math.min(Math.max(1, Number(limitParam)), 200) : 50;
    const offsetParam = c.req.query("offset");
    const offset = Math.max(0, Number(offsetParam ?? "0") || 0);

    const filter = { runId, category, stage, minScore, search, sort, limit, offset };

    const [ideas, total] = await Promise.all([
      getPipelineIdeas(filter),
      getPipelineIdeasCount(filter),
    ]);

    return c.json({ success: true, data: ideas, meta: { total, limit, offset } });
  });

  // List pipeline runs that produced ideas (for filter dropdown)
  app.get("/pipeline-ideas/runs", async (c) => {
    const runs = await getPipelineRunsList();
    return c.json({ success: true, data: runs });
  });

  // Update idea stage (archive/restore/validate)
  app.patch("/pipeline-ideas/:id/stage", async (c) => {
    const id = c.req.param("id");
    const validStages = ["idea", "validated", "archived"] as const;

    let body: { stage?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }

    if (!body.stage || !validStages.includes(body.stage as typeof validStages[number])) {
      return c.json(
        { success: false, error: `stage must be one of: ${validStages.join(", ")}` },
        400,
      );
    }

    const updated = await updateIdeaStage(id, body.stage);
    if (!updated) {
      return c.json({ success: false, error: "Idea not found" }, 404);
    }

    return c.json({ success: true, data: updated });
  });

  return app;
}
