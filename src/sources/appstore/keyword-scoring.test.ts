import { describe, expect, it } from "bun:test";
import {
  classifyTrend,
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

describe("computeDemand (velocity)", () => {
  it("uses recentVelocity when present, else the lifetime ratingsPerDay", () => {
    expect(computeDemand([app({ ratingsPerDay: 5, recentVelocity: 100 })])).toBe(100);
    expect(computeDemand([app({ ratingsPerDay: 5 })])).toBe(5);
  });

  it("means velocity across the field", () => {
    expect(
      computeDemand([app({ recentVelocity: 10 }), app({ recentVelocity: 30 })]),
    ).toBeCloseTo(20, 6);
  });
});

describe("computeOpportunity — demand no longer saturates", () => {
  // Both 60 and 300 ratings/day cleared log1p(50) under the old DEMAND_REF=50
  // and clamped to an identical normalized demand of 1.0. With DEMAND_REF=1000
  // they map to distinct points on the log curve, so opportunity separates.
  const base = { competitiveness: 30, incumbentWeakness: 0.5, trend: "stable" as const };
  it("separates two previously-saturating demand levels", () => {
    const mid = computeOpportunity({ ...base, demand: 60 });
    const high = computeOpportunity({ ...base, demand: 300 });
    expect(high).toBeGreaterThan(mid);
  });
  it("is monotonic in demand", () => {
    const low = computeOpportunity({ ...base, demand: 5 });
    const mid = computeOpportunity({ ...base, demand: 60 });
    expect(mid).toBeGreaterThan(low);
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
