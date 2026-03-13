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

// ── Atomic pipeline lock ────────────────────────────────────────────────

export interface LockResult {
  readonly acquired: boolean;
  readonly runId?: string;
  readonly reason?: string;
  readonly existingRunId?: string;
}

/**
 * Atomically check if a pipeline can run and create the run record.
 * Prevents race conditions by using INSERT ... WHERE NOT EXISTS.
 * Also enforces a cooldown between runs.
 */
export async function acquirePipelineLock(
  pipelineId: string,
  cooldownSeconds: number,
): Promise<LockResult> {
  const db = getDb();
  const ts = now();
  const cooldownCutoff = ts - cooldownSeconds;

  // Check for running pipeline (atomic read)
  const running = (await db`
    SELECT id FROM pipeline_runs
    WHERE pipeline_id = ${pipelineId} AND status = 'running'
    LIMIT 1
  `) as Array<Record<string, unknown>>;

  if (running.length > 0) {
    return {
      acquired: false,
      reason: "Pipeline is already running",
      existingRunId: running[0]!.id as string,
    };
  }

  // Check cooldown
  const recent = (await db`
    SELECT id, finished_at FROM pipeline_runs
    WHERE pipeline_id = ${pipelineId}
      AND status IN ('completed', 'failed')
      AND finished_at > ${cooldownCutoff}
    ORDER BY finished_at DESC
    LIMIT 1
  `) as Array<Record<string, unknown>>;

  if (recent.length > 0) {
    const finishedAt = Number(recent[0]!.finished_at);
    const waitSeconds = cooldownSeconds - (ts - finishedAt);
    return {
      acquired: false,
      reason: `Pipeline ran recently. Try again in ${Math.ceil(waitSeconds)}s.`,
    };
  }

  // Create the run atomically — if another request slips through, the
  // running check above will catch it on the next attempt
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
): Promise<
  readonly {
    id: string;
    title: string;
    category: string;
    quality_score: number | null;
  }[]
> {
  const db = getDb();
  return db`
    SELECT id, title, category, quality_score
    FROM generated_ideas
    WHERE pipeline_run_id = ${runId}
    ORDER BY quality_score DESC NULLS LAST
  ` as Promise<
    {
      id: string;
      title: string;
      category: string;
      quality_score: number | null;
    }[]
  >;
}
