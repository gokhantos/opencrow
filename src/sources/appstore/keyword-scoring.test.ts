import { describe, expect, it } from "bun:test";
import {
  BUILDABILITY_REVIEW_REF,
  classifyTrend,
  computeBuildability,
  computeCompetitiveness,
  computeDemand,
  computeIncumbentWeakness,
  computeOpportunity,
} from "./keyword-scoring";
import type { TopApp } from "./keyword-types";

const app = (o: Partial<TopApp> = {}): TopApp => ({
  id: "x",
  name: "x",
  reviews: 8,
  rating: 3.4,
  ageDays: 1000,
  ratingsPerDay: 13,
  titleMatch: true,
  ...o,
});

// saturated field (receipt-scanner-like): many strong, fresh, well-rated apps
const saturated = Array.from({ length: 20 }, () =>
  app({ reviews: 400_000, rating: 4.6, ratingsPerDay: 180, lastUpdatedDays: 10 }),
);
// open field (fatty-liver-like): all low-rated, stale toys
const open = Array.from({ length: 20 }, () =>
  app({ reviews: 8, rating: 3.4, ratingsPerDay: 13, lastUpdatedDays: 800 }),
);

describe("keyword-scoring", () => {
  it("scores a saturated field high (>=70) and an open field low (<=30)", () => {
    expect(computeCompetitiveness(saturated)).toBeGreaterThanOrEqual(70);
    expect(computeCompetitiveness(open)).toBeLessThanOrEqual(30);
  });

  it("flags weak incumbents on the open field", () => {
    expect(computeIncumbentWeakness(open)).toBeGreaterThan(0.6);
  });

  it("ranks the open gap's opportunity above the saturated one", () => {
    const oOpp = computeOpportunity({
      demand: computeDemand(open),
      competitiveness: computeCompetitiveness(open),
      incumbentWeakness: computeIncumbentWeakness(open),
      trend: "heating",
    });
    const sOpp = computeOpportunity({
      demand: computeDemand(saturated),
      competitiveness: computeCompetitiveness(saturated),
      incumbentWeakness: computeIncumbentWeakness(saturated),
      trend: "stable",
    });
    expect(oOpp).toBeGreaterThan(sOpp);
  });

  it("handles an empty field without throwing", () => {
    expect(computeCompetitiveness([])).toBe(0);
    expect(computeDemand([])).toBe(0);
    // no incumbents => maximally beatable
    expect(computeIncumbentWeakness([])).toBe(1);
  });
});

describe("computeDemand (lifetime baseline + velocity momentum)", () => {
  it("is the lifetime baseline when no recent velocity is measured — never 0 for a real app", () => {
    // A field of established apps that gained no reviews this window must NOT
    // collapse to 0 (the regression this recalibration fixes); it keeps its
    // lifetime-derived demand.
    expect(computeDemand([app({ ratingsPerDay: 5 })])).toBe(5);
    expect(computeDemand([app({ ratingsPerDay: 20 }), app({ ratingsPerDay: 40 })])).toBeCloseTo(
      30,
      6,
    );
  });

  it("adds a recent-velocity momentum bonus on top of the baseline (VELOCITY_WEIGHT=1)", () => {
    // baseline 5/day + recent 100/day momentum = 105.
    expect(computeDemand([app({ ratingsPerDay: 5, recentVelocity: 100 })])).toBeCloseTo(105, 6);
  });

  it("does not zero out when a measured velocity is 0 — the baseline still carries demand", () => {
    // OLD pure-velocity demand read this as 0 (present-but-zero recentVelocity);
    // now the lifetime baseline floors it.
    expect(computeDemand([app({ ratingsPerDay: 8, recentVelocity: 0 })])).toBe(8);
  });

  it("discriminates two real-shaped keywords with different review mass + velocity", () => {
    // Warm field: mass ~40/day lifetime, some real momentum.
    const warm = [
      app({ reviews: 45_000, ageDays: 1500, ratingsPerDay: 30, recentVelocity: 12 }),
      app({ reviews: 20_000, ageDays: 1200, ratingsPerDay: 16, recentVelocity: 4 }),
    ];
    // Sleepy field: tiny lifetime mass, no momentum.
    const sleepy = [
      app({ reviews: 400, ageDays: 900, ratingsPerDay: 0.4, recentVelocity: 0 }),
      app({ reviews: 120, ageDays: 600, ratingsPerDay: 0.2 }),
    ];
    const warmD = computeDemand(warm);
    const sleepyD = computeDemand(sleepy);
    expect(warmD).toBeGreaterThan(0);
    expect(sleepyD).toBeGreaterThan(0); // real apps, so > 0 (not collapsed)
    expect(warmD).toBeGreaterThan(sleepyD * 20); // and clearly separated
  });
});

describe("computeOpportunity — realistic inputs neither collapse to 0 nor saturate to 1", () => {
  it("spreads: strong-demand-weak-incumbent scores clearly above a dead field", () => {
    // Strong demand (real matched incumbents, ~34/day mass) + weak/stale leader.
    const strong = computeOpportunity({
      demand: computeDemand([
        app({ reviews: 30_000, ageDays: 1200, ratingsPerDay: 25, rating: 3.2, recentVelocity: 9 }),
        app({ reviews: 60_000, ageDays: 1600, ratingsPerDay: 37, rating: 3.4, recentVelocity: 5 }),
      ]),
      competitiveness: 45,
      incumbentWeakness: 0.6,
      trend: "heating",
    });
    // Dead field: near-zero lifetime mass, no momentum, entrenched leader.
    const dead = computeOpportunity({
      demand: computeDemand([app({ reviews: 50, ageDays: 800, ratingsPerDay: 0.06 })]),
      competitiveness: 70,
      incumbentWeakness: 0.1,
      trend: "stable",
    });
    expect(strong).toBeGreaterThan(dead);
    // Neither pathological extreme for these realistic inputs.
    expect(strong).toBeGreaterThan(0.05);
    expect(strong).toBeLessThan(1);
    expect(dead).toBeLessThan(0.05);
  });
});

describe("computeOpportunity — demand is monotonic and non-saturating", () => {
  // Under the old DEMAND_REF=50, any demand ≥ ~50/day clamped to a normalized
  // 1.0 and stopped discriminating. With DEMAND_REF=80 the realistic range stays
  // on the responsive part of the log curve, so opportunity separates and rises
  // with demand instead of pinning to a single value.
  const base = { competitiveness: 30, incumbentWeakness: 0.5, trend: "stable" as const };
  it("is monotonic across a realistic demand range", () => {
    const low = computeOpportunity({ ...base, demand: 5 });
    const mid = computeOpportunity({ ...base, demand: 20 });
    const high = computeOpportunity({ ...base, demand: 50 });
    expect(mid).toBeGreaterThan(low);
    expect(high).toBeGreaterThan(mid);
  });
});

describe("computeOpportunity — competitiveness not double-counted", () => {
  // Competitiveness enters opportunity exactly once (linearly, via beatability).
  // A strictly-decreasing sequence pins that single, non-squared effect: no
  // quadratic collapse as competitiveness rises.
  const b = { demand: 100, incumbentWeakness: 0.5, trend: "stable" as const };
  it("decreases monotonically as competitiveness rises", () => {
    const low = computeOpportunity({ ...b, competitiveness: 20 });
    const mid = computeOpportunity({ ...b, competitiveness: 55 });
    const high = computeOpportunity({ ...b, competitiveness: 90 });
    expect(low).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(high);
  });
});

describe("computeIncumbentWeakness — keyed on the leader", () => {
  const strongLeaderField = [
    app({ id: "L", reviews: 500_000, rating: 4.7, ratingsPerDay: 200, lastUpdatedDays: 5 }),
    app({ id: "toy", reviews: 5, rating: 1.5, ratingsPerDay: 1, lastUpdatedDays: 900 }),
  ];
  const weakLeaderField = [
    app({ id: "L", reviews: 500_000, rating: 2.6, ratingsPerDay: 200, lastUpdatedDays: 600 }),
    app({ id: "toy", reviews: 5, rating: 4.9, ratingsPerDay: 1, lastUpdatedDays: 5 }),
  ];

  it("reads the strongest incumbent, not the field mean", () => {
    // A strong, fresh, high-rated leader => low weakness, even though a weak toy
    // drags the *mean* rating down (a mean-based score would misread this).
    expect(computeIncumbentWeakness(strongLeaderField)).toBeLessThan(0.2);
    // A stale, low-rated leader => high weakness, despite a great toy in the field.
    expect(computeIncumbentWeakness(weakLeaderField)).toBeGreaterThan(0.6);
    expect(computeIncumbentWeakness(weakLeaderField)).toBeGreaterThan(
      computeIncumbentWeakness(strongLeaderField),
    );
  });

  it("counts update staleness of the leader", () => {
    const freshLeader = [app({ id: "L", reviews: 500_000, rating: 3.4, lastUpdatedDays: 5 })];
    const staleLeader = [app({ id: "L", reviews: 500_000, rating: 3.4, lastUpdatedDays: 800 })];
    expect(computeIncumbentWeakness(staleLeader)).toBeGreaterThan(
      computeIncumbentWeakness(freshLeader),
    );
  });
});

describe("classifyTrend — history-based momentum", () => {
  it("returns new with fewer than two points", () => {
    expect(classifyTrend([])).toBe("new");
    expect(classifyTrend([10])).toBe("new");
  });
  it("heating on a rising series", () => {
    expect(classifyTrend([10, 12, 15, 20])).toBe("heating");
  });
  it("cooling on a falling series", () => {
    expect(classifyTrend([20, 15, 12, 8])).toBe("cooling");
  });
  it("stable on a flat series", () => {
    expect(classifyTrend([10, 10.1, 9.9, 10.05])).toBe("stable");
  });
});

describe("computeBuildability — solo-indie 0..100 score", () => {
  it("is 0 when demand is 0, regardless of how weak the incumbent is", () => {
    expect(computeBuildability({ demand: 0, topAppReviews: 100, avgRating: 3.0 })).toBe(0);
    // Even a maximally-beatable incumbent (0 reviews, 0 rating) can't rescue
    // a field with no measured demand — demandFactor is a multiplicative gate.
    expect(computeBuildability({ demand: 0, topAppReviews: 0, avgRating: 0 })).toBe(0);
  });

  it("scores high (>70) for real demand + a weak, low-review, low-rated incumbent", () => {
    const score = computeBuildability({ demand: 200, topAppReviews: 10, avgRating: 2.0 });
    expect(score).toBeGreaterThan(70);
    expect(score).toBe(82);
  });

  it("clamps at 0 when the incumbent is maximally strong (rating above 4.5, reviews far past the ref)", () => {
    // avgRating > 4.5 would make the raw ratingOpening term negative without
    // clamp01, and topAppReviews >> REVIEW_REF drives reviewOpening to 0 —
    // both terms clamp, so opening (and thus buildability) is exactly 0
    // despite very high demand.
    const score = computeBuildability({ demand: 1000, topAppReviews: 1_000_000, avgRating: 5.0 });
    expect(score).toBe(0);
  });

  it("clamps at 100 for maximal demand + a zero-review, zero-rating incumbent", () => {
    const score = computeBuildability({ demand: 1000, topAppReviews: 0, avgRating: 0 });
    expect(score).toBe(100);
  });

  it("rounds to the nearest integer for a realistic mid-range case", () => {
    // demandFactor≈0.610, reviewOpening≈0.270, ratingOpening≈0.667 →
    // opening≈0.409, raw≈24.94 → rounds to 25.
    const score = computeBuildability({ demand: 10, topAppReviews: 500, avgRating: 3.5 });
    expect(score).toBe(25);
  });

  it("is sensitive to BUILDABILITY_REVIEW_REF: a top app right at the ref reads as roughly half-open on the review axis", () => {
    expect(BUILDABILITY_REVIEW_REF).toBe(5000);
    const atRef = computeBuildability({
      demand: 50,
      topAppReviews: BUILDABILITY_REVIEW_REF,
      avgRating: 4.5,
    });
    const farBelowRef = computeBuildability({ demand: 50, topAppReviews: 1, avgRating: 4.5 });
    // At the ref, reviewOpening is 0 (norm saturates to 1); far below it,
    // reviewOpening is close to 1 — so the far-below case scores strictly
    // higher even with an identical (neutral, 4.5) rating.
    expect(farBelowRef).toBeGreaterThan(atRef);
  });

  it("never returns a value outside 0..100 across a spread of inputs", () => {
    const samples = [
      { demand: 0, topAppReviews: 0, avgRating: 0 },
      { demand: 1e9, topAppReviews: 0, avgRating: 0 },
      { demand: 1e9, topAppReviews: 1e9, avgRating: 5 },
      { demand: 25, topAppReviews: 2500, avgRating: 4.0 },
    ];
    for (const s of samples) {
      const score = computeBuildability(s);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(100);
    }
  });
});
