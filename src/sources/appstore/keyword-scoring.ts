// Deterministic scoring core for the App Store keyword-gap scanner. Pure
// functions only — no I/O, no Date, no Math.random. Consumes TopApp/GapTrend
// from `keyword-types.ts` and produces the four KeywordGapProfile scores:
// demand, competitiveness, incumbent-weakness, and opportunity (whitespace).

import type { GapTrend, TopApp } from "./keyword-types";

export const REVIEWS_REF = 500_000;
export const VELOCITY_REF = 400;
export const DEMAND_REF = 0.5;

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
const norm = (x: number, ref: number): number => clamp01(Math.log1p(x) / Math.log1p(ref));

// per-app strength blends review mass and live velocity
const appStrength = (a: TopApp): number =>
  0.6 * norm(a.reviews, REVIEWS_REF) + 0.4 * norm(a.ratingsPerDay, VELOCITY_REF);

export function computeDemand(apps: readonly TopApp[]): number {
  if (apps.length === 0) return 0;
  return apps.reduce((s, a) => s + a.ratingsPerDay, 0) / apps.length;
}

export function computeCompetitiveness(apps: readonly TopApp[]): number {
  if (apps.length === 0) return 0;
  const mean = apps.reduce((s, a) => s + appStrength(a), 0) / apps.length;
  return Math.round(mean * 1000) / 10; // 0..100, one decimal
}

export function computeIncumbentWeakness(apps: readonly TopApp[], competitiveness: number): number {
  if (apps.length === 0) return 1;
  const meanRating = apps.reduce((s, a) => s + a.rating, 0) / apps.length;
  const ratingWeakness = clamp01((4.5 - meanRating) / 2); // 4.5+→0, 2.5→1
  return clamp01(0.6 * (1 - competitiveness / 100) + 0.4 * ratingWeakness);
}

const TREND_MULT: Record<GapTrend, number> = {
  heating: 1.15,
  stable: 1.0,
  new: 1.0,
  cooling: 0.85,
};

export function computeOpportunity(a: {
  readonly demand: number;
  readonly competitiveness: number;
  readonly incumbentWeakness: number;
  readonly trend: GapTrend;
}): number {
  const demandNorm = norm(a.demand, DEMAND_REF);
  return clamp01(
    demandNorm *
      (1 - a.competitiveness / 100) *
      (0.5 + 0.5 * a.incumbentWeakness) *
      TREND_MULT[a.trend],
  );
}
