/**
 * READ-ONLY competability threshold calibration / backtest.
 *
 * The live competability gate ({@link decideCompetability} in `competability.ts`)
 * uses GUESSED thresholds (DEFAULT_REJECT_THRESHOLD=2.0, soft band 2.5,
 * ALWAYS_REJECT_OVERALL=1.5). This module backtests those thresholds against the
 * persisted `competability_overall` / `competability_json` distribution and
 * RECOMMENDS a data-driven reject threshold. It NEVER changes gate behavior — it
 * only INFORMS what a human might set.
 *
 * Everything here is PURE, immutable, and deterministic: NO Date.now / Math.random,
 * NO IO. Given the same input records it always produces the same report, so it is
 * trivially unit-testable.
 *
 * The backtest models the SIMPLE `overall < threshold` rejection rule. The LIVE
 * gate is NON-COMPENSATORY (a single dominant moat dimension or the ALWAYS_REJECT
 * floor can sink an idea whose overall sits above the reject threshold), so the
 * `killRateCurve` here APPROXIMATES the live kill rate; the observed `gatedFraction`
 * (what the live gate actually flagged) is reported alongside for comparison.
 */

import {
  COMPETABILITY_DIMENSIONS,
  COMPETABILITY_MAX,
  COMPETABILITY_MIN,
  type CompetabilityDimension,
  DEFAULT_REJECT_THRESHOLD,
} from "./competability";

// ── Named constants (no magic numbers) ───────────────────────────────────────

/** Histogram bucket width over the [0, 5] overall-score range. */
export const BUCKET_WIDTH = 0.5;

/** Candidate-threshold scan step for the kill-rate curve. */
export const THRESHOLD_STEP = 0.5;

/**
 * Target kill-rate band [low, high] used by the UNIMODAL fallback. Justification:
 * the gate exists to cull the clearly-uncompetable tail ("build a DoorDash"),
 * roughly the bottom quartile — not to reject the bulk of generated ideas. A band
 * of 0.15..0.35 keeps the gate aggressive enough to bite the bottom tail while
 * leaving the healthy middle of the distribution to the downstream scoring stages.
 */
export const TARGET_KILL_RATE_LOW = 0.15;
export const TARGET_KILL_RATE_HIGH = 0.35;

/** Mid-point of the target band — the unimodal fallback aims here. */
export const TARGET_KILL_RATE_MID = (TARGET_KILL_RATE_LOW + TARGET_KILL_RATE_HIGH) / 2;

/**
 * Below this sample size the recommendation is statistically untrustworthy.
 * Justified: with < 30 scored ideas a single bucket holds only a handful of points,
 * so any "valley" is noise and any kill-rate estimate has a wide confidence
 * interval. We still emit a recommendation (so the tool never crashes / blanks) but
 * flag `lowConfidence` and say so in `caveats`.
 */
export const LOW_CONFIDENCE_SAMPLE_CUTOFF = 30;

/**
 * A bucket boundary only qualifies as a "valley" separating two clusters when BOTH
 * sides carry at least this fraction of total mass. Prevents a lone low-overall
 * outlier from masquerading as a competable/uncompetable split.
 */
export const VALLEY_MIN_SIDE_MASS_FRACTION = 0.1;

// ── Input / output types (all readonly) ───────────────────────────────────────

/** One backtest record: the persisted overall, the live gated flag, optional dims. */
export interface CalibrationRecord {
  readonly overall: number;
  readonly gated: boolean;
  readonly dimensions?: Readonly<Record<CompetabilityDimension, number>>;
}

/** A single histogram bucket over the overall score. Half-open `[lo, hi)`. */
export interface HistogramBucket {
  readonly lo: number;
  readonly hi: number;
  readonly count: number;
}

/** A single point on the kill-rate curve: fraction rejected at `overall < threshold`. */
export interface KillRatePoint {
  readonly threshold: number;
  readonly rejectFraction: number;
}

/** The full calibration report. All fields readonly / immutable. */
export interface CompetabilityCalibrationReport {
  readonly sampleSize: number;
  readonly lowConfidence: boolean;
  readonly histogram: readonly HistogramBucket[];
  readonly killRateCurve: readonly KillRatePoint[];
  readonly currentThreshold: number;
  readonly currentKillRate: number;
  /** Fraction of records the LIVE gate flagged (gated===true) — for comparison. */
  readonly gatedFraction: number;
  /** Per-moat-dimension mean across records that carry dims. */
  readonly dimensionAverages: Readonly<Record<CompetabilityDimension, number>>;
  /** How many records carried a well-formed `dimensions` object. */
  readonly recordsWithDimensions: number;
  readonly recommendedThreshold: number;
  /** How the recommendation was derived: the valley scan or the band fallback. */
  readonly recommendationMethod: "valley" | "target-band-fallback";
  readonly caveats: string;
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

function clampOverall(value: number): number {
  if (!Number.isFinite(value)) return COMPETABILITY_MIN;
  return Math.min(COMPETABILITY_MAX, Math.max(COMPETABILITY_MIN, value));
}

/** Fixed bucket boundaries: 0, 0.5, … 5.0 → buckets [0,0.5) … [4.5,5.0]. */
function bucketBoundaries(): readonly number[] {
  const edges: number[] = [];
  // Build inclusive of COMPETABILITY_MAX; guard float drift by rounding to a grid.
  const steps = Math.round((COMPETABILITY_MAX - COMPETABILITY_MIN) / BUCKET_WIDTH);
  for (let i = 0; i <= steps; i++) {
    edges.push(COMPETABILITY_MIN + i * BUCKET_WIDTH);
  }
  return edges;
}

/**
 * Build the histogram. Buckets are half-open `[lo, hi)` so a value exactly on an
 * interior boundary lands in the UPPER bucket (e.g. 2.5 → the [2.5, 3.0) bucket).
 * The TOP bucket is closed `[lo, MAX]` so the maximum score (5.0) is counted.
 */
function buildHistogram(records: readonly CalibrationRecord[]): readonly HistogramBucket[] {
  const edges = bucketBoundaries();
  const counts = new Array<number>(edges.length - 1).fill(0);

  for (const record of records) {
    const v = clampOverall(record.overall);
    // Index of the half-open bucket; the top edge maps to the last bucket.
    let idx = Math.floor((v - COMPETABILITY_MIN) / BUCKET_WIDTH);
    if (idx >= counts.length) idx = counts.length - 1; // v === MAX → last bucket
    if (idx < 0) idx = 0;
    counts[idx] = (counts[idx] ?? 0) + 1;
  }

  const buckets: HistogramBucket[] = [];
  for (let i = 0; i < counts.length; i++) {
    const lo = edges[i] ?? COMPETABILITY_MIN;
    const hi = edges[i + 1] ?? COMPETABILITY_MAX;
    buckets.push({ lo, hi, count: counts[i] ?? 0 });
  }
  return buckets;
}

/** Fraction of records with `overall < threshold` (the simple backtest rule). */
function rejectFractionAt(records: readonly CalibrationRecord[], threshold: number): number {
  if (records.length === 0) return 0;
  let rejected = 0;
  for (const record of records) {
    if (clampOverall(record.overall) < threshold) rejected += 1;
  }
  return rejected / records.length;
}

function buildKillRateCurve(records: readonly CalibrationRecord[]): readonly KillRatePoint[] {
  const points: KillRatePoint[] = [];
  const steps = Math.round((COMPETABILITY_MAX - COMPETABILITY_MIN) / THRESHOLD_STEP);
  for (let i = 0; i <= steps; i++) {
    const threshold = COMPETABILITY_MIN + i * THRESHOLD_STEP;
    points.push({ threshold, rejectFraction: rejectFractionAt(records, threshold) });
  }
  return points;
}

function emptyDimensionAverages(): Record<CompetabilityDimension, number> {
  const out = {} as Record<CompetabilityDimension, number>;
  for (const key of COMPETABILITY_DIMENSIONS) out[key] = 0;
  return out;
}

function computeDimensionAverages(records: readonly CalibrationRecord[]): {
  readonly averages: Readonly<Record<CompetabilityDimension, number>>;
  readonly withDimensions: number;
} {
  const sums = emptyDimensionAverages();
  let withDimensions = 0;
  for (const record of records) {
    const dims = record.dimensions;
    if (!dims) continue;
    withDimensions += 1;
    for (const key of COMPETABILITY_DIMENSIONS) {
      sums[key] += clampOverall(dims[key]);
    }
  }
  const averages = emptyDimensionAverages();
  if (withDimensions > 0) {
    for (const key of COMPETABILITY_DIMENSIONS) {
      averages[key] = sums[key] / withDimensions;
    }
  }
  return { averages, withDimensions };
}

/**
 * Find the natural VALLEY threshold separating a low-overall "uncompetable" cluster
 * from a high-overall "competable" cluster.
 *
 * Heuristic: scan every INTERIOR bucket boundary. A boundary at `hi` of bucket i
 * splits the mass into "below" (buckets 0..i) and "above" (buckets i+1..end). We
 * require BOTH sides to carry at least {@link VALLEY_MIN_SIDE_MASS_FRACTION} of the
 * total mass (so the boundary genuinely separates two clusters, not an outlier),
 * then pick the boundary with the lowest LOCAL density — defined as the count of
 * the two buckets ADJACENT to the boundary (bucket i and bucket i+1). The lowest
 * adjacent-density qualifying boundary is the valley. Ties break toward the LOWER
 * threshold (more conservative — rejects fewer ideas). Returns null when no
 * boundary separates mass on both sides (effectively unimodal).
 */
function findValleyThreshold(
  histogram: readonly HistogramBucket[],
  total: number,
): number | null {
  if (total === 0 || histogram.length < 2) return null;
  const minSideMass = total * VALLEY_MIN_SIDE_MASS_FRACTION;

  let best: { threshold: number; density: number } | null = null;
  let belowMass = 0;
  for (let i = 0; i < histogram.length - 1; i++) {
    const current = histogram[i];
    const next = histogram[i + 1];
    if (!current || !next) continue;
    belowMass += current.count;
    const aboveMass = total - belowMass;
    if (belowMass < minSideMass || aboveMass < minSideMass) continue;

    const boundary = current.hi; // = next.lo
    const localDensity = current.count + next.count;
    if (best === null || localDensity < best.density) {
      best = { threshold: boundary, density: localDensity };
    }
  }
  return best?.threshold ?? null;
}

/**
 * UNIMODAL fallback: pick the candidate threshold from the kill-rate curve whose
 * reject fraction lands closest to {@link TARGET_KILL_RATE_MID}, preferring a value
 * INSIDE the [low, high] band; ties break toward the LOWER threshold.
 */
function targetBandThreshold(curve: readonly KillRatePoint[]): number {
  let best: { threshold: number; distance: number; inBand: boolean } | null = null;
  for (const point of curve) {
    const inBand =
      point.rejectFraction >= TARGET_KILL_RATE_LOW &&
      point.rejectFraction <= TARGET_KILL_RATE_HIGH;
    const distance = Math.abs(point.rejectFraction - TARGET_KILL_RATE_MID);
    if (best === null) {
      best = { threshold: point.threshold, distance, inBand };
      continue;
    }
    // Prefer in-band over out-of-band; then smaller distance; then lower threshold.
    const better =
      (inBand && !best.inBand) ||
      (inBand === best.inBand && distance < best.distance - 1e-9);
    if (better) best = { threshold: point.threshold, distance, inBand };
  }
  return best?.threshold ?? DEFAULT_REJECT_THRESHOLD;
}

function buildCaveats(sampleSize: number, lowConfidence: boolean, withDims: number): string {
  const parts: string[] = [];
  if (sampleSize === 0) {
    parts.push(
      "No scored ideas yet — recommendation defaults to the current threshold; collect data before tuning.",
    );
  } else if (lowConfidence) {
    parts.push(
      `Only ${sampleSize} scored ideas (< ${LOW_CONFIDENCE_SAMPLE_CUTOFF}); the recommendation is low-confidence and bucket-level structure is likely noise.`,
    );
  }
  if (withDims === 0 && sampleSize > 0) {
    parts.push("No records carried moat dimensions; dimensionAverages are all zero.");
  }
  parts.push(
    "Backtest models the simple overall<threshold rule; the live gate is non-compensatory, so compare recommendedThreshold against the observed gatedFraction.",
  );
  return parts.join(" ");
}

// ── Public entry ──────────────────────────────────────────────────────────────

/**
 * Backtest the persisted competability distribution and recommend a data-driven
 * reject threshold. PURE — deterministic for a given input. See the module header
 * for the modeling caveats (simple backtest vs the non-compensatory live gate).
 */
export function calibrateCompetability(
  records: readonly CalibrationRecord[],
): CompetabilityCalibrationReport {
  const sampleSize = records.length;
  const lowConfidence = sampleSize < LOW_CONFIDENCE_SAMPLE_CUTOFF;

  const histogram = buildHistogram(records);
  const killRateCurve = buildKillRateCurve(records);
  const currentThreshold = DEFAULT_REJECT_THRESHOLD;
  const currentKillRate = rejectFractionAt(records, currentThreshold);

  let gatedCount = 0;
  for (const record of records) {
    if (record.gated) gatedCount += 1;
  }
  const gatedFraction = sampleSize > 0 ? gatedCount / sampleSize : 0;

  const { averages: dimensionAverages, withDimensions } = computeDimensionAverages(records);

  // Recommendation: prefer the natural valley; fall back to the target band when
  // the distribution is effectively unimodal (no clear separating boundary). With
  // zero samples there is nothing to recommend, so keep the current threshold.
  const valley = sampleSize > 0 ? findValleyThreshold(histogram, sampleSize) : null;
  const recommendedThreshold = valley ?? (sampleSize > 0 ? targetBandThreshold(killRateCurve) : currentThreshold);
  const recommendationMethod: "valley" | "target-band-fallback" =
    valley !== null ? "valley" : "target-band-fallback";

  return {
    sampleSize,
    lowConfidence,
    histogram,
    killRateCurve,
    currentThreshold,
    currentKillRate,
    gatedFraction,
    dimensionAverages,
    recordsWithDimensions: withDimensions,
    recommendedThreshold,
    recommendationMethod,
    caveats: buildCaveats(sampleSize, lowConfidence, withDimensions),
  };
}
