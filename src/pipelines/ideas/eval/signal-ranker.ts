/**
 * Pure ranker-precision aggregation for the offline ideas eval harness.
 *
 * Closes the measurement loop on the signal-ranking layer: it asks "does the
 * LLM ranker actually predict validated ideas?" rather than just trusting the
 * importance bucket it stamped. Concretely, over the labeled join of
 * signal_facets.importance ↔ downstream idea outcome (success = the signal
 * helped seed a validated/built idea, failure = archived/dismissed) we report:
 *
 *   1. PER-BUCKET VALIDATION RATE — the realized fraction of signals in each
 *      importance bucket (noise|low|medium|high) that produced a validated idea,
 *      plus the Beta-calibrated weight (posterior mean) for that bucket.
 *   2. CALIBRATION GAP — the LLM's *asserted* usefulness (mean relevanceToIdeas,
 *      when supplied) vs the *realized* validation rate, per bucket. A large gap
 *      means the model is mis-stating how useful a bucket is.
 *   3. RANKER PRECISION / LIFT — do the buckets the model called important
 *      actually validate more? We compare the high tier (medium+high) against the
 *      low tier (noise+low), report the lift (high-tier rate ÷ low-tier rate),
 *      and check whether the per-bucket rates are monotonically non-decreasing
 *      with importance (the property a well-calibrated ranker should have).
 *
 * The aggregation MATH is intentionally PURE and dependency-free (no DB, no
 * clock, no LLM) so it can be unit-tested in the unit lane. It REUSES
 * {@link computeSignalCalibration} from ../signal-calibration so the per-bucket
 * Beta posteriors stay identical to the live calibration the retrieval layer
 * applies — the eval never re-implements the join or the math.
 *
 * Everything is OPTIONAL and graceful: when no labeled signal rows exist yet
 * (cold start, ranking disabled, pre-migration DB) the section is simply null
 * and the rest of the eval run is unaffected.
 */

import {
  IMPORTANCE_BUCKETS,
  computeSignalCalibration,
  type LabeledSignalRow,
  type SignalCalibration,
} from "../signal-calibration";
import type { SignalImportance } from "../../../memory/signal-facets";
import { roundOrNull } from "./aggregate";

// ── Input row shape ─────────────────────────────────────────────────────────────

/**
 * A labeled signal outcome enriched, optionally, with the LLM's asserted
 * relevanceToIdeas at rank time. This is a superset of {@link LabeledSignalRow}:
 * the extra `relevanceToIdeas` is only used for the CALIBRATION GAP and is
 * ignored by the Beta math, so callers that only have the calibration row shape
 * can pass it directly.
 */
export interface RankerEvalRow extends LabeledSignalRow {
  /** The LLM's asserted usefulness in [0,1] at rank time, when known. */
  readonly relevanceToIdeas?: number;
}

// ── Output shape ────────────────────────────────────────────────────────────────

/** Per-importance-bucket precision stats. */
export interface BucketPrecision {
  readonly importance: SignalImportance;
  /** Total labeled signals attributed to this bucket. */
  readonly n: number;
  readonly successes: number;
  readonly failures: number;
  /** Realized validation rate = successes / n, or null when the bucket is empty. */
  readonly validationRate: number | null;
  /** Beta posterior mean (the calibrated weight the retrieval layer applies). */
  readonly calibratedWeight: number;
  /**
   * Mean LLM-asserted relevanceToIdeas for this bucket, or null when relevance
   * was not supplied / no rows. Used as the model's "asserted usefulness".
   */
  readonly assertedRelevance: number | null;
  /**
   * Calibration gap = assertedRelevance − validationRate (signed). Positive ⇒
   * the model over-stated this bucket's usefulness; negative ⇒ under-stated.
   * null when either side is unknown.
   */
  readonly calibrationGap: number | null;
}

/** Ranker precision / lift summary across buckets. */
export interface SignalRankerReport {
  /** Per-bucket stats, always all four buckets in noise→high order. */
  readonly buckets: readonly BucketPrecision[];
  /** Total labeled signals across all buckets. */
  readonly totalLabeled: number;
  /** Validation rate of the LOW tier (noise+low), or null when empty. */
  readonly lowTierRate: number | null;
  /** Validation rate of the HIGH tier (medium+high), or null when empty. */
  readonly highTierRate: number | null;
  /**
   * Ranker lift = highTierRate ÷ lowTierRate. >1 ⇒ the model's "important"
   * signals validate more than its "unimportant" ones (the ranker has signal).
   * null when either tier is empty or the low-tier rate is 0.
   */
  readonly lift: number | null;
  /**
   * true when per-bucket validation rates are monotonically non-decreasing with
   * importance over the buckets that actually have observations — the ordering
   * property a well-calibrated ranker should exhibit. null when fewer than two
   * buckets are observed (nothing to order).
   */
  readonly monotonic: boolean | null;
  /**
   * Mean |calibrationGap| over buckets that have one — a single scalar for how
   * far off the model's asserted usefulness is from reality. null when no bucket
   * has a gap (no relevance supplied).
   */
  readonly meanAbsCalibrationGap: number | null;
}

// ── Constants ───────────────────────────────────────────────────────────────────

/** Importance buckets considered the "low" tier for the lift comparison. */
const LOW_TIER: ReadonlySet<SignalImportance> = new Set<SignalImportance>([
  "noise",
  "low",
]);
/** Importance buckets considered the "high" tier for the lift comparison. */
const HIGH_TIER: ReadonlySet<SignalImportance> = new Set<SignalImportance>([
  "medium",
  "high",
]);

// ── Helpers ─────────────────────────────────────────────────────────────────────

function clamp01OrNull(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function meanOrNull(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

interface TierTally {
  successes: number;
  total: number;
}

function tierRate(tally: TierTally): number | null {
  return tally.total === 0 ? null : tally.successes / tally.total;
}

// ── Pure aggregation ────────────────────────────────────────────────────────────

/**
 * Compute the ranker-precision report from labeled signal rows. PURE — no DB,
 * no clock, no LLM. REUSES {@link computeSignalCalibration} for the per-bucket
 * Beta posteriors so the calibrated weights match the live calibration exactly;
 * the realized validation rate and the asserted-relevance gap are layered on
 * top from the raw rows.
 *
 * Returns null when there are NO labeled rows (cold start), so the eval harness
 * can omit the section entirely rather than reporting an all-empty block.
 *
 * @param rows  labeled signal outcomes (optionally carrying relevanceToIdeas)
 */
export function aggregateSignalRanker(
  rows: readonly RankerEvalRow[],
): SignalRankerReport | null {
  if (rows.length === 0) return null;

  const calibration: SignalCalibration = computeSignalCalibration(rows);

  // Mean asserted relevance per bucket (only over rows that carry a finite one).
  const relevanceByBucket = new Map<SignalImportance, number[]>();
  for (const bucket of IMPORTANCE_BUCKETS) {
    relevanceByBucket.set(bucket, []);
  }
  for (const row of rows) {
    if (!isBucket(row.importance)) continue;
    const rel = clamp01OrNull(row.relevanceToIdeas);
    if (rel !== null) relevanceByBucket.get(row.importance)!.push(rel);
  }

  const buckets: BucketPrecision[] = [];
  const absGaps: number[] = [];
  const lowTier: TierTally = { successes: 0, total: 0 };
  const highTier: TierTally = { successes: 0, total: 0 };

  for (const importance of IMPORTANCE_BUCKETS) {
    const cell = calibration.importanceCells[importance];
    const n = cell.successes + cell.failures;
    const validationRate = n === 0 ? null : cell.successes / n;
    const assertedRelevance = meanOrNull(relevanceByBucket.get(importance)!);
    const calibrationGap =
      assertedRelevance !== null && validationRate !== null
        ? assertedRelevance - validationRate
        : null;
    if (calibrationGap !== null) absGaps.push(Math.abs(calibrationGap));

    if (LOW_TIER.has(importance)) {
      lowTier.successes += cell.successes;
      lowTier.total += n;
    } else if (HIGH_TIER.has(importance)) {
      highTier.successes += cell.successes;
      highTier.total += n;
    }

    buckets.push({
      importance,
      n,
      successes: cell.successes,
      failures: cell.failures,
      validationRate: roundOrNull(validationRate),
      calibratedWeight: roundOrNull(cell.weight) ?? cell.weight,
      assertedRelevance: roundOrNull(assertedRelevance),
      calibrationGap: roundOrNull(calibrationGap),
    });
  }

  const lowTierRate = tierRate(lowTier);
  const highTierRate = tierRate(highTier);
  const lift =
    highTierRate !== null && lowTierRate !== null && lowTierRate > 0
      ? highTierRate / lowTierRate
      : null;

  return {
    buckets,
    totalLabeled: rows.length,
    lowTierRate: roundOrNull(lowTierRate),
    highTierRate: roundOrNull(highTierRate),
    lift: roundOrNull(lift),
    monotonic: computeMonotonic(buckets),
    meanAbsCalibrationGap: roundOrNull(meanOrNull(absGaps)),
  };
}

/**
 * Whether per-bucket validation rates are monotonically non-decreasing with
 * importance over the OBSERVED buckets. Skips empty buckets (no rate) so an
 * absent middle bucket doesn't spuriously break the order. Returns null when
 * fewer than two buckets are observed (nothing to compare).
 */
function computeMonotonic(buckets: readonly BucketPrecision[]): boolean | null {
  const rates = buckets
    .map((b) => b.validationRate)
    .filter((r): r is number => r !== null);
  if (rates.length < 2) return null;
  for (let i = 1; i < rates.length; i++) {
    const prev = rates[i - 1] as number;
    const cur = rates[i] as number;
    if (cur < prev - 1e-9) return false;
  }
  return true;
}

function isBucket(value: unknown): value is SignalImportance {
  return (
    typeof value === "string" &&
    (IMPORTANCE_BUCKETS as readonly string[]).includes(value)
  );
}
