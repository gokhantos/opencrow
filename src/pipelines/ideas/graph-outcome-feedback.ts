/**
 * graph-outcome-feedback.ts — close the graph feedback loop (Phase 3).
 *
 * The SIGE opportunity-path traversal seeds on pain `:Entity` nodes ranked by
 * degree, which rewards a monoculture (the same high-degree hubs always lead). This
 * module learns, per seed, whether the runs it fed produced GOOD ideas, and feeds
 * that signal back so traversal favors historically-productive seeds.
 *
 * Two halves:
 *   1. PURE credit assignment ({@link buildSeedOutcomeEvents}, {@link decaySeedWeight}):
 *      map a run's AGGREGATE verdict to per-seed signed weights, with temporal
 *      decay. No I/O, no clock — the caller passes `now`.
 *   2. Postgres bookkeeping + Neo4j projection (IO): record which seeds fed each
 *      run, append the (idempotent) verdict log, materialize the decayed weights,
 *      and project them onto the live graph via the WRITE client.
 *
 * CRITICAL CORRECTNESS + SECURITY CONTRACT — only GOLD / REPROBE-tier verdicts
 * feed the weights. Proxy (same-run self-grade) verdicts are EXCLUDED by default
 * (NOT behind a flag): they are not ground truth, and letting them steer the graph
 * would amplify the model's own bias. With proxy excluded, early on the event log
 * is near-empty and the read path's `coalesce(success_weight, neutral)` keeps
 * traversal at neutral/degree — the safe default.
 *
 * Everything here is gated by the `graphFeedback` config block (default OFF), and
 * every IO function degrades to a best-effort no-op so it never breaks a run.
 */

import { applyTemporalDecay } from "../../memory/temporal-decay";
import { createLogger } from "../../logger";
import { getDb } from "../../store/db";
import type { Neo4jWriteClient, SeedWeightProjection } from "../../sige/knowledge/neo4j-write-client";
import { outcomeTrustTier } from "./outcome-memory-rank";

const log = createLogger("ideas:graph-outcome-feedback");

// ─── Rel-type constants (UPPERCASE canonical — mirror the write client) ───────

/** Edge type for a seed that fed a run whose aggregate verdict was VALIDATED. */
export const OPPORTUNITY_VALIDATED_REL = "OPPORTUNITY_VALIDATED" as const;
/** Edge type for a seed that fed a run whose aggregate verdict was KILLED. */
export const OPPORTUNITY_KILLED_REL = "OPPORTUNITY_KILLED" as const;

// ─── Types ────────────────────────────────────────────────────────────────────

/** A run-level per-seed outcome event — the durable unit written to Postgres and
 *  (as an edge) to Neo4j. `weight` is signed and already clamped to ±maxSeedWeight. */
export interface GraphOutcomeEvent {
  readonly runId: string;
  readonly seedName: string;
  readonly verdict: "validated" | "killed";
  readonly weight: number;
  /** Epoch SECONDS the verdict landed (drives temporal decay). */
  readonly createdAtSec: number;
}

/** A single idea's adjudicated verdict for one run, with its provenance source. */
export interface IdeaVerdict {
  /** "validated" credits the run's seeds; "killed" (archived/dedup-rejected) debits. */
  readonly verdict: "validated" | "killed";
  /** verdictSource string — classified by outcomeTrustTier (gold/reprobe/proxy/none). */
  readonly verdictSource: string;
}

/** Config slice the pure builder needs (a subset of GraphFeedbackConfig). */
export interface GraphOutcomeConfig {
  readonly validatedWeight: number;
  readonly killedWeight: number;
  readonly maxSeedWeight: number;
}

// ─── buildSeedOutcomeEvents (PURE) ─────────────────────────────────────────────

/** Clamp a signed weight to ±max (max is treated as a magnitude). PURE. */
function clamp(value: number, maxMagnitude: number): number {
  const m = Math.abs(maxMagnitude);
  return Math.max(-m, Math.min(m, value));
}

/**
 * Map a run's AGGREGATE verdict to per-seed signed events. The aggregate is
 * derived from the run's idea verdicts: a validated idea contributes
 * +validatedWeight, a killed idea contributes +killedWeight (negative). ONLY
 * gold/reprobe-tier verdicts count — proxy + none are skipped so the model's own
 * self-grade can never steer the graph. The net per-run signal is attributed to
 * EVERY seed that fed the run, then clamped to ±maxSeedWeight.
 *
 * `verdictMap` is keyed by ideaId; `runSeeds` is the set of seed names that fed the
 * run. An empty seed set, an empty verdict map, or a run with only proxy/none
 * verdicts yields []. PURE — no I/O, no clock (the caller stamps createdAtSec).
 */
export function buildSeedOutcomeEvents(params: {
  readonly runId: string;
  readonly verdictMap: ReadonlyMap<string, IdeaVerdict>;
  readonly runSeeds: readonly string[];
  readonly config: GraphOutcomeConfig;
  readonly createdAtSec: number;
}): readonly GraphOutcomeEvent[] {
  const { runId, verdictMap, runSeeds, config, createdAtSec } = params;
  if (runSeeds.length === 0) return [];

  // Aggregate ONLY trusted (gold/reprobe) verdicts into a single net run signal.
  let net = 0;
  let trustedCount = 0;
  for (const verdict of verdictMap.values()) {
    const tier = outcomeTrustTier(verdict.verdictSource);
    if (tier !== "gold" && tier !== "reprobe") continue; // exclude proxy + none
    trustedCount += 1;
    net += verdict.verdict === "validated" ? config.validatedWeight : config.killedWeight;
  }

  // No trusted signal → no events (the safe near-empty-log default).
  if (trustedCount === 0 || net === 0) return [];

  const aggregateVerdict: "validated" | "killed" = net > 0 ? "validated" : "killed";
  const weight = clamp(net, config.maxSeedWeight);

  // Dedupe seed names so a seed listed twice produces one event (the UNIQUE
  // constraint would collapse them anyway, but keep the pure output clean).
  const seen = new Set<string>();
  const events: GraphOutcomeEvent[] = [];
  for (const rawSeed of runSeeds) {
    const seedName = rawSeed.trim();
    if (seedName.length === 0 || seen.has(seedName)) continue;
    seen.add(seedName);
    events.push({ runId, seedName, verdict: aggregateVerdict, weight, createdAtSec });
  }
  return events;
}

/**
 * Decay a list of a single seed's events to a current weight. Each event's signed
 * weight is temporally decayed (half-life in days) from its createdAtSec to `now`,
 * then summed. Reuses {@link applyTemporalDecay}. PURE — no I/O.
 */
export function decaySeedWeight(
  events: readonly GraphOutcomeEvent[],
  now: number,
  halfLifeDays: number,
): number {
  let total = 0;
  for (const event of events) {
    total += applyTemporalDecay(event.weight, event.createdAtSec, now, halfLifeDays);
  }
  return total;
}

// ─── Postgres IO (best-effort; never throws) ───────────────────────────────────

/**
 * Record which seeds fed a run (provenance for credit assignment). Idempotent via
 * the (run_id, seed_name) PK. Best-effort: swallows its own errors. An empty seed
 * list is a no-op.
 */
export async function recordSeedExposure(
  runId: string,
  seedNames: readonly string[],
): Promise<void> {
  const unique = [...new Set(seedNames.map((s) => s.trim()).filter((s) => s.length > 0))];
  if (unique.length === 0) return;
  try {
    const db = getDb();
    for (const seedName of unique) {
      await db`
        INSERT INTO graph_seed_exposure (run_id, seed_name)
        VALUES (${runId}, ${seedName})
        ON CONFLICT (run_id, seed_name) DO NOTHING
      `;
    }
  } catch (err) {
    log.warn("recordSeedExposure failed — skipping", { err });
  }
}

/** Load the seed names that fed a run (for the write-back credit assignment). */
export async function loadRunSeeds(runId: string): Promise<readonly string[]> {
  try {
    const db = getDb();
    const rows = (await db`
      SELECT seed_name FROM graph_seed_exposure WHERE run_id = ${runId}
    `) as { seed_name: string }[];
    return rows.map((r) => r.seed_name);
  } catch (err) {
    log.warn("loadRunSeeds failed — returning empty", { err });
    return [];
  }
}

/**
 * Append outcome events to the immutable log, de-duped by the
 * (run_id, seed_name, verdict) UNIQUE constraint (ON CONFLICT DO NOTHING) so a
 * re-run never double-counts. Best-effort. Empty input is a no-op.
 */
export async function appendOutcomeEvents(events: readonly GraphOutcomeEvent[]): Promise<void> {
  if (events.length === 0) return;
  try {
    const db = getDb();
    for (const event of events) {
      await db`
        INSERT INTO graph_outcome_events (run_id, seed_name, verdict, weight, created_at_sec)
        VALUES (${event.runId}, ${event.seedName}, ${event.verdict}, ${event.weight}, ${event.createdAtSec})
        ON CONFLICT (run_id, seed_name, verdict) DO NOTHING
      `;
    }
  } catch (err) {
    log.warn("appendOutcomeEvents failed — skipping", { err });
  }
}

interface OutcomeEventRow {
  readonly run_id: string;
  readonly seed_name: string;
  readonly verdict: "validated" | "killed";
  readonly weight: number;
  readonly created_at_sec: number;
}

/** rowToEvent mapper (XRow ↔ domain split). PURE. */
function rowToEvent(row: OutcomeEventRow): GraphOutcomeEvent {
  return {
    runId: row.run_id,
    seedName: row.seed_name,
    verdict: row.verdict,
    weight: Number(row.weight),
    createdAtSec: Number(row.created_at_sec),
  };
}

/**
 * Materialize graph_seed_weights from the decayed event log. Reads ALL events,
 * groups by seed, applies temporal decay (using `now`/`halfLifeDays`), and upserts
 * one row per seed with its decayed success_weight, exposure_count (distinct runs),
 * and sample_count (events). Best-effort; never throws. Returns the number of seeds
 * materialized.
 */
export async function recomputeSeedWeights(params: {
  readonly now: number;
  readonly halfLifeDays: number;
}): Promise<number> {
  try {
    const db = getDb();
    const rows = (await db`
      SELECT run_id, seed_name, verdict, weight, created_at_sec
      FROM graph_outcome_events
    `) as OutcomeEventRow[];

    const bySeed = new Map<string, GraphOutcomeEvent[]>();
    for (const row of rows) {
      const event = rowToEvent(row);
      const list = bySeed.get(event.seedName);
      if (list) list.push(event);
      else bySeed.set(event.seedName, [event]);
    }

    let materialized = 0;
    for (const [seedName, events] of bySeed) {
      const successWeight = decaySeedWeight(events, params.now, params.halfLifeDays);
      const exposureCount = new Set(events.map((e) => e.runId)).size;
      const sampleCount = events.length;
      await db`
        INSERT INTO graph_seed_weights (seed_name, success_weight, exposure_count, sample_count, updated_at)
        VALUES (${seedName}, ${successWeight}, ${exposureCount}, ${sampleCount}, now())
        ON CONFLICT (seed_name) DO UPDATE SET
          success_weight = EXCLUDED.success_weight,
          exposure_count = EXCLUDED.exposure_count,
          sample_count = EXCLUDED.sample_count,
          updated_at = now()
      `;
      materialized += 1;
    }
    log.debug("recomputeSeedWeights done", { seeds: materialized, events: rows.length });
    return materialized;
  } catch (err) {
    log.warn("recomputeSeedWeights failed — skipping", { err });
    return 0;
  }
}

interface SeedWeightRow {
  readonly seed_name: string;
  readonly success_weight: number;
  readonly exposure_count: number;
}

/** Load the materialized weights as Neo4j projection rows. Best-effort → []. */
export async function loadSeedWeightsForProjection(): Promise<readonly SeedWeightProjection[]> {
  try {
    const db = getDb();
    const rows = (await db`
      SELECT seed_name, success_weight, exposure_count FROM graph_seed_weights
    `) as SeedWeightRow[];
    return rows.map((r) => ({
      seedName: r.seed_name,
      successWeight: Number(r.success_weight),
      exposureCount: Number(r.exposure_count),
    }));
  } catch (err) {
    log.warn("loadSeedWeightsForProjection failed — returning empty", { err });
    return [];
  }
}

/**
 * Project the materialized weights onto the live Neo4j graph via the WRITE client.
 * Idempotent (SET on existing `:Entity` seeds). Gated by the `projectToNeo4j`
 * sub-flag at the call site; this function itself just loads + projects. The write
 * client never throws, so this is best-effort. Returns the number of seeds
 * projected.
 */
export async function projectLearnedWeights(writeClient: Neo4jWriteClient): Promise<number> {
  const rows = await loadSeedWeightsForProjection();
  // Even an empty set is projected so the write client ensures the supporting
  // range index before the first real projection.
  const projected = await writeClient.projectSeedWeights(rows);
  log.debug("projectLearnedWeights done", { rows: rows.length, projected });
  return projected;
}
