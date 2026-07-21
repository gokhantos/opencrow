// Deterministic scoring core for the App Store keyword-gap scanner. Pure
// functions only — no I/O, no Date, no Math.random. Consumes TopApp/GapTrend
// from `keyword-types.ts` and produces the four KeywordGapProfile scores:
// demand, competitiveness, incumbent-weakness, and opportunity (whitespace).
//
// Separation of concerns: all history/velocity data (per-app review deltas
// across scans, the demand time-series for trend) is fetched in
// `keyword-gaps.ts` and PASSED IN as plain numbers/fields. This module never
// touches the DB or the clock.

import type { GapTrend, TopApp } from "./keyword-types";

export const REVIEWS_REF = 500_000;
export const VELOCITY_REF = 400;

// Weight on the recent-velocity momentum term relative to the lifetime
// baseline (both measured in ratings/day). At 1.0 a review gained in the recent
// window counts the same as one implied by the lifetime average rate — an
// unbiased blend. In the live corpus measured velocity is ≈0 for the vast
// majority of keywords (most apps gain no reviews in a ~12h window), so this
// term is a momentum BONUS layered on top of the baseline for the occasional
// heating field, never the primary discriminator.
export const VELOCITY_WEIGHT = 1.0;

// Reference demand for opportunity normalization, in ratings/day.
//
// `demand` blends a lifetime-review-mass baseline (mean lifetime ratings/day
// across the title-matched incumbents — a floor reflecting the market pull an
// established field already has, never 0 for a real app with reviews) with a
// recent-velocity momentum bonus. It is deliberately NOT pure velocity: an
// earlier overhaul set demand = mean recent ratings/day, which collapsed to 0
// for ~1,176 of 1,213 live keywords — most apps gain 0 reviews in a 12h window,
// so velocity, and thus demand and opportunity, flatlined at 0 and stopped
// discriminating (the opposite failure of the older everything-saturates model).
//
// The blended baseline spreads well over the real corpus (mean lifetime
// ratings/day per keyword: p25≈0.6, p50≈6, p75≈19, p90≈48). Anchoring the log
// reference at 80 ratings/day keeps that whole range on the responsive part of
// the curve (norm(6)≈0.45, norm(19)≈0.68, norm(48)≈0.89, norm(80)=1.0), so
// demand normalizes to a ~[0.1..0.9] spread instead of pinning to 0 or 1.
export const DEMAND_REF = 80;

// Update-staleness window (days since the leader's currentVersionReleaseDate):
// a leader shipped in the last month reads as actively maintained (0 staleness);
// one untouched for a year+ reads as fully stale (1.0) and thus more beatable.
const FRESH_UPDATE_DAYS = 30;
const STALE_UPDATE_DAYS = 365;

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
const norm = (x: number, ref: number): number => clamp01(Math.log1p(x) / Math.log1p(ref));

// per-app entrenchment blends lifetime review mass and lifetime velocity — a
// stable measure of how established the incumbent is (used for competitiveness
// and for picking the leader), deliberately NOT the recent velocity used for
// live demand.
const appStrength = (a: TopApp): number =>
  0.6 * norm(a.reviews, REVIEWS_REF) + 0.4 * norm(a.ratingsPerDay, VELOCITY_REF);

/**
 * Blended demand (ratings/day) across `apps` — the title-matched incumbents the
 * caller passes (the apps actually serving this search phrase), so demand is
 * measured at the apps a new entrant would compete with, not the whole top-N.
 *
 * Two additive components, both in ratings/day:
 *  - baseline: mean LIFETIME ratings/day (reviews / age) — a floor reflecting
 *    the market pull an established field already has. Never 0 for a real app
 *    with reviews; this is what discriminates demand across the corpus.
 *  - velocity: mean RECENT ratings/day since the prior scan (`recentVelocity`) —
 *    a momentum bonus. Apps with no measured velocity contribute 0 here (they do
 *    NOT drag demand toward 0), so a field that merely gained no reviews this
 *    window keeps its lifetime-derived demand instead of collapsing.
 *
 * demand = baseline + VELOCITY_WEIGHT * velocity.
 */
export function computeDemand(apps: readonly TopApp[]): number {
  if (apps.length === 0) return 0;
  const baseline = apps.reduce((s, a) => s + a.ratingsPerDay, 0) / apps.length;
  const velocity = apps.reduce((s, a) => s + (a.recentVelocity ?? 0), 0) / apps.length;
  return baseline + VELOCITY_WEIGHT * velocity;
}


/**
 * Bounds a single outlier app's lifetime review mass from dominating the
 * demand mean: any app's `ratingsPerDay` above `apps`' own p90 is clamped
 * down to that p90 before averaging (2026-07-21 audit item C fix — the
 * unfiltered mean a single mega-app's raw lifetime rate could dominate).
 * Explicitly NOT a switch to the median — validated against the backtest
 * that a median swap flattens the signal enough to kill the "block shorts"
 * winner-keyword result. Pure; does not mutate `apps`.
 */
export function winsorizeRatingsPerDayAtP90(apps: readonly TopApp[]): readonly TopApp[] {
  if (apps.length <= 1) return apps;
  const sorted = apps.map((a) => a.ratingsPerDay).sort((a, b) => a - b);
  const p90Index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.9 * sorted.length) - 1));
  const p90 = sorted[p90Index] as number;
  return apps.map((a) => (a.ratingsPerDay > p90 ? { ...a, ratingsPerDay: p90 } : a));
}

export function computeCompetitiveness(apps: readonly TopApp[]): number {
  if (apps.length === 0) return 0;
  const mean = apps.reduce((s, a) => s + appStrength(a), 0) / apps.length;
  return Math.round(mean * 1000) / 10; // 0..100, one decimal
}

/** The strongest (most entrenched) incumbent — the app you'd actually have to beat. */
function leader(apps: readonly TopApp[]): TopApp | undefined {
  if (apps.length === 0) return undefined;
  return apps.reduce((best, a) => (appStrength(a) > appStrength(best) ? a : best));
}

/** 0 (fresh, ≤30d) → 1 (stale, ≥365d). Unknown update date reads as fresh (0). */
function updateStaleness(lastUpdatedDays: number | undefined): number {
  if (lastUpdatedDays === undefined) return 0;
  return clamp01((lastUpdatedDays - FRESH_UPDATE_DAYS) / (STALE_UPDATE_DAYS - FRESH_UPDATE_DAYS));
}

/**
 * How beatable the field's LEADER is — genuine incumbent quality/staleness,
 * with no competitiveness term (competitiveness enters opportunity exactly once,
 * directly). Blends a weak leader rating (primary) with a stale last-update
 * (secondary). An empty field is maximally beatable (1).
 */
export function computeIncumbentWeakness(apps: readonly TopApp[]): number {
  const top = leader(apps);
  if (!top) return 1;
  const ratingWeakness = clamp01((4.5 - top.rating) / 2); // 4.5+→0, 2.5→1
  const staleness = updateStaleness(top.lastUpdatedDays);
  return clamp01(0.6 * ratingWeakness + 0.4 * staleness);
}

const TREND_MULT: Record<GapTrend, number> = {
  heating: 1.15,
  stable: 1.0,
  new: 1.0,
  cooling: 0.85,
};

/**
 * History-based momentum over a demand (or opportunity) time-series, oldest →
 * newest. Uses a least-squares slope normalized by the series mean so it
 * measures the total fractional change across the observed span — replacing the
 * old single-point ratio over the slow lifetime average, which almost never
 * left `stable`/`new`. Fewer than two points (or a non-positive mean) → `new`.
 */
export function classifyTrend(series: readonly number[]): GapTrend {
  const points = series.filter((v) => Number.isFinite(v));
  const n = points.length;
  if (n < 2) return "new";

  const meanY = points.reduce((s, v) => s + v, 0) / n;
  if (meanY <= 0) return "new";
  const meanX = (n - 1) / 2;

  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - meanX;
    num += dx * ((points[i] as number) - meanY);
    den += dx * dx;
  }
  if (den === 0) return "stable";

  const slope = num / den;
  const relChange = (slope * (n - 1)) / meanY; // total fractional change across span
  if (relChange > 0.15) return "heating";
  if (relChange < -0.15) return "cooling";
  return "stable";
}

/**
 * Whitespace / opportunity in 0..1 = real demand × genuine beatability × trend.
 *
 * Competitiveness is NOT double-counted: it enters ONLY through `beatability`
 * (as the field-crowding term), blended with the independent leader-weakness
 * signal. The old model multiplied by `(1 - competitiveness/100)` AND by
 * `(0.5 + 0.5 * incumbentWeakness)` where weakness itself embedded
 * `(1 - competitiveness/100)`, so competitiveness entered ~squared and
 * dominated demand.
 */
export function computeOpportunity(a: {
  readonly demand: number;
  readonly competitiveness: number;
  readonly incumbentWeakness: number;
  readonly trend: GapTrend;
}): number {
  const demandNorm = norm(a.demand, DEMAND_REF);
  const beatability = clamp01(0.5 * (1 - a.competitiveness / 100) + 0.5 * a.incumbentWeakness);
  return clamp01(demandNorm * beatability * TREND_MULT[a.trend]);
}

// The "beatable solo" review ceiling for `computeBuildability`'s reviewOpening
// term — a top incumbent with roughly this many reviews or more reads as
// fully entrenched (opening -> 0); far fewer reviews reads as wide open.
// User-chosen (see docs/superpowers/specs/2026-07-14-buildability-score-design.md).
export const BUILDABILITY_REVIEW_REF = 5000;

// Reference demand for `computeBuildability`'s demandFactor gate. Distinct
// from `DEMAND_REF` (used by `computeOpportunity`'s ratings/day-based demand
// blend): this normalizes the per-keyword `demand` scan field specifically
// for the buildability score. Not exported — an internal tuning knob scoped
// to this one formula.
const BUILDABILITY_DEMAND_REF = 50;

/**
 * Solo-indie "can I win this?" score in 0..100 — read-time, deterministic
 * function of already-stored per-keyword scan fields (no trend, no I/O).
 * Distinct from `opportunity`: HARD-GATES on real demand (no search interest
 * => 0, multiplicatively via `demandFactor`) and centers specifically on
 * out-competing the TOP incumbent (its review count + rating), rather than
 * the whole field's mean competitiveness.
 *
 * `norm(x, ref) = clamp01(ln(1+x)/ln(1+ref))`
 * `demandFactor = norm(demand, 50)`
 * `reviewOpening = clamp01(1 - norm(topAppReviews, 5000))`
 * `ratingOpening = clamp01((4.5 - avgRating) / 1.5)`
 * `opening = 0.65*reviewOpening + 0.35*ratingOpening`
 * `buildability = round(100 * demandFactor * opening)`
 *
 * See docs/superpowers/specs/2026-07-14-buildability-score-design.md for the
 * full design. The mirrored SQL expression in `keyword-store.ts`'s
 * `BUILDABILITY_SQL` MUST stay in exact agreement with this function — an
 * integration test drift-guards the two against each other.
 */
export function computeBuildability(a: {
  readonly demand: number;
  readonly topAppReviews: number;
  readonly avgRating: number;
}): number {
  const demandFactor = norm(a.demand, BUILDABILITY_DEMAND_REF);
  const reviewOpening = clamp01(1 - norm(a.topAppReviews, BUILDABILITY_REVIEW_REF));
  const ratingOpening = clamp01((4.5 - a.avgRating) / 1.5);
  const opening = 0.65 * reviewOpening + 0.35 * ratingOpening;
  return Math.round(100 * demandFactor * opening);
}
