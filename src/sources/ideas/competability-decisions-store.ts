/**
 * Competability decision AUDIT store (migration 028).
 *
 * Persists ONE row per EVALUATED idea — KEPT or KILLED — at the point the
 * competability gate decides, BEFORE ENFORCE mode drops a killed idea. This is
 * the COMPLETE gate population, the cure for the survivor bias that made the
 * calibration backtest meaningless (only ideas that PASSED the gate ever reached
 * `generated_ideas`).
 *
 * Kept in its OWN module (not bolted onto the large `store.ts`) so the audit
 * concern stays focused and small. Both gate sites — the pipeline Pass-3 critique
 * and the SIGE cross-write gate — collect their per-run decisions and FLUSH them
 * here in a single batch insert. The write is BEST-EFFORT: an audit failure must
 * never break idea generation, so the flush swallows + logs and returns 0.
 */

import { createLogger } from "../../logger";
import type { CompetabilityPersisted } from "../../pipelines/ideas/competability";
import { getDb } from "../../store/db";
import type { CompetabilityPersistedJson } from "./store";

const log = createLogger("ideas:competability-decisions");

// TODO(calibration): needs idea_id on competability_decisions — moat-threshold
// calibration was deferred because this table carries only a truncated
// idea_title (no idea_id), so a JOIN to real outcomes is unsound (survivor-bias).
// Add an idea_id column here first, then build the calibration query/store.

/** Which gate produced the decision. */
export type CompetabilityDecisionSource = "pipeline" | "sige";

/** Cap stored titles so a pathological title can't bloat the audit row. */
export const MAX_DECISION_TITLE_LENGTH = 300;

/**
 * Defense-in-depth cap on the calibration read from the audit table. Far above
 * any realistic volume of decisions, so it never biases the calibration in
 * practice; it only bounds the worst-case memory footprint of the read.
 */
export const MAX_DECISION_ROWS = 100_000;

/**
 * The decision as the CALLER provides it: the gate's outcome for one idea, with
 * the full persisted scorecard. Immutable. `decidedAt` (epoch SECONDS, via the
 * pipeline `now()` helper) is supplied by the caller so the builder stays pure.
 */
export interface CompetabilityDecisionInput {
  readonly source: CompetabilityDecisionSource;
  readonly pipelineRunId?: string | null;
  readonly sessionId?: string | null;
  readonly ideaTitle: string;
  /** The full persisted scorecard the gate acted on (effective dims + raw + reason). */
  readonly persisted: CompetabilityPersisted;
  /** Did the competability gate reject this idea. */
  readonly gated: boolean;
  /** Was enforce mode on at decision time. */
  readonly enforced: boolean;
  /** Epoch SECONDS the decision was made (caller supplies via `now()`). */
  readonly decidedAt: number;
}

/**
 * The row shape inserted into `competability_decisions`. snake_case columns; the
 * JSONB column carries a real object (NOT a JSON string — Bun.sql serializes a JS
 * object to JSONB; a pre-stringified value double-encodes into a JSONB string
 * scalar). All fields readonly.
 */
export interface CompetabilityDecisionRow {
  readonly pipeline_run_id: string | null;
  readonly session_id: string | null;
  readonly source: CompetabilityDecisionSource;
  readonly idea_title: string;
  readonly competability_overall: number;
  readonly competability_raw_overall: number | null;
  readonly competability_json: CompetabilityPersistedJson;
  readonly gated: boolean;
  readonly enforced: boolean;
  readonly decided_at: number;
}

/** Truncate a title to the audit cap without throwing on non-strings. */
function truncateTitle(title: string): string {
  return title.length > MAX_DECISION_TITLE_LENGTH
    ? title.slice(0, MAX_DECISION_TITLE_LENGTH)
    : title;
}

/**
 * Map one decision input to its insertable row. PURE — no IO, no clock, no rng;
 * `decided_at` comes straight from the caller-supplied `decidedAt`. The JSONB
 * column is the persisted scorecard as a REAL object (the gate's effective dims,
 * raw slice, reason, matchedExpertiseDomain, gated). Unit-tested directly.
 */
export function buildCompetabilityDecisionRow(
  input: CompetabilityDecisionInput,
): CompetabilityDecisionRow {
  return {
    pipeline_run_id: input.pipelineRunId ?? null,
    session_id: input.sessionId ?? null,
    source: input.source,
    idea_title: truncateTitle(input.ideaTitle),
    competability_overall: input.persisted.overall,
    competability_raw_overall: input.persisted.raw?.overall ?? null,
    // Cast through the persisted-JSON column type: the in-memory scorecard and the
    // stored shape are structurally identical (both idea paths round-trip it).
    competability_json: input.persisted as unknown as CompetabilityPersistedJson,
    gated: input.gated,
    enforced: input.enforced,
    decided_at: input.decidedAt,
  };
}

/**
 * BEST-EFFORT batch-persist a run's competability decisions. Builds the rows
 * purely, then inserts them in ONE parameterized statement via the Bun.sql object
 * helper (`${db(rows)}` → multi-row INSERT; the JSONB object is passed as an
 * object, never stringified). NEVER throws — any failure is swallowed + logged so
 * an audit-insert problem can NEVER break idea generation. Returns the number of
 * rows persisted (0 on empty input or on failure).
 */
export async function persistCompetabilityDecisions(
  inputs: readonly CompetabilityDecisionInput[],
): Promise<number> {
  if (inputs.length === 0) return 0;

  const rows = inputs.map(buildCompetabilityDecisionRow);
  try {
    const db = getDb();
    await db`INSERT INTO competability_decisions ${db(rows)}`;
    const gated = rows.reduce((n, r) => n + (r.gated ? 1 : 0), 0);
    const first = inputs[0];
    log.info("Competability decisions persisted", {
      count: rows.length,
      gated,
      source: first?.source,
      runId: first?.pipelineRunId ?? null,
      sessionId: first?.sessionId ?? null,
    });
    return rows.length;
  } catch (err) {
    log.warn("Failed to persist competability decisions (non-fatal)", {
      count: rows.length,
      source: inputs[0]?.source,
      err,
    });
    return 0;
  }
}
