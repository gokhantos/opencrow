import { getDb } from "../../store/db";
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

  const rows = await db`
    INSERT INTO generated_ideas (id, agent_id, title, summary, reasoning, sources_used, category, quality_score, pipeline_run_id, source_ids_json)
    VALUES (${id}, ${input.agent_id}, ${input.title}, ${input.summary}, ${input.reasoning}, ${input.sources_used}, ${input.category}, ${input.quality_score}, ${input.pipeline_run_id ?? null}, ${input.source_ids_json ?? "[]"})
    RETURNING *
  `;

  return rows[0] as GeneratedIdea;
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
  return (rows[0] as GeneratedIdea) ?? null;
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

export async function updateIdeaStage(
  id: string,
  stage: string,
): Promise<GeneratedIdea | null> {
  const db = getDb();
  const rows = await db`
    UPDATE generated_ideas
    SET pipeline_stage = ${stage}
    WHERE id = ${id}
    RETURNING *
  `;
  return (rows[0] as GeneratedIdea) ?? null;
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
