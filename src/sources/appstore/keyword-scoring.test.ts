import { describe, expect, it } from "bun:test";
import { appstoreKeywordGapConfigSchema } from "../../config/schema";
import {
  BUILDABILITY_REVIEW_REF,
  classifyTrend,
  computeBeatability,
  computeBuildability,
  computeCompetitiveness,
  computeDemand,
  computeIncumbentWeakness,
  computeLeaderScaleOpening,
  computeOpportunity,
  computeSearcherDemandAxis,
  computeVelocityCap,
  DEFAULT_SCORING_WEIGHTS,
  VELOCITY_CAP_P90_MULTIPLIER,
  winsorizeRatingsPerDayAtP90,
} from "./keyword-scoring";
import type { HintEvidence, TopApp } from "./keyword-types";

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
  // Any demand at or above `demandRef` clamps to a normalized 1.0 and stops
  // discriminating, so the reference has to sit above the realistic range. At
  // `demandRef` = 400 the whole corpus (p50≈6, p90≈48, top ≈320) stays on the
  // responsive part of the log curve, so opportunity separates and rises with
  // demand instead of pinning to a single value.
  const base = { competitiveness: 30, incumbentWeakness: 0.5, trend: "stable" as const };
  it("is monotonic across a realistic demand range", () => {
    const low = computeOpportunity({ ...base, demand: 5 });
    const mid = computeOpportunity({ ...base, demand: 20 });
    const high = computeOpportunity({ ...base, demand: 50 });
    expect(mid).toBeGreaterThan(low);
    expect(high).toBeGreaterThan(mid);
  });
});

describe("computeOpportunity — competitiveness enters exactly once, with a negative sign", () => {
  // Competitiveness reaches opportunity through ONE path: the crowding discount
  // inside beatability (which is then raised to `beatabilityExponent`). A
  // strictly-decreasing sequence pins the sign — the old model's defect was a
  // NET-POSITIVE competitiveness effect, not its curvature.
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
    // A stale, low-rated leader reads weaker than the fresh, well-rated one...
    expect(computeIncumbentWeakness(weakLeaderField)).toBeGreaterThan(
      computeIncumbentWeakness(strongLeaderField),
    );
    // ...but review mass is FIRST-CLASS: a 500k-review incumbent can never be
    // "wide open" no matter how badly rated or stale it is. Rating/staleness
    // are secondary modifiers bounded by `weaknessSecondaryLift`.
    expect(computeIncumbentWeakness(weakLeaderField)).toBeLessThanOrEqual(
      DEFAULT_SCORING_WEIGHTS.weaknessSecondaryLift,
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

describe("winsorizeRatingsPerDayAtP90", () => {
  it("clamps a single outlier down to the set's own p90 without mutating the input", () => {
    const apps = [
      app({ id: "outlier", ratingsPerDay: 500 }),
      ...Array.from({ length: 9 }, (_, i) => app({ id: `q${i}`, ratingsPerDay: 1 })),
    ];
    const out = winsorizeRatingsPerDayAtP90(apps);
    expect(out.map((a) => a.ratingsPerDay)).toEqual(Array.from({ length: 10 }, () => 1));
    expect(apps[0]?.ratingsPerDay).toBe(500); // input untouched
  });

  it("returns sets of 0 or 1 apps unchanged (no percentile to clamp against)", () => {
    expect(winsorizeRatingsPerDayAtP90([])).toEqual([]);
    const one = [app({ ratingsPerDay: 999 })];
    expect(winsorizeRatingsPerDayAtP90(one)).toBe(one);
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

// Batch D item D4 (2026-07-22, ADJUSTED fix): set-level, ratingsPerDay-p90-
// derived velocity cap — replaces the old per-app `10 * a.ratingsPerDay` cap
// in `keyword-gaps.ts`'s `enrichWithVelocity`.
describe("computeVelocityCap — set-level ratingsPerDay-p90-derived bound", () => {
  it("floors at floorPerDay when the set's p90 lifetime rate is low", () => {
    const apps = [app({ ratingsPerDay: 0.5 }), app({ ratingsPerDay: 1 })];
    expect(computeVelocityCap(apps, 50)).toBe(50);
  });

  it("scales with the set's p90 lifetime rate once k*p90 exceeds the floor", () => {
    // 20 apps at ratingsPerDay=100 -> p90=100 -> k*100 = 300 (k=3) >> floor.
    const apps = Array.from({ length: 20 }, () => app({ ratingsPerDay: 100 }));
    expect(computeVelocityCap(apps, 50)).toBeCloseTo(VELOCITY_CAP_P90_MULTIPLIER * 100, 6);
  });

  it("does NOT let a single high-lifetime-rate app scale the cap by its own 10x rate (the bug this replaces)", () => {
    // One entrenched, high-rate incumbent among a realistically-sized field
    // of otherwise-quiet apps: the OLD per-app formula would have capped
    // THIS app's own velocity at 10 * 500 = 5000/day. The set-level p90
    // (dominated by the 19 quiet apps, so it reads ~1, not 500) keeps the
    // SHARED cap far below that instead.
    const apps = [
      app({ ratingsPerDay: 500 }),
      ...Array.from({ length: 19 }, () => app({ ratingsPerDay: 1 })),
    ];
    const cap = computeVelocityCap(apps, 50);
    expect(cap).toBeLessThan(500);
    expect(cap).toBe(50); // p90 of the 20-app set reads ~1 -> k*1=3 -> floor (50) dominates
  });

  it("degenerates to the single app's own rate (times k) for a one-app set", () => {
    const apps = [app({ ratingsPerDay: 40 })];
    expect(computeVelocityCap(apps, 10)).toBeCloseTo(VELOCITY_CAP_P90_MULTIPLIER * 40, 6);
  });

  it("returns the floor for an empty set", () => {
    expect(computeVelocityCap([], 50)).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// 2026-07-26 sign fix — the four named behaviours of the corrected model.
// ---------------------------------------------------------------------------

function evidence(overrides: Partial<HintEvidence> = {}): HintEvidence {
  return {
    bestRank: null,
    seedCount: 0,
    storefrontCount: 0,
    lastSeenAt: null,
    covered: false,
    ...overrides,
  };
}

/** Field whose leader carries `reviews`, otherwise a fresh, well-rated app (so rating/staleness contribute nothing). */
const leaderWith = (reviews: number, extra: Partial<TopApp> = {}): readonly TopApp[] => [
  app({ id: "L", reviews, rating: 4.7, ratingsPerDay: 2, lastUpdatedDays: 5, ...extra }),
];

describe("computeIncumbentWeakness — incumbent review mass is a first-class term (defect A)", () => {
  it("scores a tiny-incumbent field near-maximally weak even when the leader is 4.9-rated and freshly updated", () => {
    // The measured defect: `block shorts` incumbents at 2,973/128/26/14/1
    // reviews scored weakness EXACTLY 0.000 because the leader was well-rated
    // and recently shipped. A 26-review leader must read as wide open.
    expect(computeIncumbentWeakness(leaderWith(26, { rating: 4.9 }))).toBeGreaterThan(0.95);
    expect(computeIncumbentWeakness(leaderWith(1, { rating: 5 }))).toBeGreaterThan(0.95);
    expect(computeIncumbentWeakness(leaderWith(128))).toBeGreaterThan(0.95);
  });

  it("scores a mega-incumbent field near-zero weakness even when it is stale and mediocre", () => {
    // `real claw machine`: Clawee, 737,897 reviews, 622 days stale — the OLD
    // model handed it weakness 0.40 purely on staleness, which is what made it
    // the corpus's #1 "opportunity".
    const weakness = computeIncumbentWeakness(
      leaderWith(737_897, { rating: 4.3, lastUpdatedDays: 622 }),
    );
    expect(weakness).toBeLessThan(0.4);
    expect(weakness).toBeLessThan(computeIncumbentWeakness(leaderWith(26)));
  });

  it("reproduces the real measured cases the old model scored 0.000", () => {
    // block shorts leader = 2,973 reviews; peptide tracker leader = 2,959.
    expect(computeIncumbentWeakness(leaderWith(2_973))).toBeGreaterThan(0.5);
    expect(computeIncumbentWeakness(leaderWith(2_959))).toBeGreaterThan(0.5);
  });

  it("is strictly decreasing in leader review mass across the whole realistic range", () => {
    const masses = [0, 1, 26, 128, 500, 2_973, 27_919, 57_650, 164_606, 737_897, 2_048_909];
    const weaknesses = masses.map((m) => computeIncumbentWeakness(leaderWith(m)));
    for (let i = 1; i < weaknesses.length; i++) {
      expect(weaknesses[i] as number).toBeLessThanOrEqual(weaknesses[i - 1] as number);
    }
    // ...and the span is real, not a rounding artifact.
    expect((weaknesses[0] as number) - (weaknesses[weaknesses.length - 1] as number)).toBeGreaterThan(
      0.9,
    );
  });

  it("keeps rating and staleness as SECONDARY modifiers that only ever raise weakness", () => {
    const base = computeIncumbentWeakness(leaderWith(50_000, { rating: 4.7, lastUpdatedDays: 5 }));
    const badlyRated = computeIncumbentWeakness(
      leaderWith(50_000, { rating: 2.4, lastUpdatedDays: 5 }),
    );
    const stale = computeIncumbentWeakness(
      leaderWith(50_000, { rating: 4.7, lastUpdatedDays: 900 }),
    );
    expect(badlyRated).toBeGreaterThan(base);
    expect(stale).toBeGreaterThan(base);
    // But bounded: they can never turn an entrenched leader into an open field.
    expect(badlyRated).toBeLessThan(computeIncumbentWeakness(leaderWith(26)));
    expect(stale).toBeLessThan(computeIncumbentWeakness(leaderWith(26)));
  });

  it("anchors the scale opening at the configured beatable/entrenched review bounds", () => {
    const w = DEFAULT_SCORING_WEIGHTS;
    expect(computeLeaderScaleOpening(w.weaknessBeatableReviews, w)).toBeCloseTo(1, 6);
    expect(computeLeaderScaleOpening(w.weaknessEntrenchedReviews, w)).toBeCloseTo(0, 6);
    expect(computeLeaderScaleOpening(0, w)).toBe(1);
    expect(computeLeaderScaleOpening(10_000_000, w)).toBe(0);
  });

  it("still treats an empty field as maximally beatable", () => {
    expect(computeIncumbentWeakness([])).toBe(1);
  });
});

describe("computeBeatability — the weakness-driven ceiling is gone (defect B)", () => {
  it("no longer caps a small-incumbent field at the old 0.5 beatability bound", () => {
    // OLD: `0.5*(1 - comp/100) + 0.5*weakness`. Because the broken weakness
    // function scored 32% of all scans at EXACTLY 0.000 — including every
    // small-incumbent niche — beatability for those fields could not exceed
    // 0.5, and opportunity could not exceed the measured 0.5158. With review
    // mass now driving weakness, a 26-review-leader field is no longer pinned
    // to that branch at all.
    const openField = leaderWith(26, { rating: 4.9, lastUpdatedDays: 5 });
    const weakness = computeIncumbentWeakness(openField);
    expect(weakness).toBeGreaterThan(0.95);
    // Uncrowded: beatability is now bounded only by crowding, not by weakness.
    expect(computeBeatability(5, weakness)).toBeGreaterThan(0.85);
  });

  it("is 0 when the leader is unbeatable, regardless of how uncrowded the field is", () => {
    expect(computeBeatability(0, 0)).toBe(0);
  });

  it("decreases strictly as field crowding rises at fixed leader weakness", () => {
    const open = computeBeatability(10, 0.8);
    const mid = computeBeatability(50, 0.8);
    const crowded = computeBeatability(95, 0.8);
    expect(open).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(crowded);
  });

  it("lets a maximally open, high-demand field reach the top of the 0..1 range", () => {
    // The structural point: nothing in the composition prevents a genuinely
    // open field from scoring near 1. (What the corpus actually reaches is a
    // separate, empirical question — see the backtest; thresholds are NOT
    // recalibrated by this change.)
    const opp = computeOpportunity({
      demand: 400,
      competitiveness: 5,
      incumbentWeakness: 1,
      trend: "heating",
    });
    expect(opp).toBeGreaterThan(0.9);
  });
});

describe("computeOpportunity — crowding can never net-raise the score (defect C)", () => {
  it("ranks an open field above a crowded one at EQUAL demand and equal leader weakness", () => {
    const open = computeOpportunity({
      demand: 30,
      competitiveness: 15,
      incumbentWeakness: 0.7,
      trend: "stable",
    });
    const crowded = computeOpportunity({
      demand: 30,
      competitiveness: 85,
      incumbentWeakness: 0.7,
      trend: "stable",
    });
    expect(open).toBeGreaterThan(crowded);
  });

  it("ranks an open field above a crowded one END-TO-END from real SERP shapes at equal demand", () => {
    // Same measured demand, but one field is served by a 26-review toy and the
    // other by a 737k-review giant. The OLD model scored the giant's field
    // HIGHER (weakness 0.40 from staleness vs 0.00 for the fresh toy).
    const openField = leaderWith(26, { rating: 4.9, lastUpdatedDays: 5 });
    const giantField = leaderWith(737_897, { rating: 4.3, lastUpdatedDays: 622 });
    const openOpp = computeOpportunity({
      demand: 30,
      competitiveness: computeCompetitiveness(openField),
      incumbentWeakness: computeIncumbentWeakness(openField),
      trend: "stable",
    });
    const giantOpp = computeOpportunity({
      demand: 30,
      competitiveness: computeCompetitiveness(giantField),
      incumbentWeakness: computeIncumbentWeakness(giantField),
      trend: "stable",
    });
    expect(openOpp).toBeGreaterThan(giantOpp);
    expect(openOpp / Math.max(giantOpp, 1e-9)).toBeGreaterThan(3);
  });

  it("is monotone non-increasing in incumbent review mass at fixed demand and trend", () => {
    const masses = [26, 2_973, 27_919, 164_606, 737_897];
    const opps = masses.map((m) => {
      const field = leaderWith(m);
      return computeOpportunity({
        demand: 20,
        competitiveness: computeCompetitiveness(field),
        incumbentWeakness: computeIncumbentWeakness(field),
        trend: "stable",
      });
    });
    for (let i = 1; i < opps.length; i++) {
      expect(opps[i] as number).toBeLessThanOrEqual(opps[i - 1] as number);
    }
  });
});

describe("computeSearcherDemandAxis — autocomplete rank is a real demand axis (not a ±30% multiplier)", () => {
  // Corpus evidence: median demand by best hint rank is 0.936 (rank 0-2),
  // 0.186 (3-5), 0.128 (6+) ratings/day — a 7.3x spread. norm(0.936, 80) is
  // only ≈0.15, so the rank axis has to be able to MOVE the estimate, not
  // nudge it.
  const lowProxyDemand = 0.936;

  it("lifts a rank-0 term with a near-zero incumbent-mass proxy by multiples, not percent", () => {
    const neutral = computeSearcherDemandAxis(lowProxyDemand, undefined);
    const ranked = computeSearcherDemandAxis(
      lowProxyDemand,
      evidence({ bestRank: 0, seedCount: 4, storefrontCount: 2, covered: true }),
    );
    expect(neutral).toBeLessThan(0.2); // the mass proxy alone reads this as dead
    expect(ranked / neutral).toBeGreaterThan(2.5);
  });

  it("decays monotonically with rank", () => {
    const axis = (rank: number) =>
      computeSearcherDemandAxis(
        lowProxyDemand,
        evidence({ bestRank: rank, seedCount: 2, covered: true }),
      );
    const ranks = [0, 1, 2, 3, 5, 7, 9];
    const values = ranks.map(axis);
    for (let i = 1; i < values.length; i++) {
      expect(values[i] as number).toBeLessThanOrEqual(values[i - 1] as number);
    }
    // Spread across the measured buckets is real (rank 0-2 vs rank 6+).
    expect((values[0] as number) / (values[values.length - 1] as number)).toBeGreaterThan(1.8);
  });

  it("NEVER lowers the estimate below the neutral proxy on any presence, even a rank-9 sighting", () => {
    // A term Apple does suggest — however late — is weak POSITIVE evidence; it
    // must not be punished below a term that was never probed at all.
    const neutral = computeSearcherDemandAxis(50, undefined);
    for (const rank of [0, 3, 6, 9, 20]) {
      expect(
        computeSearcherDemandAxis(50, evidence({ bestRank: rank, seedCount: 1, covered: true })),
      ).toBeGreaterThanOrEqual(neutral);
    }
  });

  it("is exactly neutral when hint evidence is absent — never probed must not be punished (12.8% coverage)", () => {
    // `peptide tracker`, `card grading` and `block shorts` all currently have
    // NO hints; the axis must be a no-op for them.
    const neutral = computeSearcherDemandAxis(12.451, undefined);
    expect(computeSearcherDemandAxis(12.451, evidence({ covered: false, seedCount: 0 }))).toBe(
      neutral,
    );
    // ...and their score must be identical to passing no evidence at all.
    const withoutHint = computeOpportunity({
      demand: 12.451,
      competitiveness: 30.5,
      incumbentWeakness: 0.61,
      trend: "heating",
    });
    const withNeverProbed = computeOpportunity({
      demand: 12.451,
      competitiveness: 30.5,
      incumbentWeakness: 0.61,
      trend: "heating",
      hint: evidence({ covered: false, seedCount: 0 }),
    });
    expect(withNeverProbed).toBe(withoutHint);
  });

  it("penalises a CONFIRMED absence (probed, Apple suggests nothing) — the tri-state's third branch", () => {
    const neutral = computeSearcherDemandAxis(12.451, undefined);
    const probedAbsent = computeSearcherDemandAxis(
      12.451,
      evidence({ covered: true, seedCount: 0 }),
    );
    expect(probedAbsent).toBeLessThan(neutral);
    expect(probedAbsent).toBeCloseTo(neutral * DEFAULT_SCORING_WEIGHTS.hintAbsencePenalty, 6);
  });

  it("treats presence with a null bestRank as presence, not absence", () => {
    const neutral = computeSearcherDemandAxis(1, undefined);
    expect(
      computeSearcherDemandAxis(1, evidence({ covered: true, seedCount: 3, bestRank: null })),
    ).toBeGreaterThanOrEqual(neutral);
  });

  it("stays inside 0..1 for extreme inputs", () => {
    for (const demand of [0, 1e-9, 1e9]) {
      for (const hint of [undefined, evidence({ bestRank: 0, seedCount: 9, covered: true })]) {
        const v = computeSearcherDemandAxis(demand, hint);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("scoring weights are config-driven", () => {
  it("honours caller-supplied weights instead of hardcoding them", () => {
    const field = leaderWith(50_000);
    const strict = computeIncumbentWeakness(field, {
      ...DEFAULT_SCORING_WEIGHTS,
      weaknessEntrenchedReviews: 5_000,
    });
    const lenient = computeIncumbentWeakness(field, {
      ...DEFAULT_SCORING_WEIGHTS,
      weaknessEntrenchedReviews: 5_000_000,
    });
    expect(strict).toBeLessThan(lenient);

    const noCrowdPenalty = computeBeatability(90, 0.5, {
      ...DEFAULT_SCORING_WEIGHTS,
      crowdingWeight: 0,
      beatabilityExponent: 1,
    });
    expect(noCrowdPenalty).toBeCloseTo(0.5, 6);

    // The exponent is the sign-fixing knob: it must actually bite.
    const linear = computeBeatability(30, 0.8, {
      ...DEFAULT_SCORING_WEIGHTS,
      beatabilityExponent: 1,
    });
    const squared = computeBeatability(30, 0.8, {
      ...DEFAULT_SCORING_WEIGHTS,
      beatabilityExponent: 2,
    });
    expect(squared).toBeCloseTo(linear ** 2, 6);
    expect(squared).toBeLessThan(linear);

    const noRankAxis = computeSearcherDemandAxis(
      1,
      evidence({ bestRank: 0, seedCount: 3, covered: true }),
      { ...DEFAULT_SCORING_WEIGHTS, rankAxisWeight: 0 },
    );
    expect(noRankAxis).toBeCloseTo(computeSearcherDemandAxis(1, undefined), 6);
  });

  it("degrades to a hard step when the beatable/entrenched bounds are inverted or equal", () => {
    const degenerate = {
      ...DEFAULT_SCORING_WEIGHTS,
      weaknessBeatableReviews: 1_000,
      weaknessEntrenchedReviews: 1_000,
    };
    expect(computeLeaderScaleOpening(1_000, degenerate)).toBe(1);
    expect(computeLeaderScaleOpening(1_001, degenerate)).toBe(0);
  });

  it("keeps the config schema's defaults in exact agreement with DEFAULT_SCORING_WEIGHTS", () => {
    // Drift guard: `src/config/schema.ts` restates these numbers literally (so
    // the config module never imports a scanner module); this test is what
    // keeps the two copies honest.
    const parsed = appstoreKeywordGapConfigSchema.parse({});
    expect(parsed.scoring).toEqual(DEFAULT_SCORING_WEIGHTS);
  });
});
