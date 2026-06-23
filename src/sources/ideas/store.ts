import { getDb } from "../../store/db";
import { createLogger } from "../../logger";
import type { DemandArtifact } from "../../pipelines/ideas/demand";
import { demandArtifactSchema } from "../../pipelines/ideas/demand";
import { type Archetype, ARCHETYPES } from "../../pipelines/ideas/giant";
import {
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
  /**
   * Full demand artifact (migration 015): score, confidence, whitespace, evidence.
   * Null when the demand gate did not run for this idea (pre-feature rows, or
   * ideas that skipped the demand probe).
   */
  readonly demand_json: DemandArtifact | null;
  /**
   * Flattened demand score 0..5 (migration 015), for fast filtering. Null when
   * demand_json is null.
   */
  readonly demand_score: number | null;
  /**
   * GIANT composite 0..5 (migration 014): the non-compensatory weighted geometric
   * mean over the 9 axes. Null when the GIANT gate did not run for this idea.
   */
  readonly giant_composite: number | null;
  /** Candidate segment (consumer / b2b_saas / devtools / …), migration 015. Null when unset. */
  readonly segment: string | null;
  /**
   * Sequoia-style archetype (migration 014). The column is free TEXT, so the mapper
   * VALIDATES it against the closed {@link Archetype} enum and coerces anything else
   * to null — never surfacing raw, unvalidated text on the typed domain field.
   */
  readonly archetype: Archetype | null;
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
  /** Bun.sql may surface JSONB as an already-parsed object or a JSON string. */
  readonly demand_json: DemandArtifact | string | null;
  readonly demand_score: number | null;
  readonly giant_composite: number | null;
  readonly segment: string | null;
  /** Free TEXT in the DB — validated against the Archetype enum by the mapper. */
  readonly archetype: string | null;
}

/**
 * Tolerantly parse the competability_json column (object | string | null).
 * Exported so the read-only calibration query reuses the EXACT same tolerant
 * parse instead of duplicating it.
 */
export function parseCompetabilityJson(
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

/**
 * Tolerantly parse the demand_json column (object | string | null) through
 * {@link demandArtifactSchema}. Returns null for any value that is absent,
 * not a valid JSON string, or does not conform to the schema — so old rows
 * (pre-migration-015) are safely handled. Mirrors parseCompetabilityJson.
 * Exported so the route and test can reuse the exact same parse path.
 */
export function parseDemandJson(
  value: DemandArtifact | string | null | undefined,
): DemandArtifact | null {
  if (value == null) return null;
  let candidate: unknown;
  if (typeof value === "string") {
    try {
      candidate = JSON.parse(value);
    } catch {
      return null;
    }
  } else {
    candidate = value;
  }
  const parsed = demandArtifactSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * Validate the free-TEXT archetype column against the closed {@link Archetype}
 * enum. Returns the typed archetype when it is one of the known values, else null —
 * so an unexpected / injected string in the DB never reaches the typed domain
 * field. Mirrors the defensive safe-parse posture of {@link parseDemandJson}. PURE.
 */
export function parseArchetype(value: string | null | undefined): Archetype | null {
  return value != null && (ARCHETYPES as readonly string[]).includes(value)
    ? (value as Archetype)
    : null;
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
    demand_json: parseDemandJson(row.demand_json),
    demand_score: row.demand_score,
    giant_composite: row.giant_composite,
    segment: row.segment,
    archetype: parseArchetype(row.archetype),
  };
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

export async function getIdeaById(id: string): Promise<GeneratedIdea | null> {
  const db = getDb();
  const rows = await db`
    SELECT * FROM generated_ideas WHERE id = ${id}
  `;
  const row = rows[0] as GeneratedIdeaRow | undefined;
  return row ? rowToGeneratedIdea(row) : null;
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
    const raw = (rows[0] as GeneratedIdeaRow | undefined) ?? null;
    if (!raw) return null;
    const updated = rowToGeneratedIdea(raw);

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
