import { test, expect, describe } from "bun:test";
import {
  aggregateSignalRanker,
  type RankerEvalRow,
} from "./signal-ranker";
import type { SignalImportance } from "../../../memory/signal-facets";

// ── Fixtures ───────────────────────────────────────────────────────────────────

function row(
  importance: SignalImportance,
  success: boolean,
  relevanceToIdeas?: number,
  category?: string,
): RankerEvalRow {
  return { importance, success, relevanceToIdeas, category };
}

/** Build n rows of a bucket with `k` successes. */
function bucketRows(
  importance: SignalImportance,
  n: number,
  successes: number,
  relevance?: number,
): RankerEvalRow[] {
  const out: RankerEvalRow[] = [];
  for (let i = 0; i < n; i++) {
    out.push(row(importance, i < successes, relevance));
  }
  return out;
}

function findBucket(
  report: NonNullable<ReturnType<typeof aggregateSignalRanker>>,
  importance: SignalImportance,
) {
  return report.buckets.find((b) => b.importance === importance)!;
}

// ── Empty / cold start ──────────────────────────────────────────────────────────

describe("aggregateSignalRanker — empty", () => {
  test("no rows → null (section omitted)", () => {
    expect(aggregateSignalRanker([])).toBeNull();
  });
});

// ── Per-bucket validation rate ──────────────────────────────────────────────────

describe("aggregateSignalRanker — per-bucket validation rate", () => {
  test("realized rate = successes / n per bucket; all four buckets present", () => {
    const rows = [
      ...bucketRows("high", 4, 3), // 0.75
      ...bucketRows("low", 4, 1), // 0.25
    ];
    const r = aggregateSignalRanker(rows)!;

    // Always reports all four buckets in noise→high order.
    expect(r.buckets.map((b) => b.importance)).toEqual([
      "noise",
      "low",
      "medium",
      "high",
    ]);

    const high = findBucket(r, "high");
    expect(high.n).toBe(4);
    expect(high.successes).toBe(3);
    expect(high.failures).toBe(1);
    expect(high.validationRate).toBe(0.75);

    const low = findBucket(r, "low");
    expect(low.validationRate).toBe(0.25);

    // Unobserved buckets → null rate, but still carry the neutral calibrated weight.
    const noise = findBucket(r, "noise");
    expect(noise.n).toBe(0);
    expect(noise.validationRate).toBeNull();
    expect(noise.calibratedWeight).toBe(0.5); // Beta(1,1) prior mean

    expect(r.totalLabeled).toBe(8);
  });

  test("calibrated weight is the Beta posterior mean, not the raw rate", () => {
    // 3 success / 1 failure over Beta(1,1): mean = (1+3)/(1+1+4) = 4/6 ≈ 0.6667
    const r = aggregateSignalRanker(bucketRows("high", 4, 3))!;
    const high = findBucket(r, "high");
    expect(high.validationRate).toBe(0.75); // raw
    expect(high.calibratedWeight).toBe(0.6667); // regularized by prior
  });
});

// ── Ranker precision / lift ─────────────────────────────────────────────────────

describe("aggregateSignalRanker — lift", () => {
  test("high tier validates more than low tier → lift > 1", () => {
    const rows = [
      ...bucketRows("high", 4, 4), // high tier success
      ...bucketRows("medium", 4, 2),
      ...bucketRows("low", 4, 1), // low tier success
      ...bucketRows("noise", 4, 0),
    ];
    const r = aggregateSignalRanker(rows)!;
    // high tier: (4+2)/8 = 0.75 ; low tier: (1+0)/8 = 0.125
    expect(r.highTierRate).toBe(0.75);
    expect(r.lowTierRate).toBe(0.125);
    expect(r.lift).toBe(6); // 0.75 / 0.125
  });

  test("lift null when low tier has zero validation rate (no division by zero)", () => {
    const rows = [
      ...bucketRows("high", 2, 2),
      ...bucketRows("low", 2, 0), // low tier rate = 0
    ];
    const r = aggregateSignalRanker(rows)!;
    expect(r.lowTierRate).toBe(0);
    expect(r.highTierRate).toBe(1);
    expect(r.lift).toBeNull();
  });

  test("lift null when a tier is entirely empty", () => {
    const r = aggregateSignalRanker(bucketRows("high", 2, 1))!;
    expect(r.lowTierRate).toBeNull();
    expect(r.lift).toBeNull();
  });
});

// ── Monotonicity ────────────────────────────────────────────────────────────────

describe("aggregateSignalRanker — monotonicity", () => {
  test("non-decreasing rates with importance → monotonic true", () => {
    const rows = [
      ...bucketRows("noise", 4, 0), // 0.0
      ...bucketRows("low", 4, 1), // 0.25
      ...bucketRows("medium", 4, 2), // 0.5
      ...bucketRows("high", 4, 4), // 1.0
    ];
    expect(aggregateSignalRanker(rows)!.monotonic).toBe(true);
  });

  test("an inversion (high validates less than medium) → monotonic false", () => {
    const rows = [
      ...bucketRows("medium", 4, 3), // 0.75
      ...bucketRows("high", 4, 1), // 0.25 — inverted
    ];
    expect(aggregateSignalRanker(rows)!.monotonic).toBe(false);
  });

  test("empty middle buckets are skipped, not treated as inversions", () => {
    const rows = [
      ...bucketRows("low", 2, 0), // 0.0 ; medium absent
      ...bucketRows("high", 2, 2), // 1.0
    ];
    expect(aggregateSignalRanker(rows)!.monotonic).toBe(true);
  });

  test("fewer than two observed buckets → monotonic null", () => {
    expect(aggregateSignalRanker(bucketRows("high", 3, 2))!.monotonic).toBeNull();
  });
});

// ── Calibration gap ─────────────────────────────────────────────────────────────

describe("aggregateSignalRanker — calibration gap", () => {
  test("gap = asserted relevance − realized rate (over-stated bucket is positive)", () => {
    // 'high' asserted at 0.9 relevance but only validates 0.25 of the time.
    const rows = bucketRows("high", 4, 1, 0.9);
    const r = aggregateSignalRanker(rows)!;
    const high = findBucket(r, "high");
    expect(high.assertedRelevance).toBe(0.9);
    expect(high.validationRate).toBe(0.25);
    expect(high.calibrationGap).toBe(0.65); // model over-stated usefulness
    expect(r.meanAbsCalibrationGap).toBe(0.65);
  });

  test("under-stated bucket has a negative gap", () => {
    const rows = bucketRows("low", 4, 3, 0.1); // validates 0.75, asserted 0.1
    const high = findBucket(aggregateSignalRanker(rows)!, "low");
    expect(high.calibrationGap).toBe(-0.65);
  });

  test("no relevance supplied → gap null, meanAbsCalibrationGap null", () => {
    const r = aggregateSignalRanker(bucketRows("high", 4, 2))!;
    const high = findBucket(r, "high");
    expect(high.assertedRelevance).toBeNull();
    expect(high.calibrationGap).toBeNull();
    expect(r.meanAbsCalibrationGap).toBeNull();
  });

  test("out-of-range relevance is clamped into [0,1] before averaging", () => {
    const rows = [
      row("high", true, 1.5), // clamps to 1
      row("high", true, -0.5), // clamps to 0
    ];
    const high = findBucket(aggregateSignalRanker(rows)!, "high");
    expect(high.assertedRelevance).toBe(0.5); // mean of {1, 0}
  });

  test("meanAbsCalibrationGap averages magnitudes across buckets", () => {
    const rows = [
      ...bucketRows("high", 4, 1, 0.9), // gap +0.65
      ...bucketRows("low", 4, 3, 0.1), // gap -0.65
    ];
    const r = aggregateSignalRanker(rows)!;
    expect(r.meanAbsCalibrationGap).toBe(0.65); // mean(|0.65|, |-0.65|)
  });
});

// ── Defensive ───────────────────────────────────────────────────────────────────

describe("aggregateSignalRanker — defensive", () => {
  test("malformed importance buckets are dropped by the calibration math", () => {
    const rows = [
      { importance: "bogus" as SignalImportance, success: true },
      ...bucketRows("high", 2, 2),
    ];
    const r = aggregateSignalRanker(rows)!;
    // totalLabeled counts the raw input; the bogus row just contributes nothing.
    expect(r.totalLabeled).toBe(3);
    expect(findBucket(r, "high").n).toBe(2);
  });
});
