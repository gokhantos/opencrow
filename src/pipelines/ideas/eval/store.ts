/**
 * DB access for the offline ideas eval harness.
 *
 * Reads generated_ideas + idea_feedback into the pure-aggregation row shapes,
 * and appends immutable eval snapshots to idea_eval_runs (migration 012). Every
 * function degrades gracefully: a read failure returns [] and a write failure
 * returns null, so an eval run never breaks the caller.
 *
 * The parsing of critique_subscores_json out of generated_ideas is split into a
 * PURE helper ({@link parseCritiqueSubscores}) so it can be unit-tested without a DB.
 */

import { getDb } from "../../../store/db";
import { createLogger } from "../../../logger";
import type {
  CritiqueSubscores,
  EvalAggregate,
  EvalIdeaRow,
  EvalOutcomeRow,
} from "./aggregate";
import type { RegressionAlert } from "./regression";

const log = createLogger("ideas:eval:store");

// ── Pure parsing helpers ───────────────────────────────────────────────────────

/**
 * Parse a persisted critique_subscores_json value into a CritiqueSubscores, or
 * null when absent/malformed. Accepts either a JSON string (sql driver returning
 * text) or an already-parsed object (JSONB auto-parse). PURE — unit-testable.
 */
export function parseCritiqueSubscores(value: unknown): CritiqueSubscores | null {
  if (value === null || value === undefined) return null;

  let obj: unknown = value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed || trimmed === "null") return null;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;

  const src = obj as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(src)) {
    if (typeof raw === "number" && Number.isFinite(raw)) {
      out[key] = raw;
    }
  }
  return Object.keys(out).length > 0 ? (out as CritiqueSubscores) : null;
}

// ── Reads ──────────────────────────────────────────────────────────────────────

interface RawIdeaRow {
  readonly id: string;
  readonly title: string | null;
  readonly summary: string | null;
  readonly category: string | null;
  readonly pipeline_stage: string | null;
  readonly critique_subscores_json: unknown;
  readonly created_at: string | number;
}

export interface LoadIdeasOptions {
  readonly category?: string;
  readonly pipelineRunId?: string;
  /** Only consider ideas created at/after this epoch-second timestamp. */
  readonly since?: number;
  readonly limit?: number;
}

/**
 * Load generated_ideas into EvalIdeaRow shape. Filters are optional and AND-ed.
 * Returns [] on failure.
 */
export async function loadEvalIdeas(
  opts?: LoadIdeasOptions,
): Promise<readonly EvalIdeaRow[]> {
  const db = getDb();
  const limit = Math.min(Math.max(1, opts?.limit ?? 2000), 10000);
  try {
    const rows = (await db`
      SELECT id, title, summary, category, pipeline_stage, critique_subscores_json, created_at
      FROM generated_ideas
      WHERE (${opts?.category ?? null}::text IS NULL OR category = ${opts?.category ?? null})
        AND (${opts?.pipelineRunId ?? null}::text IS NULL OR pipeline_run_id = ${opts?.pipelineRunId ?? null})
        AND (${opts?.since ?? null}::bigint IS NULL OR created_at >= ${opts?.since ?? null})
      ORDER BY created_at DESC
      LIMIT ${limit}
    `) as RawIdeaRow[];

    return rows.map((r) => ({
      id: r.id,
      title: r.title ?? "",
      summary: r.summary ?? "",
      category: r.category ?? "unknown",
      pipeline_stage: r.pipeline_stage,
      critique_subscores: parseCritiqueSubscores(r.critique_subscores_json),
      created_at: Number(r.created_at),
    }));
  } catch (err) {
    log.warn("loadEvalIdeas failed; returning empty set", { err });
    return [];
  }
}

interface RawOutcomeRow {
  readonly idea_id: string;
  readonly kind: string;
  readonly actor: string | null;
}

/**
 * Load idea_feedback outcome events for the given idea ids. Returns [] on
 * failure or when no ids are supplied.
 */
export async function loadEvalOutcomes(
  ideaIds: readonly string[],
): Promise<readonly EvalOutcomeRow[]> {
  if (ideaIds.length === 0) return [];
  const db = getDb();
  try {
    const rows = (await db`
      SELECT idea_id, kind, actor
      FROM idea_feedback
      WHERE idea_id = ANY(${ideaIds as string[]})
    `) as RawOutcomeRow[];
    return rows.map((r) => ({ idea_id: r.idea_id, kind: r.kind, actor: r.actor }));
  } catch (err) {
    log.warn("loadEvalOutcomes failed; returning empty set", { err });
    return [];
  }
}

// ── Snapshot persistence ───────────────────────────────────────────────────────

export interface PersistEvalSnapshotParams {
  readonly aggregate: EvalAggregate;
  readonly alerts: readonly RegressionAlert[];
  readonly judgeEnabled: boolean;
  readonly category?: string | null;
  readonly pipelineRunId?: string | null;
}

/**
 * Append one immutable eval snapshot to idea_eval_runs. Returns the new row id
 * or null on failure (e.g. pre-migration DB). Never throws.
 */
export async function persistEvalSnapshot(
  params: PersistEvalSnapshotParams,
): Promise<string | null> {
  const db = getDb();
  try {
    const aggregateJson = JSON.stringify(params.aggregate);
    const alertsJson = JSON.stringify(params.alerts);
    const rows = (await db`
      INSERT INTO idea_eval_runs
        (pipeline_run_id, category, total_ideas, aggregate_json, alerts_json, judge_enabled)
      VALUES (
        ${params.pipelineRunId ?? null},
        ${params.category ?? null},
        ${params.aggregate.totalIdeas},
        ${aggregateJson}::jsonb,
        ${alertsJson}::jsonb,
        ${params.judgeEnabled}
      )
      RETURNING id
    `) as Array<{ id: string }>;
    return rows[0]?.id ?? null;
  } catch (err) {
    log.warn("persistEvalSnapshot failed; snapshot not stored", { err });
    return null;
  }
}

interface RawSnapshotRow {
  readonly aggregate_json: unknown;
}

/**
 * Load the trailing N eval aggregates (most recent first) for use as a
 * regression baseline. Optionally scoped to a category. Returns [] on failure.
 */
export async function loadTrailingAggregates(
  limit: number,
  category?: string | null,
): Promise<readonly EvalAggregate[]> {
  const db = getDb();
  const capped = Math.min(Math.max(1, limit), 200);
  try {
    const rows = (await db`
      SELECT aggregate_json
      FROM idea_eval_runs
      WHERE (${category ?? null}::text IS NULL OR category = ${category ?? null})
      ORDER BY created_at DESC
      LIMIT ${capped}
    `) as RawSnapshotRow[];

    const out: EvalAggregate[] = [];
    for (const r of rows) {
      const parsed = parseAggregate(r.aggregate_json);
      if (parsed) out.push(parsed);
    }
    return out;
  } catch (err) {
    log.warn("loadTrailingAggregates failed; returning empty baseline", { err });
    return [];
  }
}

function parseAggregate(value: unknown): EvalAggregate | null {
  let obj: unknown = value;
  if (typeof value === "string") {
    try {
      obj = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof obj !== "object" || obj === null) return null;
  // Trust the shape we wrote; the harness only ever stores EvalAggregate here.
  return obj as EvalAggregate;
}
