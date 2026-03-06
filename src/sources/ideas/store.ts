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
    INSERT INTO generated_ideas (id, agent_id, title, summary, reasoning, sources_used, category, quality_score)
    VALUES (${id}, ${input.agent_id}, ${input.title}, ${input.summary}, ${input.reasoning}, ${input.sources_used}, ${input.category}, ${input.quality_score})
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

export interface UpdateIdeaRatingInput {
  readonly rating: number | null;
}

export async function updateIdeaRating(
  id: string,
  input: UpdateIdeaRatingInput,
): Promise<GeneratedIdea | null> {
  const db = getDb();
  const rows = await db`
    UPDATE generated_ideas
    SET rating = ${input.rating}
    WHERE id = ${id}
    RETURNING *
  `;
  return (rows[0] as GeneratedIdea) ?? null;
}

export interface RecentIdeaTitle {
  readonly title: string;
  readonly category: string;
  readonly rating: number | null;
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
    SELECT title, category, rating
    FROM generated_ideas
    WHERE agent_id = ${agentId}
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

export interface IdeaByRating {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly rating: number | null;
  readonly quality_score: number | null;
  readonly pipeline_stage: string;
  readonly created_at: number;
}

export async function getIdeasByRating(
  minScore: number,
  maxScore: number,
  limit = 50,
): Promise<readonly IdeaByRating[]> {
  const db = getDb();
  return db`
    SELECT id, title, category, rating, quality_score, pipeline_stage, created_at
    FROM generated_ideas
    WHERE quality_score >= ${minScore} AND quality_score <= ${maxScore}
    ORDER BY quality_score DESC, created_at DESC
    LIMIT ${limit}
  ` as Promise<IdeaByRating[]>;
}

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

export interface RatingInsight {
  readonly pattern: string;
  readonly avg_rating: number;
  readonly count: number;
}

export async function getRatingInsights(): Promise<readonly RatingInsight[]> {
  const db = getDb();
  const insights: RatingInsight[] = [];

  // Insight 1: Average rating by category
  const byCat = await db`
    SELECT category AS pattern, AVG(rating)::numeric(3,2) AS avg_rating, COUNT(*)::int AS count
    FROM generated_ideas
    WHERE rating IS NOT NULL
    GROUP BY category
    HAVING COUNT(*) >= 3
    ORDER BY avg_rating DESC
  ` as { pattern: string; avg_rating: number; count: number }[];
  for (const r of byCat) {
    insights.push({ pattern: `category:${r.pattern}`, avg_rating: Number(r.avg_rating), count: r.count });
  }

  // Insight 2: Average rating by agent
  const byAgent = await db`
    SELECT agent_id AS pattern, AVG(rating)::numeric(3,2) AS avg_rating, COUNT(*)::int AS count
    FROM generated_ideas
    WHERE rating IS NOT NULL
    GROUP BY agent_id
    HAVING COUNT(*) >= 3
    ORDER BY avg_rating DESC
  ` as { pattern: string; avg_rating: number; count: number }[];
  for (const r of byAgent) {
    insights.push({ pattern: `agent:${r.pattern}`, avg_rating: Number(r.avg_rating), count: r.count });
  }

  // Insight 3: Self-score calibration (quality_score vs human rating)
  const calibration = await db`
    SELECT
      agent_id AS pattern,
      AVG(quality_score)::numeric(3,2) AS avg_self_score,
      AVG(rating)::numeric(3,2) AS avg_rating,
      COUNT(*)::int AS count
    FROM generated_ideas
    WHERE rating IS NOT NULL AND quality_score IS NOT NULL
    GROUP BY agent_id
    HAVING COUNT(*) >= 3
  ` as { pattern: string; avg_self_score: number; avg_rating: number; count: number }[];
  for (const r of calibration) {
    const bias = Number(r.avg_self_score) - Number(r.avg_rating);
    const direction = bias > 0 ? "over-rates" : "under-rates";
    insights.push({
      pattern: `calibration:${r.pattern} ${direction} by ${Math.abs(bias).toFixed(1)}`,
      avg_rating: Number(r.avg_rating),
      count: r.count,
    });
  }

  // Insight 4: High vs low rated idea characteristics (length of reasoning)
  const byLength = await db`
    SELECT
      CASE WHEN LENGTH(reasoning) > 500 THEN 'detailed_reasoning' ELSE 'brief_reasoning' END AS pattern,
      AVG(rating)::numeric(3,2) AS avg_rating,
      COUNT(*)::int AS count
    FROM generated_ideas
    WHERE rating IS NOT NULL
    GROUP BY CASE WHEN LENGTH(reasoning) > 500 THEN 'detailed_reasoning' ELSE 'brief_reasoning' END
    HAVING COUNT(*) >= 3
  ` as { pattern: string; avg_rating: number; count: number }[];
  for (const r of byLength) {
    insights.push({ pattern: r.pattern, avg_rating: Number(r.avg_rating), count: r.count });
  }

  // Insight 5: Rating by pipeline stage
  const byStage = await db`
    SELECT COALESCE(pipeline_stage, 'idea') AS pattern, AVG(rating)::numeric(3,2) AS avg_rating, COUNT(*)::int AS count
    FROM generated_ideas
    WHERE rating IS NOT NULL
    GROUP BY COALESCE(pipeline_stage, 'idea')
    HAVING COUNT(*) >= 2
    ORDER BY avg_rating DESC
  ` as { pattern: string; avg_rating: number; count: number }[];
  for (const r of byStage) {
    insights.push({ pattern: `stage:${r.pattern}`, avg_rating: Number(r.avg_rating), count: r.count });
  }

  return insights;
}

export interface UnvalidatedIdea {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly reasoning: string;
  readonly category: string;
  readonly agent_id: string;
  readonly rating: number | null;
  readonly quality_score: number | null;
  readonly sources_used: string;
  readonly created_at: number;
}

export async function getTopUnvalidatedIdeas(
  limit = 10,
): Promise<readonly UnvalidatedIdea[]> {
  const db = getDb();
  return db`
    SELECT id, title, summary, reasoning, category, agent_id, rating, quality_score, sources_used, created_at
    FROM generated_ideas
    WHERE COALESCE(pipeline_stage, 'idea') = 'idea'
      AND (rating IS NOT NULL AND rating >= 3)
    ORDER BY rating DESC, quality_score DESC NULLS LAST, created_at DESC
    LIMIT ${limit}
  ` as Promise<UnvalidatedIdea[]>;
}
