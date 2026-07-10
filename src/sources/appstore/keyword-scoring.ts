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

// Reference demand for opportunity normalization, in ratings/day.
//
// `demand` is now a review-VELOCITY mean (recent ratings/day across the
// title-matched incumbents), not a lifetime average. The old DEMAND_REF=50
// saturated: with `norm(x) = log1p(x)/log1p(ref)`, log1p(50)=3.93, so a field
// with mean velocity ≥ ~50/day mapped to ≈1.0 and demand stopped
// discriminating — opportunity was driven by competitiveness alone.
//
// Real matched-incumbent velocities span a wide range: an open/toy field sits
// at fractions of a rating/day, a moderately-warm keyword at 5–50/day, and a
// genuinely hot keyword's leaders collectively add hundreds/day. Anchoring the
// reference at 1000 ratings/day (a near-maximal-demand keyword) keeps the whole
// realistic 0…few-hundred range on the responsive part of the log curve
// (norm(2)≈0.16, norm(13)≈0.38, norm(40)≈0.54, norm(180)≈0.75) instead of
// pinning everything to 1.0 — demand discriminates again.
export const DEMAND_REF = 1_000;

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

// Live demand signal for one app: the recent cross-scan velocity when it was
// computable, else the lifetime ratings/day fallback.
const appVelocity = (a: TopApp): number => a.recentVelocity ?? a.ratingsPerDay;

/**
 * Mean recent review velocity (ratings/day) across `apps`. Callers pass the
 * title-matched incumbents (the apps actually serving this search phrase), so
 * this measures demand expressed at the apps a new entrant would compete with —
 * not the whole unfiltered top-N.
 */
export function computeDemand(apps: readonly TopApp[]): number {
  if (apps.length === 0) return 0;
  return apps.reduce((s, a) => s + appVelocity(a), 0) / apps.length;
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
