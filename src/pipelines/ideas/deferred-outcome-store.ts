/**
 * deferred-outcome-store.ts — the queue behind the deferred outcome re-probe
 * (Phase 2 of the idea-learning loop). Backed by `deferred_outcome_probes`
 * (migration 032) via Bun.sql tagged templates through {@link getDb}.
 *
 * The flow:
 *   1. enqueueValidatedIdea() — when an idea is proxy- (or human-) VALIDATED,
 *      stamp a row due `delayDays` later, carrying the validation-time demand
 *      snapshot. IDEMPOTENT: the migration's partial UNIQUE (idea_id WHERE
 *      outcome_recorded_at IS NULL) means a second enqueue while one is still open
 *      is a no-op (ON CONFLICT DO NOTHING).
 *   2. claimDueReprobes() — a scheduler tick atomically CLAIMS up to `limit` due,
 *      open rows (sets claimed_at) via a single UPDATE … RETURNING so two ticks
 *      never double-claim the same row.
 *   3. recordReprobeOutcome() — after re-probing, record the label / delta /
 *      snapshot and stamp outcome_recorded_at (closing the row, freeing the
 *      partial-unique slot for a future re-validation).
 *
 * Row ↔ domain split: snake_case `*Row` shapes mirror the columns; `rowToX`
 * mappers convert to `readonly` domain types. JSONB columns are passed/returned as
 * REAL objects (Bun.sql serializes a JS object to JSONB; a pre-stringified value
 * would double-encode into a JSONB string scalar — see competability-decisions-store).
 */

import { createLogger } from "../../logger";
import { getDb } from "../../store/db";
import type { DemandArtifact } from "./demand";

const log = createLogger("ideas:deferred-outcome-store");

/** Cap stored titles so a pathological title can't bloat the queue row. */
export const MAX_PROBE_TITLE_LENGTH = 300;

// ─── Domain types (readonly) ──────────────────────────────────────────────────

/** Caller input to enqueue a validated idea for a later demand re-probe. */
export interface EnqueueValidatedIdeaInput {
  readonly ideaId: string;
  readonly title: string;
  readonly segment?: string | null;
  readonly archetype?: string | null;
  /** Provenance of the verdict that triggered the enqueue ("proxy:<reason>" | "human"). */
  readonly validationSource: string;
  /** Epoch SECONDS the original verdict landed. */
  readonly validatedAt: number;
  /**
   * Validation-time demand snapshot, diffed against the re-probe. NULL for the
   * human-verdict path (no demand snapshot) — the re-probe then resolves
   * "inconclusive" (baseline at the absence floor) and leaves the verdict intact.
   */
  readonly baselineDemand: DemandArtifact | null;
  /** Epoch SECONDS the row becomes eligible (validatedAt + delayDays * 86400). */
  readonly dueAt: number;
}

/** A due re-probe a scheduler tick has CLAIMED and must process. Readonly. */
export interface ClaimedReprobe {
  readonly id: number;
  readonly ideaId: string;
  readonly title: string;
  readonly segment: string | null;
  readonly archetype: string | null;
  readonly validationSource: string;
  readonly validatedAt: number;
  readonly baselineDemand: DemandArtifact | null;
  readonly dueAt: number;
}

/** The recorded outcome of a re-probe. */
export interface RecordReprobeOutcomeInput {
  readonly id: number;
  readonly label: string;
  readonly reprobeDemand: DemandArtifact | null;
  readonly scoreDelta: number | null;
  /** Epoch SECONDS the outcome was recorded. */
  readonly recordedAt: number;
}

// ─── Row shapes (snake_case, JSONB as real objects) ───────────────────────────

interface DeferredProbeInsertRow {
  readonly idea_id: string;
  readonly title: string;
  readonly segment: string | null;
  readonly archetype: string | null;
  readonly validation_source: string;
  readonly validated_at: number;
  readonly baseline_demand_json: DemandArtifact | null;
  readonly due_at: number;
}

interface ClaimedReprobeRow {
  readonly id: number | string;
  readonly idea_id: string;
  readonly title: string;
  readonly segment: string | null;
  readonly archetype: string | null;
  readonly validation_source: string;
  readonly validated_at: number | string;
  readonly baseline_demand_json: DemandArtifact | null;
  readonly due_at: number | string;
}

// ─── Mappers (PURE) ───────────────────────────────────────────────────────────

/** Truncate a title to the queue cap without throwing on non-strings. */
function truncateTitle(title: string): string {
  return title.length > MAX_PROBE_TITLE_LENGTH ? title.slice(0, MAX_PROBE_TITLE_LENGTH) : title;
}

/** Build the insertable row from an enqueue input. PURE. */
export function buildDeferredProbeRow(input: EnqueueValidatedIdeaInput): DeferredProbeInsertRow {
  return {
    idea_id: input.ideaId,
    title: truncateTitle(input.title),
    segment: input.segment ?? null,
    archetype: input.archetype ?? null,
    validation_source: input.validationSource,
    validated_at: input.validatedAt,
    baseline_demand_json: input.baselineDemand ?? null,
    due_at: input.dueAt,
  };
}

/** Map a claimed DB row to the readonly domain type. PURE. BIGINT cols arrive as strings. */
function rowToClaimedReprobe(row: ClaimedReprobeRow): ClaimedReprobe {
  return {
    id: Number(row.id),
    ideaId: row.idea_id,
    title: row.title,
    segment: row.segment,
    archetype: row.archetype,
    validationSource: row.validation_source,
    validatedAt: Number(row.validated_at),
    baselineDemand: row.baseline_demand_json,
    dueAt: Number(row.due_at),
  };
}

// ─── I/O ──────────────────────────────────────────────────────────────────────

/**
 * Idempotently enqueue a validated idea for a later demand re-probe. The partial
 * UNIQUE index (idea_id WHERE outcome_recorded_at IS NULL) makes a duplicate
 * enqueue (while one is still open) a no-op via ON CONFLICT DO NOTHING. Returns
 * true when a NEW row was inserted, false when an open row already existed.
 * Best-effort wrapper: a DB failure logs + returns false (never throws into the
 * caller's write-back path).
 */
export async function enqueueValidatedIdea(input: EnqueueValidatedIdeaInput): Promise<boolean> {
  const row = buildDeferredProbeRow(input);
  try {
    const db = getDb();
    const inserted = await db`
      INSERT INTO deferred_outcome_probes
        (idea_id, title, segment, archetype, validation_source, validated_at,
         baseline_demand_json, due_at)
      VALUES
        (${row.idea_id}, ${row.title}, ${row.segment}, ${row.archetype},
         ${row.validation_source}, ${row.validated_at}, ${row.baseline_demand_json},
         ${row.due_at})
      ON CONFLICT (idea_id) WHERE outcome_recorded_at IS NULL DO NOTHING
      RETURNING id
    `;
    return inserted.length > 0;
  } catch (err) {
    log.warn("enqueueValidatedIdea failed (non-fatal)", { err, ideaId: input.ideaId });
    return false;
  }
}

/**
 * Atomically CLAIM up to `limit` due, open re-probes for processing. A single
 * UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) … RETURNING sets
 * claimed_at and returns the claimed rows, so two concurrent ticks never claim the
 * same row (SKIP LOCKED + the open-row predicate). `now` is epoch SECONDS. Returns
 * [] on failure (never throws — the scheduler tick logs and moves on).
 */
export async function claimDueReprobes(
  limit: number,
  now: number,
): Promise<readonly ClaimedReprobe[]> {
  if (limit <= 0) return [];
  try {
    const db = getDb();
    const rows = (await db`
      UPDATE deferred_outcome_probes
      SET claimed_at = ${now}
      WHERE id IN (
        SELECT id FROM deferred_outcome_probes
        WHERE due_at <= ${now}
          AND claimed_at IS NULL
          AND outcome_recorded_at IS NULL
        ORDER BY due_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, idea_id, title, segment, archetype, validation_source,
                validated_at, baseline_demand_json, due_at
    `) as unknown as ClaimedReprobeRow[];
    return rows.map(rowToClaimedReprobe);
  } catch (err) {
    log.warn("claimDueReprobes failed (returning empty)", { err, limit });
    return [];
  }
}

/**
 * Record the outcome of a re-probe: the label, the current demand snapshot, the
 * score delta, and outcome_recorded_at (which closes the row and frees the
 * partial-unique slot). Best-effort: logs + returns false on failure. JSONB passed
 * as a real object.
 */
export async function recordReprobeOutcome(input: RecordReprobeOutcomeInput): Promise<boolean> {
  try {
    const db = getDb();
    const updated = await db`
      UPDATE deferred_outcome_probes
      SET reprobe_label = ${input.label},
          reprobe_demand_json = ${input.reprobeDemand},
          reprobe_score_delta = ${input.scoreDelta},
          outcome_recorded_at = ${input.recordedAt}
      WHERE id = ${input.id}
      RETURNING id
    `;
    return updated.length > 0;
  } catch (err) {
    log.warn("recordReprobeOutcome failed (non-fatal)", { err, id: input.id });
    return false;
  }
}

/** Bundle of the store operations the scheduler depends on (for DI / testing). */
export interface DeferredOutcomeStore {
  enqueueValidatedIdea: typeof enqueueValidatedIdea;
  claimDueReprobes: typeof claimDueReprobes;
  recordReprobeOutcome: typeof recordReprobeOutcome;
}

/** The default store backed by {@link getDb}. */
export const deferredOutcomeStore: DeferredOutcomeStore = {
  enqueueValidatedIdea,
  claimDueReprobes,
  recordReprobeOutcome,
};
