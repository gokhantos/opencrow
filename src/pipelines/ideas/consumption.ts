/**
 * Decaying consumption ledger.
 *
 * Tracks which source data points have been consumed by pipeline runs so each
 * run sees fresh data. Historically a consumed signal was excluded forever.
 * This module replaces that consume-once rule with a DECAYING ledger:
 *
 *  - Each consume bumps `consumption_count` and refreshes `last_used_at`.
 *  - A signal's "consumed" weight decays exponentially with age
 *    (half-life model). While the weight is at/above the resurfacing
 *    threshold the signal stays excluded; once it decays below the threshold
 *    the signal becomes eligible again ("resurfaces").
 *  - A strongly-corroborated signal (one consumed many times) decays FASTER,
 *    so genuinely important, repeatedly-seen signals can resurface sooner for
 *    re-consideration rather than being suppressed permanently.
 *
 * Decay is OPT-IN. With `enabled: false` (the default), the behaviour matches
 * the legacy semantics exactly: every consumed signal is excluded forever.
 */
import { getDb } from "../../store/db";
import { createLogger } from "../../logger";

const log = createLogger("pipeline:consumption");

// ── Pure decay model ─────────────────────────────────────────────────────────

/** Tunables for the consumption decay model. All times in days. */
export interface DecayConfig {
  /** When false, consumed signals never resurface (legacy consume-once). */
  readonly enabled: boolean;
  /** Half-life of a single-consumption signal, in days. */
  readonly halfLifeDays: number;
  /**
   * A signal is still considered "consumed" while its decayed weight is at or
   * above this threshold (0..1). Lower = signals resurface sooner.
   */
  readonly resurfaceThreshold: number;
  /**
   * How much each extra consumption shortens the effective half-life. With
   * boost b and count c the effective half-life is halfLifeDays / (1 + b*(c-1)),
   * so strongly-corroborated signals decay faster and resurface sooner.
   */
  readonly corroborationBoost: number;
}

export const DEFAULT_DECAY_CONFIG: DecayConfig = {
  enabled: false,
  halfLifeDays: 14,
  resurfaceThreshold: 0.5,
  corroborationBoost: 0.25,
};

const SECONDS_PER_DAY = 86_400;

/** Inputs to the pure weight calculation. */
export interface ConsumptionWeightParams {
  /** Most recent consume time, epoch seconds. */
  readonly lastUsedAt: number;
  /** Distinct times the signal has been consumed (>= 1). */
  readonly consumptionCount: number;
  /** Evaluation time, epoch seconds. */
  readonly now: number;
  readonly config: DecayConfig;
}

/**
 * Effective half-life in days for a signal given how many times it has been
 * consumed. More consumptions → shorter half-life (faster decay). Pure.
 */
export function effectiveHalfLifeDays(
  consumptionCount: number,
  config: DecayConfig,
): number {
  const count = Number.isFinite(consumptionCount) ? Math.max(1, consumptionCount) : 1;
  const halfLife = config.halfLifeDays > 0 ? config.halfLifeDays : DEFAULT_DECAY_CONFIG.halfLifeDays;
  const boost = config.corroborationBoost >= 0 ? config.corroborationBoost : 0;
  const denom = 1 + boost * (count - 1);
  return halfLife / denom;
}

/**
 * Decayed "consumed" weight in [0, 1]. 1 = just consumed, decaying toward 0
 * as the signal ages. Pure & total — never throws, clamps to [0, 1].
 */
export function consumptionWeight(params: ConsumptionWeightParams): number {
  const { lastUsedAt, consumptionCount, now, config } = params;

  const ageSeconds = now - lastUsedAt;
  // Future-dated / just-consumed signals are at full weight.
  if (!Number.isFinite(ageSeconds) || ageSeconds <= 0) return 1;

  const ageDays = ageSeconds / SECONDS_PER_DAY;
  const halfLife = effectiveHalfLifeDays(consumptionCount, config);
  if (!(halfLife > 0)) return 1;

  const weight = Math.pow(0.5, ageDays / halfLife);
  if (!Number.isFinite(weight)) return 0;
  return Math.min(1, Math.max(0, weight));
}

/**
 * Whether a consumed signal should STILL be excluded from collection. When
 * decay is disabled this is always true (legacy consume-once). Otherwise the
 * signal stays excluded only while its decayed weight is at/above the
 * resurfacing threshold. Pure.
 */
export function isStillConsumed(params: ConsumptionWeightParams): boolean {
  if (!params.config.enabled) return true;
  return consumptionWeight(params) >= params.config.resurfaceThreshold;
}

// ── DB-backed ledger ─────────────────────────────────────────────────────────

interface ConsumedRow {
  readonly source_id: string;
  readonly consumption_count: number;
  readonly last_used_at: number | null;
  readonly consumed_at: number;
}

/**
 * Get the IDs from a source table that are STILL considered consumed (i.e.
 * should be excluded from collection) under the decay model. With the default
 * (disabled) config this returns every consumed ID, matching legacy behaviour.
 *
 * @param config decay tunables; omit/disable to keep legacy consume-once.
 * @param now    evaluation time (epoch seconds); injectable for testing.
 */
export async function getConsumedIds(
  sourceTable: string,
  config: DecayConfig = DEFAULT_DECAY_CONFIG,
  now: number = Math.floor(Date.now() / 1000),
): Promise<ReadonlySet<string>> {
  const db = getDb();

  try {
    // Fast path: decay disabled → legacy query, every consumed id excluded.
    if (!config.enabled) {
      const rows = (await db`
        SELECT source_id FROM pipeline_consumed_signals
        WHERE source_table = ${sourceTable}
      `) as Array<{ source_id: string }>;
      return new Set(rows.map((r) => r.source_id));
    }

    const rows = (await db`
      SELECT source_id, consumption_count, last_used_at, consumed_at
      FROM pipeline_consumed_signals
      WHERE source_table = ${sourceTable}
    `) as ConsumedRow[];

    const stillConsumed = rows
      .filter((r) =>
        isStillConsumed({
          lastUsedAt: r.last_used_at ?? r.consumed_at,
          consumptionCount: r.consumption_count ?? 1,
          now,
          config,
        }),
      )
      .map((r) => r.source_id);

    return new Set(stillConsumed);
  } catch (err) {
    log.warn("Failed to fetch consumed IDs, returning empty set", { sourceTable, err });
    return new Set();
  }
}

/**
 * Mark source IDs as consumed by a pipeline run. On conflict the ledger entry
 * is updated rather than replaced: `consumption_count` is incremented and
 * `last_used_at` refreshed, so the decay model can see how strongly a signal
 * has been corroborated across runs. Degrades gracefully (non-fatal on error).
 */
export async function markConsumed(
  runId: string,
  sourceTable: string,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;

  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  try {
    // Batch insert with conflict handling — 50 rows per batch
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      const values = batch.map((sourceId) => ({
        id: crypto.randomUUID(),
        pipeline_run_id: runId,
        source_table: sourceTable,
        source_id: sourceId,
        consumed_at: now,
        consumption_count: 1,
        last_used_at: now,
      }));

      await db`
        INSERT INTO pipeline_consumed_signals ${db(values)}
        ON CONFLICT (source_table, source_id)
        DO UPDATE SET
          pipeline_run_id = EXCLUDED.pipeline_run_id,
          consumed_at = EXCLUDED.consumed_at,
          last_used_at = EXCLUDED.last_used_at,
          consumption_count = pipeline_consumed_signals.consumption_count + 1
      `;
    }

    log.debug("Marked signals as consumed", { runId, sourceTable, count: ids.length });
  } catch (err) {
    log.warn("Failed to mark consumed signals (non-fatal)", { runId, sourceTable, err });
  }
}
