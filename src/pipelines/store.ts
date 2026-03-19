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
  };
}

// ── Orphan recovery (runs stuck as 'running' after process restart) ──────

/**
 * Mark any runs stuck in 'running' as 'failed'.
 * Call this at startup to clean up after unclean shutdowns.
 */
export async function recoverOrphanedRuns(): Promise<number> {
  const db = getDb();
  const rows = await db`
    UPDATE pipeline_runs
    SET status = 'failed',
        error = 'Run was interrupted by process restart',
        finished_at = ${now()}
    WHERE status = 'running'
    RETURNING id
  `;
  return rows.length;
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
  const configJson =
    update.config !== undefined
      ? JSON.stringify(update.config)
      : undefined;
  const resultJson =
    update.resultSummary !== undefined
      ? JSON.stringify(update.resultSummary)
      : undefined;
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
  const rows = (await db`
    INSERT INTO pipeline_steps (run_id, step_name, started_at)
    VALUES (${input.runId}, ${input.stepName}, ${now()})
    RETURNING *
  `) as Array<Record<string, unknown>>;
  return rowToStep(rows[0]!);
}

export async function updatePipelineStep(
  id: string,
  update: {
    readonly status?: StepStatus;
    readonly inputSummary?: string;
    readonly outputSummary?: string;
    readonly durationMs?: number;
    readonly error?: string;
    readonly finishedAt?: number;
  },
): Promise<void> {
  const db = getDb();
  const finished =
    update.finishedAt ??
    (update.status === "completed" || update.status === "failed"
      ? now()
      : undefined);

  await db`
    UPDATE pipeline_steps
    SET
      status = COALESCE(${update.status ?? null}, status),
      input_summary = COALESCE(${update.inputSummary ?? null}, input_summary),
      output_summary = COALESCE(${update.outputSummary ?? null}, output_summary),
      duration_ms = COALESCE(${update.durationMs ?? null}, duration_ms),
      error = COALESCE(${update.error ?? null}, error),
      finished_at = COALESCE(${finished ?? null}, finished_at)
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

  const orderBy =
    filter.sort === "oldest"
      ? "created_at ASC"
      : filter.sort === "score"
        ? "quality_score DESC NULLS LAST, created_at DESC"
        : "created_at DESC";

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
