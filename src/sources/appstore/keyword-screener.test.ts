import { describe, expect, it } from "bun:test";
import {
  ACCELERATING_MIN_RECENT_VELOCITY,
  ACCELERATING_MIN_REVIEWS,
  ACCELERATING_VELOCITY_RATIO_MIN,
  ALT_MIN_DEMAND,
  ALT_MIN_ESTABLISHED_RPD,
  ALT_SINGLE_NEWCOMER_MIN_RATINGS_PER_DAY,
  ALT_SINGLE_NEWCOMER_MIN_REVIEWS,
  computeSignature,
  ESTABLISHED_AGE_DAYS_MIN,
  MAX_REVIEWS_CEILING,
  NEWCOMER_AGE_DAYS_MAX,
  SUPPRESSION_LEADER_MIN_RATING,
  SUPPRESSION_LEADER_MIN_REVIEWS,
  type SignatureScanInput,
} from "./keyword-screener";
import type { TopApp } from "./keyword-types";

function app(overrides: Partial<TopApp> = {}): TopApp {
  return {
    id: "1",
    name: "Toy",
    reviews: 300,
    rating: 4.0,
    ageDays: 200,
    ratingsPerDay: 5,
    titleMatch: true,
    ...overrides,
  };
}

/**
 * A textbook window-opening SERP: two fast newcomers (well under
 * `NEWCOMER_AGE_DAYS_MAX`, comfortably above `NEWCOMER_MIN_RATINGS_PER_DAY`)
 * clearly outpacing a single, unremarkable established incumbent, capped
 * below every ceiling. Every gate-rejection test below starts from this and
 * breaks exactly ONE gate, so a failure isolates to that one gate.
 */
function textbookApps(): readonly TopApp[] {
  return [
    app({ id: "newcomer-1", name: "Newcomer One", ageDays: 200, ratingsPerDay: 5, reviews: 300, rating: 4.0 }),
    app({ id: "newcomer-2", name: "Newcomer Two", ageDays: 300, ratingsPerDay: 8, reviews: 500, rating: 4.2 }),
    app({
      id: "established-1",
      name: "Established One",
      ageDays: 600,
      ratingsPerDay: 2,
      reviews: 2000,
      rating: 3.8,
      lastUpdatedDays: 200,
    }),
  ];
}

function textbookInput(overrides: Partial<SignatureScanInput> = {}): SignatureScanInput {
  return {
    keyword: "peptide tracker for beginners",
    competitiveness: 25,
    trend: "heating",
    demand: 10,
    topApps: textbookApps(),
    genreZone: "health",
    ...overrides,
  };
}

describe("computeSignature — textbook hit", () => {
  it("hits on a clean window-opening SERP", () => {
    const result = computeSignature(textbookInput());
    expect(result.hit).toBe(true);
    expect(result.suppressed).toBe(false);
    expect(result.fastNewcomers).toBe(2);
    expect(result.newcomerRpd).toBeCloseTo(6.5, 6);
    expect(result.establishedRpd).toBeCloseTo(2, 6);
    expect(result.velocityRatio).toBeCloseTo(3.25, 6);
    expect(result.maxReviews).toBe(2000);
  });

  it("retro-detects the 'block shorts'-shaped case (comp 10.7, ratio ~4.88)", () => {
    const result = computeSignature(
      textbookInput({
        competitiveness: 10.7,
        topApps: [
          app({ id: "n1", ageDays: 150, ratingsPerDay: 9.76, reviews: 400 }),
          app({ id: "n2", ageDays: 400, ratingsPerDay: 9.76, reviews: 900 }),
          app({ id: "e1", ageDays: 900, ratingsPerDay: 2, reviews: 5000, lastUpdatedDays: 300 }),
        ],
      }),
    );
    expect(result.hit).toBe(true);
    expect(result.velocityRatio).toBeCloseTo(4.88, 1);
  });
});

describe("computeSignature — calibration backtest (2026-07-19 gate widening)", () => {
  it("accepts peptide-tracker-shaped input (backtest: comp 44.5, ratio 2.98, primary path)", () => {
    // 3 fast newcomers at ratingsPerDay 5.96 vs a single established app at
    // 2/day => ratio 5.96/2 = 2.98. comp 44.5 clears the widened
    // COMPETITIVENESS_MAX (50) but would have been rejected under the old 35
    // bound — this test locks the calibration fix, not just the gate math.
    const result = computeSignature(
      textbookInput({
        competitiveness: 44.5,
        trend: "heating",
        topApps: [
          app({ id: "n1", ageDays: 100, ratingsPerDay: 5.96, reviews: 300 }),
          app({ id: "n2", ageDays: 200, ratingsPerDay: 5.96, reviews: 350 }),
          app({ id: "n3", ageDays: 300, ratingsPerDay: 5.96, reviews: 400 }),
          app({ id: "e1", ageDays: 700, ratingsPerDay: 2, reviews: 3000, lastUpdatedDays: 200 }),
        ],
      }),
    );
    expect(result.fastNewcomers).toBe(3);
    expect(result.velocityRatio).toBeCloseTo(2.98, 2);
    expect(result.hit).toBe(true);
  });

  it("accepts card-grading-shaped input (backtest: comp 44, ratio 2.11, primary path)", () => {
    // 2 fast newcomers at ratingsPerDay 8.44 vs a single established app at
    // 4/day => ratio 8.44/4 = 2.11. comp 44 clears the widened bound.
    const result = computeSignature(
      textbookInput({
        competitiveness: 44,
        trend: "heating",
        topApps: [
          app({ id: "n1", ageDays: 150, ratingsPerDay: 8.44, reviews: 500 }),
          app({ id: "n2", ageDays: 350, ratingsPerDay: 8.44, reviews: 600 }),
          app({ id: "e1", ageDays: 800, ratingsPerDay: 4, reviews: 4000, lastUpdatedDays: 250 }),
        ],
      }),
    );
    expect(result.fastNewcomers).toBe(2);
    expect(result.velocityRatio).toBeCloseTo(2.11, 2);
    expect(result.hit).toBe(true);
  });

  it("accepts the 'Yardly garage-sale' single-dominant-newcomer shape via the alt path (comp 46, one newcomer at 13/day + 250 reviews, ratio 1.3, demand 10, non-heating trend)", () => {
    // ONE newcomer (ageDays 200 < 540) at 13 ratings/day and 250 reviews —
    // above ALT_SINGLE_NEWCOMER_MIN_RATINGS_PER_DAY (12) and
    // ALT_SINGLE_NEWCOMER_MIN_REVIEWS (150) — growing against a single
    // ancient, stale incumbent (ageDays 6500+, not recently updated, 10/day
    // velocity, comfortably above ALT_MIN_ESTABLISHED_RPD's 0.2 floor) =>
    // ratio 13/10 = 1.3, clearing ALT_SINGLE_NEWCOMER_VELOCITY_RATIO_MIN
    // (1.2). Demand (10, via textbookInput's default) clears ALT_MIN_DEMAND
    // (5). Trend is deliberately 'stable' (not 'heating') and there is only
    // 1 fast newcomer (not >=2) — both would reject on the primary path
    // alone, proving this hits via the alt path, not a primary-path
    // coincidence.
    expect(ALT_SINGLE_NEWCOMER_MIN_RATINGS_PER_DAY).toBeLessThanOrEqual(13);
    const result = computeSignature(
      textbookInput({
        competitiveness: 46,
        trend: "stable",
        topApps: [
          app({ id: "newcomer", ageDays: 200, ratingsPerDay: 13, reviews: 250 }),
          app({
            id: "ancient-incumbent",
            ageDays: 6500,
            ratingsPerDay: 10,
            reviews: 8000,
            rating: 3.5,
            lastUpdatedDays: 900, // stale — nowhere near the 90-day suppression window
          }),
        ],
      }),
    );
    expect(result.fastNewcomers).toBe(1);
    expect(result.velocityRatio).toBeCloseTo(1.3, 2);
    expect(result.suppressed).toBe(false);
    expect(result.hit).toBe(true);
  });

  it("rejects an alt-path candidate whose lone newcomer has real velocity but thin review volume (< ALT_SINGLE_NEWCOMER_MIN_REVIEWS)", () => {
    // Same shape as the Yardly case but the newcomer is one review short of
    // the floor — young-and-fast, but not yet a real, judged app. This is
    // exactly the "hundreds of thin hits" class the live-corpus run surfaced.
    const result = computeSignature(
      textbookInput({
        competitiveness: 46,
        trend: "stable",
        topApps: [
          app({ id: "newcomer", ageDays: 200, ratingsPerDay: 13, reviews: ALT_SINGLE_NEWCOMER_MIN_REVIEWS - 1 }),
          app({ id: "ancient-incumbent", ageDays: 6500, ratingsPerDay: 10, reviews: 8000, lastUpdatedDays: 900 }),
        ],
      }),
    );
    expect(result.hit).toBe(false);
  });

  it("rejects an alt-path candidate with credible velocity/reviews but sub-floor demand (< ALT_MIN_DEMAND)", () => {
    const result = computeSignature(
      textbookInput({
        competitiveness: 46,
        trend: "stable",
        demand: ALT_MIN_DEMAND - 1,
        topApps: [
          app({ id: "newcomer", ageDays: 200, ratingsPerDay: 13, reviews: 250 }),
          app({ id: "ancient-incumbent", ageDays: 6500, ratingsPerDay: 10, reviews: 8000, lastUpdatedDays: 900 }),
        ],
      }),
    );
    expect(result.hit).toBe(false);
  });

  it("rejects an alt-path candidate whose established baseline is near-zero (< ALT_MIN_ESTABLISHED_RPD), guarding against a div-by-near-zero ratio blowup", () => {
    // establishedRpd 0.05 is below ALT_MIN_ESTABLISHED_RPD (0.2); without
    // that guard, ratio = 13/0.05 = 260, which would trivially clear
    // ALT_SINGLE_NEWCOMER_VELOCITY_RATIO_MIN and hit — this is the
    // astronomical-ratio pattern (seen live up to 77,264x) the guard exists
    // to reject.
    const nearZeroEstablishedRpd = ALT_MIN_ESTABLISHED_RPD - 0.15;
    const result = computeSignature(
      textbookInput({
        competitiveness: 46,
        trend: "stable",
        topApps: [
          app({ id: "newcomer", ageDays: 200, ratingsPerDay: 13, reviews: 250 }),
          app({
            id: "near-dead-incumbent",
            ageDays: 6500,
            ratingsPerDay: nearZeroEstablishedRpd,
            reviews: 8000,
            lastUpdatedDays: 900,
          }),
        ],
      }),
    );
    expect(result.velocityRatio).toBeGreaterThan(200); // the astronomical ratio the guard rejects despite clearing 1.2
    expect(result.hit).toBe(false);
  });
});

describe("computeSignature — suppression (window already closed)", () => {
  it("suppresses a keyword with an active, high-review, high-rating leader even if gates pass", () => {
    const withLeader = [
      ...textbookApps(),
      app({
        id: "leader",
        name: "Entrenched Leader",
        ageDays: 2000,
        // Kept low enough that the velocity-ratio gate still independently
        // PASSES (established: (2+5)/2=3.5, newcomer 6.5/3.5≈1.86 >= 1.5) —
        // isolates the suppression veto from the ratio gate.
        ratingsPerDay: 5,
        reviews: SUPPRESSION_LEADER_MIN_REVIEWS,
        rating: SUPPRESSION_LEADER_MIN_RATING,
        lastUpdatedDays: 30, // < 90, actively maintained
      }),
    ];
    const result = computeSignature(textbookInput({ topApps: withLeader }));
    // The ratio/max-reviews gates independently pass — suppression alone vetoes this hit.
    expect(result.velocityRatio).toBeGreaterThanOrEqual(1.5);
    expect(result.maxReviews).toBeLessThan(MAX_REVIEWS_CEILING);
    expect(result.suppressed).toBe(true);
    expect(result.hit).toBe(false);
  });

  it("does NOT suppress a stale leader (lastUpdatedDays >= 90), even with high reviews/rating", () => {
    const withStaleLeader = [
      ...textbookApps(),
      app({
        id: "stale-leader",
        ageDays: 2000,
        ratingsPerDay: 50,
        reviews: 20_000,
        rating: 4.8,
        lastUpdatedDays: 200, // >= 90 — not "active"
      }),
    ];
    const result = computeSignature(textbookInput({ topApps: withStaleLeader }));
    expect(result.suppressed).toBe(false);
  });
});

describe("computeSignature — each gate rejects in isolation", () => {
  it("rejects on competitiveness > 50", () => {
    const result = computeSignature(textbookInput({ competitiveness: 55 }));
    expect(result.hit).toBe(false);
    expect(result.suppressed).toBe(false);
  });

  it("rejects when trend is not 'heating'", () => {
    const result = computeSignature(textbookInput({ trend: "stable" }));
    expect(result.hit).toBe(false);
  });

  it("rejects when fewer than 2 fast newcomers are present", () => {
    const onlyOneNewcomer = [
      app({ id: "newcomer-1", ageDays: 200, ratingsPerDay: 5, reviews: 300 }),
      // Second app fails the newcomer ratingsPerDay > 1 filter, so it doesn't count.
      app({ id: "newcomer-2-too-slow", ageDays: 300, ratingsPerDay: 0.5, reviews: 500 }),
      app({ id: "established-1", ageDays: 600, ratingsPerDay: 2, reviews: 2000, lastUpdatedDays: 200 }),
    ];
    const result = computeSignature(textbookInput({ topApps: onlyOneNewcomer }));
    expect(result.fastNewcomers).toBe(1);
    expect(result.hit).toBe(false);
  });

  it("rejects when the newcomer/established velocity ratio is under 1.5", () => {
    const slowRatio = [
      app({ id: "newcomer-1", ageDays: 200, ratingsPerDay: 2.0, reviews: 300 }),
      app({ id: "newcomer-2", ageDays: 300, ratingsPerDay: 2.2, reviews: 500 }),
      app({ id: "established-1", ageDays: 600, ratingsPerDay: 2, reviews: 2000, lastUpdatedDays: 200 }),
    ];
    const result = computeSignature(textbookInput({ topApps: slowRatio }));
    expect(result.velocityRatio).toBeLessThan(1.5);
    expect(result.hit).toBe(false);
  });

  it("rejects when any app's reviews reach the max-reviews ceiling", () => {
    const overCeiling = [
      ...textbookApps().slice(0, 2),
      app({
        id: "established-1",
        ageDays: 600,
        ratingsPerDay: 2,
        reviews: MAX_REVIEWS_CEILING, // exactly at the ceiling — "< ceiling" excludes it
        rating: 3.8,
        lastUpdatedDays: 200,
      }),
    ];
    const result = computeSignature(textbookInput({ topApps: overCeiling }));
    expect(result.maxReviews).toBe(MAX_REVIEWS_CEILING);
    expect(result.hit).toBe(false);
  });

  it("rejects when genre_zone is 'entertainment' (case-insensitive)", () => {
    expect(computeSignature(textbookInput({ genreZone: "entertainment" })).hit).toBe(false);
    expect(computeSignature(textbookInput({ genreZone: "Entertainment" })).hit).toBe(false);
  });

  it("rejects a junk keyword (reuses keyword-junk.ts's JUNK_KEYWORDS list)", () => {
    expect(computeSignature(textbookInput({ keyword: "free" })).hit).toBe(false);
    expect(computeSignature(textbookInput({ keyword: "ab" })).hit).toBe(false); // < 3 chars
    expect(computeSignature(textbookInput({ keyword: "123" })).hit).toBe(false); // numeric-only
  });

  it("does not reject a multi-word keyword that merely CONTAINS a junk token", () => {
    // "free" alone is junk, but "free budget planner" is a real buildable
    // keyword — mirrors the opportunities `hideJunk` filter's semantics.
    const result = computeSignature(textbookInput({ keyword: "free budget planner" }));
    expect(result.hit).toBe(true);
  });

  it("rejects non-Latin-script keywords via both the primary and alt paths (live-corpus finding: сотрудник / 마음대로 / 传奇高爆99999)", () => {
    // Real keywords the newborn-velocity screener's live-corpus run hit
    // before this fix — Cyrillic, Hangul, and Han (mixed with digits) — none
    // of which the pre-existing JUNK_KEYWORDS/numeric-only/short-keyword
    // checks caught. Junk filtering is applied ONCE in `gatesPass`, ANDed
    // after `(primaryPathPass || altPathPass)`, so proving it here on both a
    // primary-path-shaped and an alt-path-shaped input covers both branches.
    const cyrillic = computeSignature(textbookInput({ keyword: "сотрудник" })); // primary-path-shaped (textbookInput default)
    expect(cyrillic.hit).toBe(false);

    const hangul = computeSignature(
      textbookInput({
        keyword: "마음대로",
        competitiveness: 46,
        trend: "stable",
        topApps: [
          app({ id: "newcomer", ageDays: 200, ratingsPerDay: 13, reviews: 250 }),
          app({ id: "ancient-incumbent", ageDays: 6500, ratingsPerDay: 10, reviews: 8000, lastUpdatedDays: 900 }),
        ],
      }),
    ); // alt-path-shaped — otherwise identical to the passing Yardly fixture above
    expect(hangul.hit).toBe(false);

    const hanWithDigits = computeSignature(textbookInput({ keyword: "传奇高爆99999" }));
    expect(hanWithDigits.hit).toBe(false);
  });
});

describe("computeSignature — null-safe established baseline", () => {
  it("treats a missing established baseline as satisfying the ratio gate, recording a null ratio", () => {
    const noEstablished = [
      app({ id: "newcomer-1", ageDays: 200, ratingsPerDay: 5, reviews: 300 }),
      app({ id: "newcomer-2", ageDays: 300, ratingsPerDay: 8, reviews: 500 }),
    ];
    const result = computeSignature(textbookInput({ topApps: noEstablished }));
    expect(result.establishedRpd).toBeNull();
    expect(result.velocityRatio).toBeNull();
    expect(result.hit).toBe(true);
  });

  it("treats a zero established baseline as satisfying the ratio gate, recording a null ratio", () => {
    const zeroEstablished = [
      app({ id: "newcomer-1", ageDays: 200, ratingsPerDay: 5, reviews: 300 }),
      app({ id: "newcomer-2", ageDays: 300, ratingsPerDay: 8, reviews: 500 }),
      app({ id: "established-1", ageDays: ESTABLISHED_AGE_DAYS_MIN, ratingsPerDay: 0, reviews: 100 }),
    ];
    const result = computeSignature(textbookInput({ topApps: zeroEstablished }));
    expect(result.establishedRpd).toBe(0);
    expect(result.velocityRatio).toBeNull();
    expect(result.hit).toBe(true);
  });
});

describe("computeSignature — null-safe recentVelocity (secondary accelerating-apps signal)", () => {
  it("does not throw and counts 0 accelerating apps when recentVelocity is absent on every app (older scans)", () => {
    const result = computeSignature(textbookInput());
    expect(result.acceleratingApps).toBe(0);
  });

  it("counts an app as accelerating only when it clears every accelerating threshold", () => {
    const accelerating = [
      ...textbookApps(),
      app({
        id: "accelerating",
        ageDays: NEWCOMER_AGE_DAYS_MAX + 10, // not a "newcomer" — irrelevant to the gates
        ratingsPerDay: 2,
        reviews: ACCELERATING_MIN_REVIEWS + 1,
        recentVelocity: ACCELERATING_MIN_RECENT_VELOCITY + 1, // ratio = (6/2) = 3x... bump below
      }),
    ];
    // ratio 3x doesn't clear ACCELERATING_VELOCITY_RATIO_MIN (4x) — not counted.
    expect(computeSignature(textbookInput({ topApps: accelerating })).acceleratingApps).toBe(0);

    const fastAccelerating = accelerating.map((a) =>
      a.id === "accelerating"
        ? { ...a, recentVelocity: a.ratingsPerDay * ACCELERATING_VELOCITY_RATIO_MIN }
        : a,
    );
    expect(computeSignature(textbookInput({ topApps: fastAccelerating })).acceleratingApps).toBe(1);
  });

  it("does not count an accelerating candidate whose reviews fall outside the 100..150,000 band", () => {
    const tooFewReviews = [
      ...textbookApps(),
      app({ id: "tiny", ageDays: 700, ratingsPerDay: 2, reviews: 10, recentVelocity: 20 }),
    ];
    expect(computeSignature(textbookInput({ topApps: tooFewReviews })).acceleratingApps).toBe(0);
  });
});
