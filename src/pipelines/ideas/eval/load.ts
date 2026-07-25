/**
 * DB loaders for the idea-eval harness — the previously-missing entrypoint
 * layer between the pure `./aggregate` math and the real `generated_ideas` /
 * `idea_feedback` tables.
 *
 * Every loader degrades gracefully on read failure (returns []) rather than
 * throwing, so a scoring bug in the eval harness never breaks the caller (a
 * cron job, a CLI script). Failures are logged with context. jsonb columns are
 * defensively parsed because Bun's SQL driver sometimes returns them as raw
 * JSON strings and sometimes as already-parsed values (see `parseJson` below,
 * mirroring the precedent in `src/sources/appstore/keyword-store.ts` and
 * `src/pipelines/store.ts`).
 *
 * Column → field name mapping deliberately reuses the EXISTING
 * `parseCritiqueSubscores` from `./store` rather than re-implementing
 * critique-subscore parsing.
 */

import { getDb } from "../../../store/db";
import { createLogger } from "../../../logger";
import { getErrorMessage } from "../../../lib/error-serialization";
import type { EvalIdeaRow, EvalOutcomeRow } from "./aggregate";
import type { DemandArtifact, DemandEvidence } from "../demand";
import { parseCritiqueSubscores } from "./store";

const logger = createLogger("ideas:eval:load");

/**
 * Bun's SQL driver returns `jsonb` columns as raw JSON strings, not parsed
 * values, in some contexts. Mirrors `parseJson` in `src/pipelines/store.ts`
 * and `src/sources/appstore/keyword-store.ts`: pass through already-parsed
 * values, parse strings, fall back defensively rather than throwing.
 */
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
 * Tolerantly parse a persisted `demand_json` value into a {@link DemandArtifact},
 * or null when absent/malformed. Unlike `parseGiant` (which coerces defaults
 * for a trusted LLM output), this REJECTS a value that is missing the required
 * numeric fields entirely rather than fabricating a demand signal that was
 * never computed — a null here correctly falls through to `missingArtifactCount`
 * in {@link import("./aggregate").aggregateDemandCoverage}. PURE.
 */
export function parseDemandArtifact(value: unknown): DemandArtifact | null {
  const obj = parseJson<Record<string, unknown> | null>(value, null);
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return null;

  const score = obj.score;
  const confidence = obj.confidence;
  const whitespace = obj.whitespace;
  if (
    typeof score !== "number" ||
    !Number.isFinite(score) ||
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    typeof whitespace !== "number" ||
    !Number.isFinite(whitespace)
  ) {
    return null;
  }

  const rawEvidence = Array.isArray(obj.evidence) ? obj.evidence : [];
  const evidence: DemandEvidence[] = [];
  for (const e of rawEvidence) {
    if (e === null || typeof e !== "object") continue;
    const entry = e as Record<string, unknown>;
    if (typeof entry.kind !== "string") continue;
    if (typeof entry.query !== "string") continue;
    if (typeof entry.count !== "number" || !Number.isFinite(entry.count)) continue;
    evidence.push({
      kind: entry.kind as DemandEvidence["kind"],
      query: entry.query,
      count: entry.count,
      ...(typeof entry.quote === "string" ? { quote: entry.quote } : {}),
      ...(typeof entry.sourceId === "string" ? { sourceId: entry.sourceId } : {}),
    });
  }

  return { score, confidence, whitespace, evidence };
}

/** Raw shape of a `generated_ideas` row as selected by {@link loadEvalIdeas}. */
interface RawGeneratedIdeaRow {
  readonly id: string;
  readonly category: string | null;
  readonly pipeline_stage: string | null;
  readonly critique_subscores_json: unknown;
  readonly created_at: number | string | null;
  readonly title: string | null;
  readonly summary: string | null;
  readonly demand_json: unknown;
  readonly demand_score: number | string | null;
  readonly whitespace: number | string | null;
}

/**
 * Map one raw `generated_ideas` row into the pure {@link EvalIdeaRow} shape the
 * harness declares. Exported for unit testing without a DB. Note the harness
 * field is `critique_subscores` (camelCase, no `_json` suffix) while the
 * persisted COLUMN is `critique_subscores_json` — this is the rename.
 */
export function rowToEvalIdea(row: RawGeneratedIdeaRow): EvalIdeaRow {
  const createdAtRaw = row.created_at;
  const created_at =
    typeof createdAtRaw === "number"
      ? createdAtRaw
      : typeof createdAtRaw === "string" && createdAtRaw.trim().length > 0
        ? Number(createdAtRaw)
        : 0;

  const demandScoreRaw = row.demand_score;
  const demand_score =
    typeof demandScoreRaw === "number"
      ? demandScoreRaw
      : typeof demandScoreRaw === "string" && demandScoreRaw.trim().length > 0
        ? Number(demandScoreRaw)
        : null;

  const whitespaceRaw = row.whitespace;
  const whitespace =
    typeof whitespaceRaw === "number"
      ? whitespaceRaw
      : typeof whitespaceRaw === "string" && whitespaceRaw.trim().length > 0
        ? Number(whitespaceRaw)
        : null;

  return {
    id: row.id,
    category: row.category ?? "",
    pipeline_stage: row.pipeline_stage ?? null,
    critique_subscores: parseCritiqueSubscores(row.critique_subscores_json),
    created_at: Number.isFinite(created_at) ? created_at : 0,
    ...(row.title !== null && row.title !== undefined ? { title: row.title } : {}),
    ...(row.summary !== null && row.summary !== undefined ? { summary: row.summary } : {}),
    demand: parseDemandArtifact(row.demand_json),
    demand_score: demand_score !== null && Number.isFinite(demand_score) ? demand_score : null,
    whitespace: whitespace !== null && Number.isFinite(whitespace) ? whitespace : null,
  };
}

/** Raw shape of an `idea_feedback` row as selected by {@link loadEvalOutcomes}. */
interface RawIdeaFeedbackRow {
  readonly idea_id: string;
  readonly kind: string;
  readonly actor: string | null;
}

/** Map one raw `idea_feedback` row into the pure {@link EvalOutcomeRow} shape. */
export function rowToEvalOutcome(row: RawIdeaFeedbackRow): EvalOutcomeRow {
  return {
    idea_id: row.idea_id,
    kind: row.kind,
    actor: row.actor ?? null,
  };
}

/** Optional scope bounds shared by the eval-harness loaders. */
export interface EvalLoadScope {
  /** Restrict to one idea `category`. Omit/undefined = all categories. */
  readonly category?: string;
  /** Only rows created at/after this epoch-seconds bound. Omit = no lower bound. */
  readonly sinceEpochSeconds?: number;
  /** Row cap (defaults to 5000, well above the current corpus size). */
  readonly limit?: number;
}

const DEFAULT_LOAD_LIMIT = 5000;

/**
 * Load `generated_ideas` rows into {@link EvalIdeaRow}s, optionally scoped by
 * category / recency / row cap. Degrades gracefully: a query failure is
 * logged and yields [] rather than throwing, so an eval run never breaks on a
 * transient DB blip.
 */
export async function loadEvalIdeas(
  scope: EvalLoadScope = {},
): Promise<readonly EvalIdeaRow[]> {
  const category = scope.category ?? null;
  const sinceEpochSeconds = scope.sinceEpochSeconds ?? null;
  const limit = Math.min(scope.limit ?? DEFAULT_LOAD_LIMIT, 20000);

  try {
    const db = getDb();
    const rows = (await db.unsafe(
      `SELECT id, category, pipeline_stage, critique_subscores_json, created_at,
              title, summary, demand_json, demand_score, whitespace
       FROM generated_ideas
       WHERE ($1::text IS NULL OR category = $1)
         AND ($2::bigint IS NULL OR created_at >= $2)
       ORDER BY created_at DESC
       LIMIT $3::int`,
      [category, sinceEpochSeconds, limit],
    )) as unknown as readonly RawGeneratedIdeaRow[];
    return rows.map(rowToEvalIdea);
  } catch (error) {
    logger.error("Failed to load generated_ideas for eval", {
      error: getErrorMessage(error),
      category,
      sinceEpochSeconds,
    });
    return [];
  }
}

/**
 * Load `idea_feedback` rows into {@link EvalOutcomeRow}s, optionally scoped to
 * the same idea id set the caller already loaded (keeps the outcomes query
 * cheap when `ideaIds` is supplied) and/or a row cap. Degrades gracefully.
 */
export async function loadEvalOutcomes(
  scope: { readonly ideaIds?: readonly string[]; readonly limit?: number } = {},
): Promise<readonly EvalOutcomeRow[]> {
  const limit = Math.min(scope.limit ?? DEFAULT_LOAD_LIMIT, 20000);

  try {
    const db = getDb();
    const ideaIds = scope.ideaIds;
    const rows = (
      ideaIds && ideaIds.length > 0
        ? await db`
            SELECT idea_id, kind, actor
            FROM idea_feedback
            WHERE idea_id IN ${db(ideaIds as string[])}
            LIMIT ${limit}
          `
        : await db.unsafe(
            `SELECT idea_id, kind, actor FROM idea_feedback LIMIT $1::int`,
            [limit],
          )
    ) as unknown as readonly RawIdeaFeedbackRow[];
    return rows.map(rowToEvalOutcome);
  } catch (error) {
    logger.error("Failed to load idea_feedback for eval", {
      error: getErrorMessage(error),
      ideaIdCount: scope.ideaIds?.length ?? 0,
    });
    return [];
  }
}
