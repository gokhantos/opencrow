/**
 * Database operations for pipeline runs and steps.
 */

import { getDb } from "../store/db";
import type {
  PipelineRun,
  PipelineStep,
  PipelineConfig,
  PipelineResultSummary,
  PipelineStatus,
  StepStatus,
  IdeaCategory,
} from "./types";

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function parseJson<T>(val: unknown, fallback: T): T {
  if (val === null || val === undefined) return fallback;
  if (typeof val === "string") {
    try {
      return JSON.parse(val) as T;
    } catch {
      return fallback;
    }
  }
  return val as T;
}

function rowToRun(r: Record<string, unknown>): PipelineRun {
  return {
    id: r.id as string,
    pipelineId: r.pipeline_id as string,
    status: r.status as PipelineStatus,
    category: r.category as IdeaCategory,
    config: parseJson<PipelineConfig>(r.config, {} as PipelineConfig),
    resultSummary: parseJson<PipelineResultSummary | null>(
      r.result_summary,
      null,
    ),
    error: (r.error as string) ?? null,
    startedAt: r.started_at ? Number(r.started_at) : null,
    finishedAt: r.finished_at ? Number(r.finished_at) : null,
    createdAt: Number(r.created_at ?? 0),
  };
}

function rowToStep(r: Record<string, unknown>): PipelineStep {
  return {
    id: r.id as string,
    runId: r.run_id as string,
    stepName: r.step_name as string,
    status: r.status as StepStatus,
    inputSummary: (r.input_summary as string) ?? null,
    outputSummary: (r.output_summary as string) ?? null,
    durationMs: r.duration_ms ? Number(r.duration_ms) : null,
    error: (r.error as string) ?? null,
    startedAt: r.started_at ? Number(r.started_at) : null,
    finishedAt: r.finished_at ? Number(r.finished_at) : null,
    lastHeartbeat: r.last_heartbeat ? Number(r.last_heartbeat) : null,
  };
}

// ── Atomic pipeline lock ────────────────────────────────────────────────

export interface LockResult {
  readonly acquired: boolean;
  readonly runId?: string;
  readonly reason?: string;
  readonly existingRunId?: string;
}

/**
 * Create a new pipeline run record. Multiple concurrent runs are allowed.
 */
export async function acquirePipelineLock(
  pipelineId: string,
): Promise<LockResult> {
  const db = getDb();
  const ts = now();

  const id = crypto.randomUUID();
  await db`
    INSERT INTO pipeline_runs (id, pipeline_id, status, category, config, started_at, created_at)
    VALUES (${id}, ${pipelineId}, 'running', 'mobile_app', '{}'::jsonb, ${ts}, ${ts})
  `;

  return { acquired: true, runId: id };
}

// ── Run operations ──────────────────────────────────────────────────────

export async function updatePipelineRun(
  id: string,
  update: {
    readonly status?: PipelineStatus;
    readonly category?: IdeaCategory;
    readonly config?: PipelineConfig;
    readonly resultSummary?: PipelineResultSummary;
    readonly error?: string;
    readonly startedAt?: number;
    readonly finishedAt?: number;
  },
): Promise<void> {
  const db = getDb();

  // Always update all provided fields in a single statement
  const status = update.status ?? undefined;
  const category = update.category ?? undefined;
  const configJson = update.config !== undefined ? update.config : undefined;
  const resultJson = update.resultSummary !== undefined ? update.resultSummary : undefined;
  const error = update.error ?? undefined;
  const startedAt = update.startedAt ?? undefined;
  const finishedAt = update.finishedAt ?? undefined;

  await db`
    UPDATE pipeline_runs
    SET
      status = COALESCE(${status ?? null}, status),
      category = COALESCE(${category ?? null}, category),
      config = COALESCE(${configJson ?? null}::jsonb, config),
      result_summary = COALESCE(${resultJson ?? null}::jsonb, result_summary),
      error = COALESCE(${error ?? null}, error),
      started_at = COALESCE(${startedAt ?? null}, started_at),
      finished_at = COALESCE(${finishedAt ?? null}, finished_at)
    WHERE id = ${id}
  `;
}

export async function getPipelineRun(
  id: string,
): Promise<PipelineRun | null> {
  const db = getDb();
  const rows = (await db`
    SELECT * FROM pipeline_runs WHERE id = ${id}
  `) as Array<Record<string, unknown>>;
  return rows.length > 0 ? rowToRun(rows[0]!) : null;
}

export async function getPipelineRuns(
  pipelineId?: string,
  limit = 20,
): Promise<readonly PipelineRun[]> {
  const db = getDb();

  if (pipelineId) {
    const rows = (await db`
      SELECT * FROM pipeline_runs
      WHERE pipeline_id = ${pipelineId}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `) as Array<Record<string, unknown>>;
    return rows.map(rowToRun);
  }

  const rows = (await db`
    SELECT * FROM pipeline_runs
    ORDER BY created_at DESC
    LIMIT ${limit}
  `) as Array<Record<string, unknown>>;
  return rows.map(rowToRun);
}

export async function getLatestRun(
  pipelineId: string,
): Promise<PipelineRun | null> {
  const db = getDb();
  const rows = (await db`
    SELECT * FROM pipeline_runs
    WHERE pipeline_id = ${pipelineId}
    ORDER BY created_at DESC
    LIMIT 1
  `) as Array<Record<string, unknown>>;
  return rows.length > 0 ? rowToRun(rows[0]!) : null;
}

// ── Step operations ─────────────────────────────────────────────────────

export async function createPipelineStep(input: {
  readonly runId: string;
  readonly stepName: string;
}): Promise<PipelineStep> {
  const db = getDb();
  const ts = now();
  // Start 'running' (not 'pending') with a heartbeat so an executing step is
  // distinguishable from one that never started — runStep refreshes the
  // heartbeat while work() is in flight (see touchPipelineStep).
  const rows = (await db`
    INSERT INTO pipeline_steps (run_id, step_name, status, started_at, last_heartbeat)
    VALUES (${input.runId}, ${input.stepName}, 'running', ${ts}, ${ts})
    RETURNING *
  `) as Array<Record<string, unknown>>;
  return rowToStep(rows[0]!);
}

/**
 * Refresh a step's liveness heartbeat. Scoped to `status = 'running'` so a late
 * tick from an interval that hasn't been cleared yet can never resurrect a step
 * that already completed or failed.
 */
export async function touchPipelineStep(id: string): Promise<void> {
  const db = getDb();
  await db`
    UPDATE pipeline_steps
    SET last_heartbeat = ${now()}
    WHERE id = ${id} AND status = 'running'
  `;
}

export async function updatePipelineStep(
  id: string,
  update: {
    readonly status?: StepStatus;
    readonly inputSummary?: string;
    readonly outputSummary?: string;
    /**
     * Full structured step output, persisted for replay-on-resume. Serialized to
     * JSONB; only JSON round-trippable values should be passed (see runStep).
     */
    readonly outputJson?: unknown;
    readonly durationMs?: number;
    readonly error?: string;
    readonly finishedAt?: number;
  },
): Promise<void> {
  const db = getDb();
  const isTerminal =
    update.status === "completed" || update.status === "failed";
  const finished = update.finishedAt ?? (isTerminal ? now() : undefined);

  const outputJson = update.outputJson !== undefined ? update.outputJson : undefined;

  await db`
    UPDATE pipeline_steps
    SET
      status = COALESCE(${update.status ?? null}, status),
      input_summary = COALESCE(${update.inputSummary ?? null}, input_summary),
      output_summary = COALESCE(${update.outputSummary ?? null}, output_summary),
      output_json = COALESCE(${outputJson ?? null}::jsonb, output_json),
      duration_ms = COALESCE(${update.durationMs ?? null}, duration_ms),
      error = COALESCE(${update.error ?? null}, error),
      finished_at = COALESCE(${finished ?? null}, finished_at),
      -- A finished step has no liveness; clear the heartbeat so staleness checks
      -- only ever consider genuinely in-flight ('running') steps.
      last_heartbeat = CASE WHEN ${isTerminal} THEN NULL ELSE last_heartbeat END
    WHERE id = ${id}
  `;
}

// ── Resume support ──────────────────────────────────────────────────────

/**
 * The cached payload of a completed step, for the resume fast-path in runStep.
 * `found` distinguishes "no completed step" from "completed but no payload"
 * (e.g. a pre-migration row) — both mean "re-run", but only `found && hasOutput`
 * is a cache hit.
 */
export interface CompletedStepOutput {
  readonly found: boolean;
  readonly hasOutput: boolean;
  readonly outputJson: unknown;
}

/**
 * Look up an already-completed step's structured output for (runId, stepName).
 * Returns a cache-miss shape (found=false) when no completed step exists, the
 * stored payload is NULL (pre-migration / never persisted), or the stored JSON
 * fails to read — so resume degrades to "re-run that step", never crashes.
 */
export async function findCompletedStep(
  runId: string,
  stepName: string,
): Promise<CompletedStepOutput> {
  const miss: CompletedStepOutput = { found: false, hasOutput: false, outputJson: null };
  try {
    const db = getDb();
    const rows = (await db`
      SELECT output_json FROM pipeline_steps
      WHERE run_id = ${runId} AND step_name = ${stepName} AND status = 'completed'
      ORDER BY started_at DESC
      LIMIT 1
    `) as Array<Record<string, unknown>>;
    if (rows.length === 0) return miss;
    const raw = rows[0]!.output_json;
    if (raw === null || raw === undefined) {
      return { found: true, hasOutput: false, outputJson: null };
    }
    const parsed = parseJson<unknown>(raw, undefined);
    if (parsed === undefined) {
      // Corrupt/unparseable payload — treat as a miss so the step re-runs.
      return { found: true, hasOutput: false, outputJson: null };
    }
    return { found: true, hasOutput: true, outputJson: parsed };
  } catch {
    return miss;
  }
}

/**
 * Whether a run shows a live heartbeat: it has a step still 'running' whose
 * last_heartbeat is within `withinSec`. The cross-process liveness signal — a
 * run actively executing in ANOTHER process keeps ticking, so a resume here can
 * tell "alive but slow" from "interrupted and dead" and refuse to double-
 * dispatch the former. Returns false on any error so resume degrades toward
 * re-dispatch rather than wedging (the in-process registry is the primary
 * guard; this only backstops the multi-instance case).
 */
export async function hasFreshHeartbeat(
  runId: string,
  withinSec: number,
): Promise<boolean> {
  try {
    const db = getDb();
    const cutoff = now() - withinSec;
    const rows = (await db`
      SELECT 1 FROM pipeline_steps
      WHERE run_id = ${runId}
        AND status = 'running'
        AND last_heartbeat IS NOT NULL
        AND last_heartbeat >= ${cutoff}
      LIMIT 1
    `) as Array<Record<string, unknown>>;
    return rows.length > 0;
  } catch {
    return false;
  }
}

/** A run eligible for resume after a process restart, with the state resume needs. */
export interface ResumableRun {
  readonly id: string;
  readonly pipelineId: string;
  readonly config: PipelineConfig;
  readonly category: IdeaCategory;
  readonly resumeAttempts: number;
}

/**
 * Find all runs still marked 'running' — these were interrupted by a process
 * restart (a genuine in-code failure sets 'failed' instead). Returns the
 * pipeline id + persisted config so the orchestrator can re-dispatch them.
 */
export async function findResumableRuns(): Promise<readonly ResumableRun[]> {
  const db = getDb();
  const rows = (await db`
    SELECT id, pipeline_id, config, category, resume_attempts
    FROM pipeline_runs
    WHERE status = 'running'
  `) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    pipelineId: r.pipeline_id as string,
    config: parseJson<PipelineConfig>(r.config, {} as PipelineConfig),
    category: r.category as IdeaCategory,
    resumeAttempts: Number(r.resume_attempts ?? 0),
  }));
}

/** Increment a run's resume attempt counter. Returns the new count. */
export async function incrementResumeAttempts(id: string): Promise<number> {
  const db = getDb();
  const rows = (await db`
    UPDATE pipeline_runs
    SET resume_attempts = resume_attempts + 1
    WHERE id = ${id}
    RETURNING resume_attempts
  `) as Array<Record<string, unknown>>;
  return rows.length > 0 ? Number(rows[0]!.resume_attempts ?? 0) : 0;
}

/** Mark a run failed with an explicit reason (used when resume attempts are exhausted). */
export async function markRunFailed(id: string, error: string): Promise<void> {
  const db = getDb();
  await db`
    UPDATE pipeline_runs
    SET status = 'failed', error = ${error}, finished_at = ${now()}
    WHERE id = ${id}
  `;
}

/**
 * Fail all non-terminal steps for a run so a resume never produces ghost 'running'
 * rows. Only touches steps with status IN ('running', 'pending') — completed
 * checkpoints are preserved so runStep's resume fast-path can replay them.
 * Returns the number of rows updated.
 */
export async function failIncompleteStepsForRun(
  runId: string,
  reason: string,
): Promise<number> {
  const db = getDb();
  const ts = now();
  const rows = (await db`
    UPDATE pipeline_steps
    SET status = 'interrupted',
        error = ${reason},
        finished_at = ${ts},
        last_heartbeat = NULL
    WHERE run_id = ${runId}
      AND status IN ('running', 'pending')
    RETURNING id
  `) as Array<Record<string, unknown>>;
  return rows.length;
}

/**
 * Reset a run to 'running' for a deliberate manual re-trigger: clears the
 * prior error / finish time and resets the resume attempt counter (a manual
 * resume is intentional, so it should not count against the auto-resume cap).
 */
export async function markRunRunning(id: string): Promise<void> {
  const db = getDb();
  await db`
    UPDATE pipeline_runs
    SET status = 'running', resume_attempts = 0, error = NULL,
        finished_at = NULL, started_at = ${now()}
    WHERE id = ${id}
  `;
}

export async function getStepsForRun(
  runId: string,
): Promise<readonly PipelineStep[]> {
  const db = getDb();
  const rows = (await db`
    SELECT * FROM pipeline_steps
    WHERE run_id = ${runId}
    ORDER BY started_at ASC
  `) as Array<Record<string, unknown>>;
  return rows.map(rowToStep);
}

export async function getIdeasForRun(
  runId: string,
): Promise<readonly Record<string, unknown>[]> {
  const db = getDb();
  return db`
    SELECT id, title, summary, reasoning, category, quality_score, sources_used, pipeline_stage, created_at
    FROM generated_ideas
    WHERE pipeline_run_id = ${runId}
    ORDER BY quality_score DESC NULLS LAST
  ` as Promise<Record<string, unknown>[]>;
}

// ── Pipeline ideas (all ideas from pipelines with filters) ──────────

export interface PipelineIdeasFilter {
  readonly runId?: string;
  readonly category?: string;
  readonly stage?: string;
  readonly minScore?: number;
  readonly search?: string;
  readonly limit?: number;
  readonly offset?: number;
  readonly sort?: "newest" | "oldest" | "score";
}

export async function getPipelineIdeas(
  filter: PipelineIdeasFilter = {},
): Promise<readonly Record<string, unknown>[]> {
  const db = getDb();
  const limit = Math.min(filter.limit ?? 50, 200);
  const offset = filter.offset ?? 0;

  // Base: only pipeline-generated ideas
  const runId = filter.runId ?? null;
  const category = filter.category ?? null;
  const stage = filter.stage ?? null;
  const minScore = filter.minScore ?? null;
  const search = filter.search ? `%${filter.search}%` : null;

  // Runtime allowlist guard — must stay in sync with PipelineIdeasFilter.sort.
  // The literal string is interpolated into db.unsafe() so widening the union
  // type must NEVER skip this check.
  const ORDER_BY_ALLOWLIST: Readonly<Record<string, string>> = {
    oldest: "created_at ASC",
    score: "quality_score DESC NULLS LAST, created_at DESC",
    newest: "created_at DESC",
  };
  const orderBy = ORDER_BY_ALLOWLIST[filter.sort ?? "newest"] ?? "created_at DESC";

  // Use conditional WHERE clauses with COALESCE pattern
  return db.unsafe(
    `SELECT g.id, g.title, g.summary, g.reasoning, g.category,
            g.quality_score, g.sources_used, g.pipeline_stage,
            g.pipeline_run_id, g.created_at,
            p.pipeline_id as pipeline_name
     FROM generated_ideas g
     LEFT JOIN pipeline_runs p ON g.pipeline_run_id = p.id
     WHERE g.pipeline_run_id IS NOT NULL
       AND ($1::text IS NULL OR g.pipeline_run_id = $1)
       AND ($2::text IS NULL OR g.category = $2)
       AND ($3::text IS NULL OR COALESCE(g.pipeline_stage, 'idea') = $3)
       AND ($4::float IS NULL OR g.quality_score >= $4)
       AND ($5::text IS NULL OR (g.title ILIKE $5 OR g.summary ILIKE $5))
     ORDER BY ${orderBy}
     LIMIT $6::int OFFSET $7::int`,
    [runId, category, stage, minScore, search, limit, offset],
  ) as Promise<Record<string, unknown>[]>;
}

export async function getPipelineIdeasCount(
  filter: PipelineIdeasFilter = {},
): Promise<number> {
  const db = getDb();
  const runId = filter.runId ?? null;
  const category = filter.category ?? null;
  const stage = filter.stage ?? null;
  const minScore = filter.minScore ?? null;
  const search = filter.search ? `%${filter.search}%` : null;

  const rows = await db.unsafe(
    `SELECT COUNT(*)::int as count
     FROM generated_ideas
     WHERE pipeline_run_id IS NOT NULL
       AND ($1::text IS NULL OR pipeline_run_id = $1)
       AND ($2::text IS NULL OR category = $2)
       AND ($3::text IS NULL OR COALESCE(pipeline_stage, 'idea') = $3)
       AND ($4::float IS NULL OR quality_score >= $4)
       AND ($5::text IS NULL OR (title ILIKE $5 OR summary ILIKE $5))`,
    [runId, category, stage, minScore, search],
  );
  return (rows[0] as { count: number }).count;
}

export async function getPipelineRunsList(): Promise<
  readonly { id: string; pipeline_id: string; created_at: number; idea_count: number }[]
> {
  const db = getDb();
  return db`
    SELECT p.id, p.pipeline_id, p.created_at,
           COUNT(g.id)::int as idea_count
    FROM pipeline_runs p
    LEFT JOIN generated_ideas g ON g.pipeline_run_id = p.id
    WHERE p.status = 'completed'
    GROUP BY p.id, p.pipeline_id, p.created_at
    HAVING COUNT(g.id) > 0
    ORDER BY p.created_at DESC
    LIMIT 50
  ` as Promise<{ id: string; pipeline_id: string; created_at: number; idea_count: number }[]>;
}
