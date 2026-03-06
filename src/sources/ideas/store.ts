import { getDb } from "../../store/db";

export interface GeneratedIdea {
  readonly id: string;
  readonly agent_id: string;
  readonly title: string;
  readonly summary: string;
  readonly reasoning: string;
  readonly sources_used: string;
  readonly category: string;
  readonly rating: string | null;
  readonly feedback: string;
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
  readonly rating: "good" | "bad";
  readonly feedback?: string;
}

export async function updateIdeaRating(
  id: string,
  input: UpdateIdeaRatingInput,
): Promise<GeneratedIdea | null> {
  const db = getDb();
  const feedback = input.feedback ?? "";
  const rows = await db`
    UPDATE generated_ideas
    SET rating = ${input.rating}, feedback = ${feedback}
    WHERE id = ${id}
    RETURNING *
  `;
  return (rows[0] as GeneratedIdea) ?? null;
}

export interface RecentIdeaTitle {
  readonly title: string;
  readonly category: string;
  readonly rating: string | null;
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

export interface RejectedIdeaFeedback {
  readonly title: string;
  readonly category: string;
  readonly feedback: string;
}

export async function getRejectedIdeasWithFeedback(
  agentId: string,
  limit = 20,
): Promise<readonly RejectedIdeaFeedback[]> {
  const db = getDb();
  return db`
    SELECT title, category, feedback
    FROM generated_ideas
    WHERE agent_id = ${agentId} AND rating = 'bad' AND feedback != ''
    ORDER BY created_at DESC
    LIMIT ${limit}
  ` as Promise<RejectedIdeaFeedback[]>;
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
  readonly rating: string | null;
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
