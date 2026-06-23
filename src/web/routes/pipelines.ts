/**
 * API routes for pipeline management and execution.
 */

import { Hono } from "hono";
import { z } from "zod";
import { loadConfig } from "../../config/loader";
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
import { getCompetabilityScoredIdeas } from "../../sources/ideas/competability-calibration-query";
import {
  calibrateCompetability,
  type CompetabilityCalibrationReport,
} from "../../pipelines/ideas/competability-calibration";
import { persistedToCandidateCompetability } from "../../pipelines/ideas/competability";
import { getLiftSummary, getRunLift } from "../../pipelines/ideas/lift-attribution";
import { Mem0Client } from "../../sige/knowledge/mem0-client";
import {
  humanStageToVerdict,
  writeHumanOutcomeMemory,
} from "../../pipelines/ideas/outcome-memory";
import { enqueueValidatedIdea } from "../../pipelines/ideas/deferred-outcome-store";
import { clearsAbsenceFloor } from "../../pipelines/ideas/deferred-outcome-reprobe";
import { runIdeasPipeline } from "../../pipelines/ideas/pipeline";
import { DEFAULT_PIPELINE_CONFIG } from "../../pipelines/types";
import {
  AUTONOMOUS_SIGE_PIPELINE_ID,
  runAutonomousSige,
} from "../../pipelines/ideas/pipeline-autonomous";
import { resumeRunById, resumeAllInterrupted } from "../../pipelines/resume";
import type { MemoryManager } from "../../memory/types";
import { createLogger } from "../../logger";

const log = createLogger("routes:pipelines");

// Provenance stamped onto outcome memories that originate from a human verdict
// in the dashboard (PATCH /pipeline-ideas/:id/stage). The run-time path stamps a
// pipeline run id + PROMPT_VERSION; a human verdict has no run, so we use stable
// sentinels — the body sentence and `verdictSource:"human"` carry the meaning.
const HUMAN_VERDICT_RUN_ID = "human-verdict";
const HUMAN_VERDICT_PROMPT_VERSION = "human-verdict";
const HUMAN_VERDICT_MODEL = "human";

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

// Output contract for GET /pipelines/competability-calibration. We `.parse` the
// computed report against this before returning so the wire shape is enforced.
const competabilityDimensionsSchema = z.object({
  capital: z.number(),
  networkEffect: z.number(),
  logistics: z.number(),
  regulated: z.number(),
});

const competabilityCalibrationReportSchema = z.object({
  sampleSize: z.number().int().nonnegative(),
  lowConfidence: z.boolean(),
  histogram: z.array(
    z.object({
      lo: z.number(),
      hi: z.number(),
      count: z.number().int().nonnegative(),
    }),
  ),
  killRateCurve: z.array(
    z.object({
      threshold: z.number(),
      rejectFraction: z.number().min(0).max(1),
    }),
  ),
  currentThreshold: z.number(),
  currentKillRate: z.number().min(0).max(1),
  gatedFraction: z.number().min(0).max(1),
  dimensionAverages: competabilityDimensionsSchema,
  recordsWithDimensions: z.number().int().nonnegative(),
  recommendedThreshold: z.number(),
  recommendationMethod: z.enum(["valley", "target-band-fallback"]),
  caveats: z.string(),
}) satisfies z.ZodType<CompetabilityCalibrationReport>;

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

  // READ-ONLY competability threshold calibration / backtest. Registered BEFORE
  // the dynamic "/pipelines/:id" route so the static path wins (otherwise :id
  // would capture "competability-calibration" → 404). Does NOT change live gate
  // behavior — it backtests the persisted distribution and recommends a threshold.
  app.get("/pipelines/competability-calibration", async (c) => {
    try {
      const records = await getCompetabilityScoredIdeas();
      const report = calibrateCompetability(records);
      const data = competabilityCalibrationReportSchema.parse(report);
      log.info("Competability calibration", {
        sampleSize: data.sampleSize,
        currentThreshold: data.currentThreshold,
        currentKillRate: data.currentKillRate,
        recommendedThreshold: data.recommendedThreshold,
        lowConfidence: data.lowConfidence,
      });
      return c.json({ success: true, data });
    } catch (err) {
      log.error("Competability calibration failed", { err });
      return c.json(
        { success: false, error: "Competability calibration failed" },
        500,
      );
    }
  });

  // READ-ONLY learning-lift summary (Phase 4 A/B holdout). Registered BEFORE the
  // dynamic "/pipelines/:id" route so the static path wins. Reports guided-vs-blind
  // validated/kept rates over a window + per-lesson lift. humanOnly (default true)
  // is the honest signal; humanOnly=false includes proxy/auto self-grades.
  app.get("/pipelines/lift-summary", async (c) => {
    try {
      const windowParam = c.req.query("window");
      const windowSec = windowParam ? Math.max(1, Number(windowParam)) : undefined;
      const humanOnly = c.req.query("humanOnly") !== "false";
      const data = await getLiftSummary({
        ...(windowSec !== undefined && Number.isFinite(windowSec) ? { windowSec } : {}),
        humanOnly,
      });
      return c.json({ success: true, data });
    } catch (err) {
      log.error("Lift summary failed", { err });
      return c.json({ success: false, error: "Lift summary failed" }, 500);
    }
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

  // POST /pipelines/autonomous-sige/run — fire-and-forget one autonomous SIGE
  // pipeline run. Registered BEFORE "/pipelines/:id/run" so the static path wins
  // (the param route would otherwise match id="autonomous-sige" → 404).
  // Default-OFF: returns HTTP 503 when smart.sigeAuto.enabled is false.
  const AUTONOMOUS_SIGE_ALLOWED_MODELS = [
    "claude-haiku-4-5",
    "claude-haiku-4-5-20251001",
  ] as const;

  const autonomousSigeBodySchema = z
    .object({
      model: z.enum(AUTONOMOUS_SIGE_ALLOWED_MODELS).optional(),
    })
    .strict();

  app.post("/pipelines/autonomous-sige/run", async (c) => {
    // Enabled-gate: reject when the feature is disabled (the default) so no
    // bearer-auth holder can trigger an expensive autonomous run while off.
    const appConfig = loadConfig();
    if (!appConfig.pipelines.ideas.smart.sigeAuto.enabled) {
      return c.json(
        {
          success: false,
          error: "autonomous SIGE is not enabled; set smart.sigeAuto.enabled=true",
        },
        503,
      );
    }

    // Model allowlist: body accepts only cheap Haiku-family models.
    let model: (typeof AUTONOMOUS_SIGE_ALLOWED_MODELS)[number] | undefined;
    const rawBody = await c.req.json().catch(() => ({}));
    const parsed = autonomousSigeBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        {
          success: false,
          error: `Invalid body: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
        },
        400,
      );
    }
    model = parsed.data.model;

    const lockResult = await acquirePipelineLock(AUTONOMOUS_SIGE_PIPELINE_ID);
    const pipelineConfig: PipelineConfig = {
      ...DEFAULT_PIPELINE_CONFIG,
      ...(model !== undefined ? { model } : {}),
    };

    log.info("Starting autonomous SIGE pipeline run", { runId: lockResult.runId });
    runAutonomousSige(
      AUTONOMOUS_SIGE_PIPELINE_ID,
      pipelineConfig,
      lockResult.runId!,
      deps?.memoryManager,
    ).catch((err) => {
      log.error("Autonomous SIGE pipeline run failed", { runId: lockResult.runId, err });
    });

    return c.json({ success: true, runId: lockResult.runId }, 202);
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

    // Create run record — multiple concurrent runs are allowed
    const lockResult = await acquirePipelineLock(id);

    // Start pipeline in background
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

  // READ-ONLY per-run learning lift (Phase 4 A/B holdout): the run's arm, idea
  // count, human + any validated counts, and injected-lesson counts. 404 when the
  // run has no arm row (holdout disabled, or pre-feature run).
  app.get("/pipelines-runs/:runId/lift", async (c) => {
    const runId = c.req.param("runId");
    try {
      const lift = await getRunLift(runId);
      if (!lift) {
        return c.json({ success: false, error: "Run lift not found" }, 404);
      }
      return c.json({ success: true, data: lift });
    } catch (err) {
      log.error("Run lift failed", { runId, err });
      return c.json({ success: false, error: "Run lift failed" }, 500);
    }
  });

  // Bulk: resume ALL interrupted runs (still 'running' after a restart).
  // Registered before the :runId route — "resume-interrupted" is a distinct
  // static path so it never collides with a run id.
  app.post("/pipelines-runs/resume-interrupted", async (c) => {
    const count = await resumeAllInterrupted(deps?.memoryManager);
    log.info("Resuming all interrupted runs on demand", { count });
    return c.json({ success: true, resumed: count }, 202);
  });

  // Manually (re-)trigger a previous run by id, on demand. Resumes from the
  // last completed step when checkpoints exist; otherwise re-runs from scratch
  // under the same run id. Fire-and-forget.
  app.post("/pipelines-runs/:runId/resume", async (c) => {
    const runId = c.req.param("runId");
    const result = await resumeRunById(runId, deps?.memoryManager);
    if (!result.ok) {
      if (result.reason === "already_running") {
        return c.json(
          { success: false, error: "Run is already executing" },
          409,
        );
      }
      return c.json({ success: false, error: "Run not found" }, 404);
    }
    log.info("Resuming pipeline run on demand", {
      runId,
      pipelineId: result.pipelineId,
    });
    return c.json(
      { success: true, message: "Run resuming", runId: result.runId },
      202,
    );
  });

  // ── Autonomous SIGE pipeline trigger ─────────────────────────────
  //
  // ── Pipeline Ideas endpoints ──────────────────────────────────────

  // List all pipeline-generated ideas with filters
  app.get("/pipeline-ideas", async (c) => {
    const runId = c.req.query("run_id") || undefined;
    const category = c.req.query("category") || undefined;
    const stage = c.req.query("stage") || undefined;
    const minScoreParam = c.req.query("min_score");
    const minScore = minScoreParam ? Number(minScoreParam) : undefined;
    const search = c.req.query("search") || undefined;
    const VALID_SORTS = ["newest", "oldest", "score"] as const;
    const rawSort = c.req.query("sort") ?? "newest";
    const sort: "newest" | "oldest" | "score" = (
      VALID_SORTS as readonly string[]
    ).includes(rawSort)
      ? (rawSort as "newest" | "oldest" | "score")
      : "newest";
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

    // Records both the projected stage and an append-only idea_feedback
    // event (the learning substrate). Attribute the transition to the web UI.
    const updated = await updateIdeaStage(id, body.stage, { actor: "web" });
    if (!updated) {
      return c.json({ success: false, error: "Idea not found" }, 404);
    }

    // ── Outcome-memory: human-verdict write-back (gated, best-effort) ──────────
    // Feed the REAL-WORLD human verdict back into mem0 so the next synthesis
    // round can REINFORCE validated patterns and AVOID archived ones. Gated on
    // the existing smart.outcomeMemory.writeBack flag (default OFF): when off we
    // build NO client and make NO network call, so the call-graph is unchanged.
    // Wrapped so a mem0 failure can NEVER break the stage update / HTTP response.
    try {
      const appConfig = loadConfig();
      const outcomeMemoryCfg = appConfig.pipelines.ideas.smart.outcomeMemory;
      const sigeMem0 = appConfig.sige?.mem0;
      if (outcomeMemoryCfg.writeBack && sigeMem0) {
        const mem0 = new Mem0Client({
          baseUrl: sigeMem0.baseUrl,
          apiToken: sigeMem0.apiToken,
        });
        await writeHumanOutcomeMemory(
          mem0,
          {
            ideaId: updated.id,
            title: updated.title,
            stage: body.stage,
            // generated_ideas DOES carry segment (migration 015), archetype +
            // giant_composite (migration 014); rowToGeneratedIdea exposes them
            // (archetype validated to the closed enum). Thread the REAL values so
            // the human lesson reads "GIANT composite 3.5/5, demand 4/5" instead
            // of degenerate "n/a/5" noise. (quality_score is a separate 1-5 user
            // rating, NOT the GIANT composite, so it is deliberately not used.)
            segment: updated.segment,
            archetype: updated.archetype,
            giantComposite: updated.giant_composite,
            // Carry the idea's PERSISTED competability scorecard (migration 027)
            // so the human verdict learns moat ↔ outcome too. Lifted from the
            // generated_ideas row; empty fields when the idea was never scored.
            ...persistedToCandidateCompetability(updated.competability_json),
            // Carry the stored demand artifact (migration 015) so the human
            // outcome memory surface demandScore/whitespace, matching the
            // run-time write-back. parseDemandJson already ran in the mapper;
            // we re-use the parsed result directly.
            demand: updated.demand_json,
            runId: HUMAN_VERDICT_RUN_ID,
            promptVersion: HUMAN_VERDICT_PROMPT_VERSION,
            model: HUMAN_VERDICT_MODEL,
            createdAtSec: Math.floor(Date.now() / 1000),
          },
          sigeMem0.ideasUserId,
        );
      }

      // Deferred re-probe enqueue (Phase 2, gated): a HUMAN validation is ground
      // truth, but a deferred demand re-probe still adds a second external check.
      // Use the stored demand_json as the baseline so the re-probe can produce a
      // meaningful "grew" / "decayed" / "flat" verdict instead of always resolving
      // "inconclusive". Only enqueue when the baseline clears the absence floor
      // (confidence > ABSENCE_CONFIDENCE_CAP) — an absence-floor baseline produces
      // an inconclusive diff regardless, so enqueuing it would waste a probe slot.
      // Gated on reprobe.enabled; best-effort (the store helper never throws).
      if (outcomeMemoryCfg.reprobe.enabled && humanStageToVerdict(body.stage) === "validated") {
        const baselineDemand = clearsAbsenceFloor(updated.demand_json)
          ? updated.demand_json
          : null;
        if (baselineDemand !== null) {
          const validatedAt = Math.floor(Date.now() / 1000);
          await enqueueValidatedIdea({
            ideaId: updated.id,
            title: updated.title,
            segment: null,
            archetype: null,
            validationSource: "human",
            validatedAt,
            baselineDemand,
            dueAt: validatedAt + outcomeMemoryCfg.reprobe.delayDays * 86_400,
          });
        }
      }
    } catch (err) {
      // Defense in depth: writeHumanOutcomeMemory is already best-effort, but a
      // config/construction failure must not affect the response either.
      log.warn("Human outcome-memory write-back skipped (non-fatal)", { err, id });
    }

    return c.json({ success: true, data: updated });
  });

  return app;
}
