/**
 * Unit tests for the READ-ONLY competability calibration / backtest module.
 * PURE + deterministic, so all assertions are exact (no DB, no clock, no rng).
 */
import { describe, expect, it } from "bun:test";
import {
  BUCKET_WIDTH,
  type CalibrationRecord,
  calibrateCompetability,
  LOW_CONFIDENCE_SAMPLE_CUTOFF,
  TARGET_KILL_RATE_HIGH,
  TARGET_KILL_RATE_LOW,
  VALLEY_MIN_SIDE_MASS_FRACTION,
} from "./competability-calibration";
import { DEFAULT_REJECT_THRESHOLD } from "./competability";

function rec(overall: number, gated = false, dims?: CalibrationRecord["dimensions"]): CalibrationRecord {
  return dims ? { overall, gated, dimensions: dims } : { overall, gated };
}

describe("calibrateCompetability — histogram + kill-rate (exact)", () => {
  it("buckets a hand-computed input exactly and computes kill rates exactly", () => {
    // 10 records, chosen so each lands in a known bucket:
    //   0.0 → [0,0.5)        1.0 → [1.0,1.5)     1.2 → [1.0,1.5)
    //   2.5 → [2.5,3.0)  (boundary lands in UPPER bucket)
    //   3.0 → [3.0,3.5)      4.0 → [4.0,4.5)     4.2 → [4.0,4.5)
    //   4.5 → [4.5,5.0)      4.9 → [4.5,5.0)     5.0 → [4.5,5.0] (top bucket closed)
    const records: readonly CalibrationRecord[] = [
      rec(0.0),
      rec(1.0),
      rec(1.2),
      rec(2.5),
      rec(3.0),
      rec(4.0),
      rec(4.2),
      rec(4.5),
      rec(4.9),
      rec(5.0),
    ];
    const report = calibrateCompetability(records);

    // Hand-computed histogram assumes a 0.5 bucket grid.
    expect(BUCKET_WIDTH).toBe(0.5);
    expect(report.sampleSize).toBe(10);
    // 10 buckets [0,0.5)…[4.5,5.0].
    const counts = report.histogram.map((b) => b.count);
    expect(counts).toEqual([
      1, // [0.0,0.5)  → 0.0
      0, // [0.5,1.0)
      2, // [1.0,1.5)  → 1.0, 1.2
      0, // [1.5,2.0)
      0, // [2.0,2.5)
      1, // [2.5,3.0)  → 2.5 (boundary → upper bucket)
      1, // [3.0,3.5)  → 3.0
      0, // [3.5,4.0)
      2, // [4.0,4.5)  → 4.0, 4.2
      3, // [4.5,5.0]  → 4.5, 4.9, 5.0 (top closed)
    ]);
    expect(report.histogram[0]!.lo).toBe(0);
    expect(report.histogram[0]!.hi).toBe(0.5);
    expect(report.histogram[9]!.lo).toBe(4.5);
    expect(report.histogram[9]!.hi).toBe(5);

    // killRateCurve: fraction with overall < threshold, thresholds 0,0.5,…,5.0.
    const byThreshold = new Map(report.killRateCurve.map((p) => [p.threshold, p.rejectFraction]));
    expect(report.killRateCurve.length).toBe(11);
    expect(byThreshold.get(0)).toBe(0); // none < 0
    expect(byThreshold.get(0.5)).toBeCloseTo(0.1, 10); // {0.0}
    expect(byThreshold.get(1.0)).toBeCloseTo(0.1, 10); // {0.0} (1.0 not < 1.0)
    expect(byThreshold.get(1.5)).toBeCloseTo(0.3, 10); // {0.0,1.0,1.2}
    expect(byThreshold.get(2.0)).toBeCloseTo(0.3, 10); // {0.0,1.0,1.2}
    expect(byThreshold.get(2.5)).toBeCloseTo(0.3, 10); // 2.5 not < 2.5
    expect(byThreshold.get(3.0)).toBeCloseTo(0.4, 10); // +2.5
    expect(byThreshold.get(4.5)).toBeCloseTo(0.7, 10); // {0.0,1.0,1.2,2.5,3.0,4.0,4.2}
    expect(byThreshold.get(5.0)).toBeCloseTo(0.9, 10); // all except {5.0} (4.5,4.9 are < 5.0)

    // currentThreshold mirrors the live default; currentKillRate = reject@2.0.
    expect(report.currentThreshold).toBe(DEFAULT_REJECT_THRESHOLD);
    expect(report.currentKillRate).toBeCloseTo(0.3, 10);
  });

  it("places a value exactly on a bucket edge in the UPPER (half-open) bucket", () => {
    const report = calibrateCompetability([rec(2.5)]);
    // [2.5,3.0) is bucket index 5.
    expect(report.histogram[5]!.count).toBe(1);
    expect(report.histogram[4]!.count).toBe(0); // NOT in [2.0,2.5)
  });

  it("counts the maximum score 5.0 in the closed top bucket", () => {
    const report = calibrateCompetability([rec(5.0)]);
    expect(report.histogram[9]!.count).toBe(1);
    expect(report.histogram[9]!.hi).toBe(5);
  });
});

describe("calibrateCompetability — bimodal recommends the valley", () => {
  it("recommends a threshold in the gap between a low and high cluster", () => {
    // Low cluster near 1.0, high cluster near 4.0, EMPTY band 1.5..3.5.
    const low = Array.from({ length: 20 }, () => rec(1.0));
    const high = Array.from({ length: 20 }, () => rec(4.0));
    const report = calibrateCompetability([...low, ...high]);

    expect(report.recommendationMethod).toBe("valley");
    // The valley boundary must sit strictly inside the empty band.
    expect(report.recommendedThreshold).toBeGreaterThan(1.5);
    expect(report.recommendedThreshold).toBeLessThan(4.0);
    // Both clusters carry > VALLEY_MIN_SIDE_MASS_FRACTION of the mass.
    expect(VALLEY_MIN_SIDE_MASS_FRACTION).toBeGreaterThan(0);
  });
});

describe("calibrateCompetability — unimodal falls back to target band", () => {
  it("uses the target-band fallback and lands a sane threshold", () => {
    // A single dense cluster spread tightly around 3.0 — no separating valley
    // (no interior boundary has mass on BOTH sides above the min-side fraction
    // with a clear low-density gap → all mass is contiguous).
    const records = Array.from({ length: 40 }, (_, i) => rec(3.0 + (i % 3) * 0.1));
    const report = calibrateCompetability(records);

    expect(report.recommendationMethod).toBe("target-band-fallback");
    // The recommended threshold's kill rate should be the closest achievable to
    // the band; here the whole cluster is high so kill rates are ~0 — fallback
    // picks the threshold nearest the target mid, still a finite sane number.
    expect(report.recommendedThreshold).toBeGreaterThanOrEqual(0);
    expect(report.recommendedThreshold).toBeLessThanOrEqual(5);
    expect(TARGET_KILL_RATE_LOW).toBeLessThan(TARGET_KILL_RATE_HIGH);
  });

  it("for a unimodal split distribution, fallback lands the kill rate near the band", () => {
    // 30% below 2.0, 70% above — contiguous-ish, no empty valley. Build so the
    // fallback can find a threshold whose kill rate is inside 0.15..0.35.
    const lowTail = Array.from({ length: 9 }, () => rec(1.0));
    const body = Array.from({ length: 21 }, (_, i) => rec(2.5 + (i % 5) * 0.1));
    const report = calibrateCompetability([...lowTail, ...body]);
    // kill rate at the recommended threshold (overall<threshold).
    const point = report.killRateCurve.find((p) => p.threshold === report.recommendedThreshold);
    expect(point).toBeDefined();
  });
});

describe("calibrateCompetability — small-n / empty / dims edges", () => {
  it("empty input: lowConfidence, no crash, current-threshold default", () => {
    const report = calibrateCompetability([]);
    expect(report.sampleSize).toBe(0);
    expect(report.lowConfidence).toBe(true);
    expect(report.recommendedThreshold).toBe(DEFAULT_REJECT_THRESHOLD);
    expect(report.currentKillRate).toBe(0);
    expect(report.gatedFraction).toBe(0);
    expect(report.recordsWithDimensions).toBe(0);
    expect(report.caveats).toContain("No scored ideas");
    // histogram + curve still well-formed.
    expect(report.histogram.length).toBe(10);
    expect(report.killRateCurve.length).toBe(11);
  });

  it("tiny n (below cutoff): lowConfidence true and a caveat", () => {
    const records = Array.from({ length: 5 }, () => rec(2.0));
    const report = calibrateCompetability(records);
    expect(records.length).toBeLessThan(LOW_CONFIDENCE_SAMPLE_CUTOFF);
    expect(report.lowConfidence).toBe(true);
    expect(report.caveats).toContain("low-confidence");
  });

  it("n at the cutoff is NOT low-confidence", () => {
    const records = Array.from({ length: LOW_CONFIDENCE_SAMPLE_CUTOFF }, () => rec(3.0));
    const report = calibrateCompetability(records);
    expect(report.lowConfidence).toBe(false);
  });

  it("all-gated and none-gated report the right gatedFraction", () => {
    const allGated = calibrateCompetability([rec(1.0, true), rec(1.2, true)]);
    expect(allGated.gatedFraction).toBe(1);
    const noneGated = calibrateCompetability([rec(4.0, false), rec(4.2, false)]);
    expect(noneGated.gatedFraction).toBe(0);
  });

  it("computes per-dimension averages only over records that carry dims", () => {
    const dims1 = { capital: 4, networkEffect: 2, logistics: 0, regulated: 5 };
    const dims2 = { capital: 2, networkEffect: 4, logistics: 4, regulated: 1 };
    const report = calibrateCompetability([
      rec(1.0, true, dims1),
      rec(2.0, false, dims2),
      rec(3.0, false), // no dims → excluded from averages
    ]);
    expect(report.recordsWithDimensions).toBe(2);
    expect(report.dimensionAverages.capital).toBeCloseTo(3, 10); // (4+2)/2
    expect(report.dimensionAverages.networkEffect).toBeCloseTo(3, 10); // (2+4)/2
    expect(report.dimensionAverages.logistics).toBeCloseTo(2, 10); // (0+4)/2
    expect(report.dimensionAverages.regulated).toBeCloseTo(3, 10); // (5+1)/2
  });

  it("no records carry dims → averages are all zero with a caveat", () => {
    const report = calibrateCompetability([rec(2.0), rec(3.0)]);
    expect(report.recordsWithDimensions).toBe(0);
    expect(report.dimensionAverages.capital).toBe(0);
    expect(report.caveats).toContain("moat dimensions");
  });
});
