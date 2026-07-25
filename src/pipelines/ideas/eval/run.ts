/**
 * Orchestrator for the offline ideas eval harness — the previously-missing
 * "glue" between the pure aggregation/regression math in `./aggregate` +
 * `./regression` and the real `generated_ideas` / `idea_feedback` /
 * `idea_eval_runs` tables.
 *
 * Flow: load rows (`./load`) -> aggregate (`./aggregate`'s `aggregateEval`) ->
 * compare against a trailing baseline of prior `idea_eval_runs` snapshots
 * (`./regression`'s `computeBaseline` / `detectRegressions`) -> optionally
 * persist an immutable snapshot row. Every optional GIANT/embedding/judge/A-B
 * section of `aggregateEval` is either populated cheaply from already-persisted
 * columns (GIANT, from `giant_scores_json`) or passed as null (embeddingNovelty,
 * sigeAb, tasteLoop, signalRanker) — those all require an LLM judge or an
 * embedding provider this harness deliberately does not wire up, per
 * `aggregateEval`'s own "optional & graceful" contract.
 *
 * The LLM judge stays OFF by default (`judgeEnabled: false`) so a run never
 * costs tokens unless a future caller explicitly opts in.
 */

import { getDb } from "../../../store/db";
import { createLogger } from "../../../logger";
import { getErrorMessage } from "../../../lib/error-serialization";
import { loadEvalIdeas, loadEvalOutcomes, type EvalLoadScope } from "./load";
import { aggregateEval, aggregateGiantRun, type EvalAggregate, type GiantScoredIdea } from "./aggregate";
import { detectRegressions, type RegressionAlert } from "./regression";
import { hasCitedDemand } from "../demand";
import { parseGiant } from "../giant";

const logger = createLogger("ideas:eval:run");

/** Trailing window size used to build the regression baseline. */
const DEFAULT_TRAILING_WINDOW = 10;

/** Row shape persisted to / read back from `idea_eval_runs` (migration 012). */
interface IdeaEvalRunRow {
  readonly id: string;
  readonly pipeline_run_id: string | null;
  readonly category: string | null;
  readonly total_ideas: number;
  readonly aggregate_json: unknown;
  readonly alerts_json: unknown;
  readonly judge_enabled: boolean;
  readonly created_at: number | string;
}

/** Parse a possibly-string jsonb value defensively (see `./load`'s `parseJson`). */
function parseJson<T>(val: unknown, fallback: T): T {
  if (val === null || val === undefined) return fallback;
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (!trimmed || trimmed === "null") return fallback;
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      return fallback;
    }
  }
  return val as T;
}

/**
 * Load the trailing window of prior `idea_eval_runs` aggregates (most recent
 * first, capped at `windowSize`), optionally scoped to the same category so a
 * per-category run baselines against per-category history. Degrades
 * gracefully: a read failure yields [] so a run can still proceed with an
 * empty baseline (no regressions flagged) rather than throwing.
 */
async function loadTrailingAggregates(
  category: string | null,
  windowSize: number,
): Promise<readonly EvalAggregate[]> {
  try {
    const db = getDb();
    const rows = (await db.unsafe(
      `SELECT aggregate_json
       FROM idea_eval_runs
       WHERE ($1::text IS NULL OR category = $1)
       ORDER BY created_at DESC
       LIMIT $2::int`,
      [category, windowSize],
    )) as unknown as readonly { readonly aggregate_json: unknown }[];
    return rows.map((r) => parseJson<EvalAggregate>(r.aggregate_json, {} as EvalAggregate));
  } catch (error) {
    logger.error("Failed to load trailing idea_eval_runs for baseline", {
      error: getErrorMessage(error),
      category,
    });
    return [];
  }
}

/**
 * Cheaply build the run-level GIANT aggregate from the `giant_scores_json`
 * already persisted on `generated_ideas` (via `parseGiant`, the EXISTING
 * tolerant parser) and pair each idea's demand-evidence flag from its own
 * loaded `demand` artifact via {@link hasCitedDemand}. Ideas without a
 * `giant_scores_json` are simply excluded — this is a best-effort enrichment
 * over whatever fraction of the batch has been GIANT-scored, not a
 * requirement. Returns null when NO idea in scope carries GIANT scores, so a
 * pre-GIANT run still produces a valid (giant: null) snapshot.
 */
function buildGiantScoredIdeas(
  rows: readonly {
    readonly id: string;
    readonly giant_scores_json: unknown;
    readonly hasDemandEvidence: boolean;
  }[],
): readonly GiantScoredIdea[] {
  const out: GiantScoredIdea[] = [];
  for (const row of rows) {
    if (row.giant_scores_json === null || row.giant_scores_json === undefined) continue;
    const raw = parseJson<Record<string, unknown> | null>(row.giant_scores_json, null);
    if (raw === null) continue;
    const parsed = parseGiant(raw);
    out.push({ id: row.id, scores: parsed.scores, hasDemandEvidence: row.hasDemandEvidence });
  }
  return out;
}

export interface RunIdeaEvalOptions extends EvalLoadScope {
  /** Skip the INSERT into idea_eval_runs — compute and return only. */
  readonly dryRun?: boolean;
  /** Trailing-window size for the regression baseline. Default 10. */
  readonly trailingWindow?: number;
  /** Pipeline run id to stamp on the snapshot, if this run is tied to one. */
  readonly pipelineRunId?: string | null;
}

export interface RunIdeaEvalResult {
  readonly aggregate: EvalAggregate;
  readonly alerts: readonly RegressionAlert[];
  readonly totalIdeas: number;
  readonly totalOutcomes: number;
  /** The persisted row id, or null when `dryRun` skipped the INSERT. */
  readonly runId: string | null;
}

/**
 * Run one full eval pass: load -> aggregate -> compare against trailing
 * baseline -> optionally persist an immutable `idea_eval_runs` snapshot.
 *
 * Never throws on the READ/aggregate side (loaders already degrade to []); the
 * INSERT (when not `dryRun`) is allowed to throw so a write failure surfaces
 * to the caller rather than silently pretending a snapshot was recorded.
 */
export async function runIdeaEval(
  options: RunIdeaEvalOptions = {},
): Promise<RunIdeaEvalResult> {
  const category = options.category ?? null;
  const trailingWindow = options.trailingWindow ?? DEFAULT_TRAILING_WINDOW;

  const ideas = await loadEvalIdeas({
    ...(category !== null ? { category } : {}),
    ...(options.sinceEpochSeconds !== undefined
      ? { sinceEpochSeconds: options.sinceEpochSeconds }
      : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
  });
  const ideaIds = ideas.map((i) => i.id);
  const outcomes = await loadEvalOutcomes({ ideaIds });

  // Re-fetch just the raw giant_scores_json column for the loaded ideas so we
  // can cheaply build the GIANT run aggregate without widening EvalIdeaRow's
  // own shape. Best-effort: on failure, giant stays null (graceful, per the
  // module contract) rather than failing the whole run.
  let giant = null as ReturnType<typeof aggregateGiantRun> | null;
  try {
    if (ideaIds.length > 0) {
      const db = getDb();
      const giantRows = (await db`
        SELECT id, giant_scores_json
        FROM generated_ideas
        WHERE id IN ${db(ideaIds)}
      `) as unknown as readonly { readonly id: string; readonly giant_scores_json: unknown }[];
      const demandById = new Map(ideas.map((i) => [i.id, i.demand ?? null]));
      const scoped = giantRows.map((r) => ({
        id: r.id,
        giant_scores_json: r.giant_scores_json,
        hasDemandEvidence: (() => {
          const artifact = demandById.get(r.id) ?? null;
          return artifact !== null ? hasCitedDemand(artifact) : false;
        })(),
      }));
      const scoredIdeas = buildGiantScoredIdeas(scoped);
      if (scoredIdeas.length > 0) giant = aggregateGiantRun(scoredIdeas);
    }
  } catch (error) {
    logger.error("Failed to build GIANT run aggregate for eval (continuing without it)", {
      error: getErrorMessage(error),
    });
  }

  const aggregate = aggregateEval({ ideas, outcomes, giant });

  const trailing = await loadTrailingAggregates(category, trailingWindow);
  const alerts = detectRegressions(aggregate, trailing);

  let runId: string | null = null;
  if (!options.dryRun) {
    runId = await persistEvalRun({
      pipelineRunId: options.pipelineRunId ?? null,
      category,
      totalIdeas: aggregate.totalIdeas,
      aggregate,
      alerts,
      judgeEnabled: false,
    });
  }

  return {
    aggregate,
    alerts,
    totalIdeas: ideas.length,
    totalOutcomes: outcomes.length,
    runId,
  };
}

/**
 * Append one immutable snapshot row to `idea_eval_runs` (migration 012 — the
 * table already exists; this is the missing WRITER the module doc of
 * `./store` claimed but never implemented). Throws on failure so callers know
 * the snapshot was NOT recorded rather than silently swallowing it.
 */
async function persistEvalRun(params: {
  readonly pipelineRunId: string | null;
  readonly category: string | null;
  readonly totalIdeas: number;
  readonly aggregate: EvalAggregate;
  readonly alerts: readonly RegressionAlert[];
  readonly judgeEnabled: boolean;
}): Promise<string> {
  const db = getDb();
  try {
    const rows = (await db`
      INSERT INTO idea_eval_runs
        (pipeline_run_id, category, total_ideas, aggregate_json, alerts_json, judge_enabled)
      VALUES (
        ${params.pipelineRunId},
        ${params.category},
        ${params.totalIdeas},
        ${JSON.stringify(params.aggregate)}::jsonb,
        ${JSON.stringify(params.alerts)}::jsonb,
        ${params.judgeEnabled}
      )
      RETURNING id
    `) as unknown as readonly IdeaEvalRunRow[];
    const inserted = rows[0];
    if (!inserted) throw new Error("INSERT into idea_eval_runs returned no row");
    return inserted.id;
  } catch (error) {
    logger.error("Failed to persist idea_eval_runs snapshot", {
      error: getErrorMessage(error),
      category: params.category,
      totalIdeas: params.totalIdeas,
    });
    throw new Error(`Failed to persist idea_eval_runs snapshot: ${getErrorMessage(error)}`);
  }
}
