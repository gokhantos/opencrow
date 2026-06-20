import { getDb } from "../../store/db";
import { createLogger } from "../../logger";
import {
  type FeedbackKind,
  type IdeaFeedbackEvent,
  type IdeaFeedbackRow,
  stageToFeedbackKind,
} from "./feedback";

const log = createLogger("ideas:store");
export interface GeneratedIdea {
  readonly id: string;
  readonly agent_id: string;
  readonly title: string;
  readonly summary: string;
  readonly reasoning: string;
  readonly sources_used: string;
  readonly category: string;
  readonly rating: number | null;
  readonly pipeline_stage: string;
  readonly quality_score: number | null;
  readonly model_references: string;
  readonly created_at: number;
  /** Layer B competability: 0..5 "a small builder can win v1" (migration 027). */
  readonly competability_overall: number | null;
  /**
   * Layer B competability scorecard JSON (migration 027): the 4 moat dimensions,
   * the rationale, the gate decision reason, and the gated flag. Null when the
   * competability gate did not run for this idea.
   */
  readonly competability_json: CompetabilityPersistedJson | null;
}

/**
 * Shape persisted into generated_ideas.competability_json. Mirrors the in-memory
 * candidate competability fields so both idea paths (pipeline + SIGE) round-trip
 * the same structure.
 */
export interface CompetabilityPersistedJson {
  readonly dimensions: {
    readonly capital: number;
    readonly networkEffect: number;
    readonly logistics: number;
    readonly regulated: number;
  };
  readonly overall: number;
  readonly reason: string;
  readonly gated: boolean;
  /**
   * RAW (pre-builder-profile) moat slice. `dimensions`/`overall` above are the
   * EFFECTIVE (decided) values after the builder profile discount; this preserves
   * the objective barriers. Optional — absent on rows written before builder
   * profiles existed (parseCompetabilityJson tolerates both).
   */
  readonly raw?: {
    readonly dimensions: {
      readonly capital: number;
      readonly networkEffect: number;
      readonly logistics: number;
      readonly regulated: number;
    };
    readonly overall: number;
  };
  /** Builder expertise domain that matched this idea (discounting its dominant moat), or null. */
  readonly matchedExpertiseDomain?: string | null;
}

export interface InsertIdeaInput {
  readonly agent_id: string;
  readonly title: string;
  readonly summary: string;
  readonly reasoning: string;
  readonly sources_used: string;
  readonly category: string;
  readonly quality_score: number | null;
  readonly pipeline_run_id?: string;
  readonly source_ids_json?: string;
  /** Layer B competability overall score (0..5), null when not scored. */
  readonly competability_overall?: number | null;
  /** Layer B competability scorecard, null when not scored. */
  readonly competability_json?: CompetabilityPersistedJson | null;
}

/**
 * Raw DB row for generated_ideas as it comes back from Bun.sql. `competability_json`
 * is JSONB: depending on the driver it surfaces either as an already-parsed object
 * or a JSON string, so the mapper normalizes both. All other columns map 1:1 onto
 * the readonly {@link GeneratedIdea} domain type.
 */
export interface GeneratedIdeaRow {
  readonly id: string;
  readonly agent_id: string;
  readonly title: string;
  readonly summary: string;
  readonly reasoning: string;
  readonly sources_used: string;
  readonly category: string;
  readonly rating: number | null;
  readonly pipeline_stage: string;
  readonly quality_score: number | null;
  readonly model_references: string;
  readonly created_at: number;
  readonly competability_overall: number | null;
  readonly competability_json: CompetabilityPersistedJson | string | null;
}

/** Tolerantly parse the competability_json column (object | string | null). */
function parseCompetabilityJson(
  value: CompetabilityPersistedJson | string | null | undefined,
): CompetabilityPersistedJson | null {
  if (value == null) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as CompetabilityPersistedJson;
    } catch {
      return null;
    }
  }
  return value;
}

/** Map a raw generated_ideas row onto the readonly {@link GeneratedIdea} domain type. */
export function rowToGeneratedIdea(row: GeneratedIdeaRow): GeneratedIdea {
  return {
    id: row.id,
    agent_id: row.agent_id,
    title: row.title,
    summary: row.summary,
    reasoning: row.reasoning,
    sources_used: row.sources_used,
    category: row.category,
    rating: row.rating,
    pipeline_stage: row.pipeline_stage,
    quality_score: row.quality_score,
    model_references: row.model_references,
    created_at: row.created_at,
    competability_overall: row.competability_overall,
    competability_json: parseCompetabilityJson(row.competability_json),
  };
}

export interface GetIdeasOptions {
  readonly agentId?: string;
  readonly category?: string;
  readonly pipelineStage?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface IdeaStat {
  readonly agent_id: string;
  readonly category: string;
  readonly count: number;
}

export async function insertIdea(
  input: InsertIdeaInput,
): Promise<GeneratedIdea> {
  const db = getDb();
  const id = crypto.randomUUID();

  // Pass the object directly: Bun.sql serializes a JS object into JSONB. A
  // pre-stringified value would be double-encoded into a JSONB string scalar.
  const competabilityJson = input.competability_json ?? null;

  const rows = await db`
    INSERT INTO generated_ideas (id, agent_id, title, summary, reasoning, sources_used, category, quality_score, pipeline_run_id, source_ids_json, competability_overall, competability_json)
    VALUES (${id}, ${input.agent_id}, ${input.title}, ${input.summary}, ${input.reasoning}, ${input.sources_used}, ${input.category}, ${input.quality_score}, ${input.pipeline_run_id ?? null}, ${input.source_ids_json ?? "[]"}, ${input.competability_overall ?? null}, ${competabilityJson})
    RETURNING *
  `;

  return rowToGeneratedIdea(rows[0] as GeneratedIdeaRow);
}

export async function getIdeas(
  opts?: GetIdeasOptions,
): Promise<readonly GeneratedIdea[]> {
  const db = getDb();
  const limit = opts?.limit;
  const offset = opts?.offset ?? 0;

  if (opts?.agentId && opts?.category) {
    return (limit
      ? db`
        SELECT * FROM generated_ideas
        WHERE agent_id = ${opts.agentId} AND category = ${opts.category}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `
      : db`
        SELECT * FROM generated_ideas
        WHERE agent_id = ${opts.agentId} AND category = ${opts.category}
        ORDER BY created_at DESC
        OFFSET ${offset}
      `) as Promise<GeneratedIdea[]>;
  }

  if (opts?.agentId) {
    return (limit
      ? db`
        SELECT * FROM generated_ideas
        WHERE agent_id = ${opts.agentId}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `
      : db`
        SELECT * FROM generated_ideas
        WHERE agent_id = ${opts.agentId}
        ORDER BY created_at DESC
        OFFSET ${offset}
      `) as Promise<GeneratedIdea[]>;
  }

  if (opts?.category) {
    return (limit
      ? db`
        SELECT * FROM generated_ideas
        WHERE category = ${opts.category}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `
      : db`
        SELECT * FROM generated_ideas
        WHERE category = ${opts.category}
        ORDER BY created_at DESC
        OFFSET ${offset}
      `) as Promise<GeneratedIdea[]>;
  }

  return (limit
    ? db`
      SELECT * FROM generated_ideas
      ORDER BY created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `
    : db`
      SELECT * FROM generated_ideas
      ORDER BY created_at DESC
      OFFSET ${offset}
    `) as Promise<GeneratedIdea[]>;
}

export async function getIdeaById(id: string): Promise<GeneratedIdea | null> {
  const db = getDb();
  const rows = await db`
    SELECT * FROM generated_ideas WHERE id = ${id}
  `;
  const row = rows[0] as GeneratedIdeaRow | undefined;
  return row ? rowToGeneratedIdea(row) : null;
}

export async function getIdeaStats(): Promise<readonly IdeaStat[]> {
  const db = getDb();
  return db`
    SELECT agent_id, category, COUNT(*)::int AS count
    FROM generated_ideas
    GROUP BY agent_id, category
    ORDER BY agent_id, category
  ` as Promise<IdeaStat[]>;
}

export interface RecentIdeaTitle {
  readonly title: string;
  readonly category: string;
}

export async function getIdeasSince(
  agentId: string,
  since: number,
): Promise<readonly GeneratedIdea[]> {
  const db = getDb();
  return db`
    SELECT * FROM generated_ideas
    WHERE agent_id = ${agentId} AND created_at >= ${since}
    ORDER BY created_at ASC
  ` as Promise<GeneratedIdea[]>;
}

export async function getRecentIdeaTitles(
  agentId: string,
  limit = 50,
): Promise<readonly RecentIdeaTitle[]> {
  const db = getDb();
  return db`
    SELECT title, category
    FROM generated_ideas
    WHERE agent_id = ${agentId}
      AND COALESCE(pipeline_stage, 'idea') = 'idea'
    ORDER BY created_at DESC
    LIMIT ${limit}
  ` as Promise<RecentIdeaTitle[]>;
}

export async function getIdeasByStage(
  stage: string,
  limit = 50,
  offset = 0,
): Promise<readonly GeneratedIdea[]> {
  const db = getDb();
  return db`
    SELECT * FROM generated_ideas
    WHERE pipeline_stage = ${stage}
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  ` as Promise<GeneratedIdea[]>;
}

export interface StageCounts {
  readonly stage: string;
  readonly count: number;
}

export async function getStageCounts(): Promise<readonly StageCounts[]> {
  const db = getDb();
  return db`
    SELECT COALESCE(pipeline_stage, 'idea') as stage, COUNT(*)::int as count
    FROM generated_ideas
    GROUP BY COALESCE(pipeline_stage, 'idea')
    ORDER BY count DESC
  ` as Promise<StageCounts[]>;
}

export interface UpdateIdeaStageOptions {
  readonly actor?: string | null;
  readonly runId?: string | null;
  readonly promptVersion?: string | null;
  readonly model?: string | null;
}

/**
 * Project the current `pipeline_stage` onto generated_ideas AND append an
 * immutable transition event to idea_feedback, atomically inside a single
 * transaction. The feedback row is the learning substrate; the projected
 * stage is just the latest view.
 *
 * If the stage has no feedback semantics (see stageToFeedbackKind) only the
 * projection happens. Feedback insertion failure inside the transaction will
 * roll back the stage change so the two never diverge.
 */
export async function updateIdeaStage(
  id: string,
  stage: string,
  opts?: UpdateIdeaStageOptions,
): Promise<GeneratedIdea | null> {
  const db = getDb();
  const kind = stageToFeedbackKind(stage);

  return db.begin(async (tx) => {
    const rows = await tx`
      UPDATE generated_ideas
      SET pipeline_stage = ${stage}
      WHERE id = ${id}
      RETURNING *
    `;
    const updated = (rows[0] as GeneratedIdea) ?? null;
    if (!updated) return null;

    if (kind) {
      await tx`
        INSERT INTO idea_feedback (idea_id, kind, actor, run_id, prompt_version, model)
        VALUES (${id}, ${kind}, ${opts?.actor ?? null}, ${opts?.runId ?? null}, ${opts?.promptVersion ?? null}, ${opts?.model ?? null})
      `;
    }

    return updated;
  });
}

// ============================================================================
// Idea Feedback Event Log (learning substrate)
// ============================================================================

/**
 * Append a single feedback event. Append-only: never updates or deletes.
 * Degrades gracefully — a logging failure must not break the caller's flow,
 * so this returns the inserted row or null rather than throwing.
 */
export async function insertIdeaFeedback(
  event: IdeaFeedbackEvent,
): Promise<IdeaFeedbackRow | null> {
  const db = getDb();
  try {
    const rows = await db`
      INSERT INTO idea_feedback (idea_id, kind, rating, actor, run_id, prompt_version, model)
      VALUES (
        ${event.idea_id},
        ${event.kind},
        ${event.rating ?? null},
        ${event.actor ?? null},
        ${event.run_id ?? null},
        ${event.prompt_version ?? null},
        ${event.model ?? null}
      )
      RETURNING *
    `;
    return (rows[0] as IdeaFeedbackRow) ?? null;
  } catch (err) {
    log.warn("Failed to insert idea feedback event", {
      ideaId: event.idea_id,
      kind: event.kind,
      err,
    });
    return null;
  }
}

/**
 * Read the full event history for a single idea, oldest first.
 */
export async function getIdeaFeedback(
  ideaId: string,
  limit = 200,
): Promise<readonly IdeaFeedbackRow[]> {
  const db = getDb();
  const cappedLimit = Math.min(Math.max(1, limit), 1000);
  return db`
    SELECT * FROM idea_feedback
    WHERE idea_id = ${ideaId}
    ORDER BY created_at ASC
    LIMIT ${cappedLimit}
  ` as Promise<IdeaFeedbackRow[]>;
}

export interface FeedbackKindCount {
  readonly kind: FeedbackKind;
  readonly count: number;
}

/**
 * Aggregate event counts by kind across the whole log (optionally since a
 * given epoch second). Useful for eval dashboards and learning loops.
 */
export async function getFeedbackCountsByKind(
  since?: number,
): Promise<readonly FeedbackKindCount[]> {
  const db = getDb();
  if (since !== undefined) {
    return db`
      SELECT kind, COUNT(*)::int AS count
      FROM idea_feedback
      WHERE created_at >= ${since}
      GROUP BY kind
      ORDER BY count DESC
    ` as Promise<FeedbackKindCount[]>;
  }
  return db`
    SELECT kind, COUNT(*)::int AS count
    FROM idea_feedback
    GROUP BY kind
    ORDER BY count DESC
  ` as Promise<FeedbackKindCount[]>;
}

export interface ValidationCountBySource {
  readonly source_table: string;
  readonly validated_count: number;
}

/**
 * Join validated feedback events back to the source items that produced the
 * ideas, counting how many validations each source table contributed to.
 * This is the raw signal for per-source credibility weighting.
 *
 * Best-effort: depends on source_ids_json being populated; a single idea's
 * sources each count once per validation event. Returns [] on any failure
 * (e.g. malformed JSON) so credibility computation degrades gracefully.
 */
export async function getValidationCountsBySource(): Promise<
  readonly ValidationCountBySource[]
> {
  const db = getDb();
  try {
    return db`
      SELECT src->>'table' AS source_table, COUNT(*)::int AS validated_count
      FROM idea_feedback f
      JOIN generated_ideas gi ON gi.id = f.idea_id
      CROSS JOIN LATERAL jsonb_array_elements(
        COALESCE(NULLIF(gi.source_ids_json, ''), '[]')::jsonb
      ) AS src
      WHERE f.kind = 'validated'
        AND src->>'table' IS NOT NULL
      GROUP BY src->>'table'
      ORDER BY validated_count DESC
    ` as Promise<ValidationCountBySource[]>;
  } catch (err) {
    log.warn("Failed to aggregate validation counts by source", { err });
    return [];
  }
}

// ============================================================================
// Ideas Pipeline Enhancement Functions
// ============================================================================

export interface StageTransition {
  readonly stage: string;
  readonly count: number;
  readonly period: string;
}

export async function getStageTransitions(
  daysBack = 30,
): Promise<readonly StageTransition[]> {
  const db = getDb();
  const since = Math.floor(Date.now() / 1000) - daysBack * 86400;

  // This is a simplified view - in production you'd track actual transitions
  // For now, show current distribution by period
  return db`
    SELECT
      COALESCE(pipeline_stage, 'idea') as stage,
      COUNT(*)::int as count,
      TO_CHAR(TO_TIMESTAMP(created_at), 'YYYY-MM') as period
    FROM generated_ideas
    WHERE created_at >= ${since}
    GROUP BY COALESCE(pipeline_stage, 'idea'), TO_CHAR(TO_TIMESTAMP(created_at), 'YYYY-MM')
    ORDER BY period DESC, count DESC
  ` as Promise<readonly StageTransition[]>;
}

export interface UnvalidatedIdea {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly reasoning: string;
  readonly category: string;
  readonly agent_id: string;
  readonly quality_score: number | null;
  readonly sources_used: string;
  readonly created_at: number;
}

export async function getTopUnvalidatedIdeas(
  limit = 10,
): Promise<readonly UnvalidatedIdea[]> {
  const db = getDb();
  return db`
    SELECT id, title, summary, reasoning, category, agent_id, quality_score, sources_used, created_at
    FROM generated_ideas
    WHERE COALESCE(pipeline_stage, 'idea') = 'idea'
    ORDER BY quality_score DESC NULLS LAST, created_at DESC
    LIMIT ${limit}
  ` as Promise<UnvalidatedIdea[]>;
}

export async function archiveStaleIdeas(
  maxAgeDays = 30,
): Promise<number> {
  const db = getDb();
  const cutoff = Math.floor(Date.now() / 1000) - maxAgeDays * 86400;
  const rows = await db`
    UPDATE generated_ideas
    SET pipeline_stage = 'archived'
    WHERE COALESCE(pipeline_stage, 'idea') = 'idea' AND created_at < ${cutoff}
    RETURNING id
  `;
  return rows.length;
}


// ============================================================================
// Idea Deduplication Functions
// ============================================================================

export interface SimilarIdea {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly category: string;
  readonly title_similarity: number;
  readonly summary_similarity: number;
}

/**
 * Find existing ideas similar to the given title/summary using pg_trgm.
 * Requires the pg_trgm extension and GIN indexes (migration 007).
 */
export async function findSimilarIdeas(
  title: string,
  summary: string,
  limit = 5,
): Promise<readonly SimilarIdea[]> {
  const cappedLimit = Math.min(limit, 20);
  const db = getDb();
  try {
    return db`
      SELECT id, title, summary, category,
        similarity(title, ${title}) as title_similarity,
        similarity(summary, ${summary}) as summary_similarity
      FROM generated_ideas
      WHERE COALESCE(pipeline_stage, 'idea') != 'archived'
        AND (similarity(title, ${title}) > 0.4 OR similarity(summary, ${summary}) > 0.5)
      ORDER BY similarity(title, ${title}) DESC
      LIMIT ${cappedLimit}
    ` as Promise<SimilarIdea[]>;
  } catch {
    // pg_trgm might not be available — non-fatal, skip fuzzy layer
    return [];
  }
}

export interface ExistingIdeaSummary {
  readonly title: string;
  readonly summary: string;
  readonly category: string;
}

/**
 * Get all non-archived idea titles and summaries for dedup context.
 * Used to inject into LLM prompts and for exact-match dedup.
 */
export async function getAllExistingIdeas(limit = 500): Promise<readonly ExistingIdeaSummary[]> {
  const db = getDb();
  const cappedLimit = Math.min(limit, 1000);
  return db`
    SELECT title, LEFT(summary, 150) as summary, category
    FROM generated_ideas
    WHERE COALESCE(pipeline_stage, 'idea') != 'archived'
    ORDER BY created_at DESC
    LIMIT ${cappedLimit}
  ` as Promise<ExistingIdeaSummary[]>;
}

/**
 * Get all source IDs ever used across all non-archived ideas.
 * Returns a map of table name → set of source IDs.
 */
export async function getUsedSourceIds(): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
  const db = getDb();
  const result = new Map<string, Set<string>>();

  try {
    const rows = await db`
      SELECT source_ids_json FROM generated_ideas
      WHERE source_ids_json IS NOT NULL AND source_ids_json != '[]'
        AND COALESCE(pipeline_stage, 'idea') != 'archived'
    ` as Array<{ source_ids_json: string }>;

    for (const row of rows) {
      try {
        const raw = JSON.parse(row.source_ids_json);
        if (!Array.isArray(raw)) continue;
        for (const entry of raw) {
          if (typeof entry?.table !== "string" || typeof entry?.id !== "string") continue;
          const set = result.get(entry.table) ?? new Set<string>();
          set.add(entry.id);
          result.set(entry.table, set);
        }
      } catch {
        // skip malformed JSON
      }
    }
  } catch {
    // non-fatal
  }

  return result;
}
