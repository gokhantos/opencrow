import { describe, expect, it } from "bun:test";
import {
  computeSpearmanCorrelation,
  formatCalibrationReport,
  type CalibrationSample,
} from "./demand-proxy-calibration";

function sample(keyword: string, demand: number, asaPopularity: number): CalibrationSample {
  return { keyword, demand, asaPopularity };
}

describe("computeSpearmanCorrelation", () => {
  it("returns rho=1 for perfectly monotonically increasing series", () => {
    const result = computeSpearmanCorrelation([
      sample("a", 1, 1),
      sample("b", 2, 2),
      sample("c", 3, 3),
      sample("d", 4, 4),
    ]);
    expect(result.sampleSize).toBe(4);
    expect(result.spearmanRho).toBeCloseTo(1, 6);
  });

  it("returns rho=-1 for a perfectly inverse relationship", () => {
    const result = computeSpearmanCorrelation([
      sample("a", 1, 4),
      sample("b", 2, 3),
      sample("c", 3, 2),
      sample("d", 4, 1),
    ]);
    expect(result.spearmanRho).toBeCloseTo(-1, 6);
  });

  it("resolves ties to the average-rank convention (does not throw / stays bounded)", () => {
    const result = computeSpearmanCorrelation([
      sample("a", 10, 1),
      sample("b", 20, 1),
      sample("c", 20, 1),
      sample("d", 30, 4),
    ]);
    expect(result.spearmanRho).not.toBeNull();
    expect(result.spearmanRho as number).toBeGreaterThanOrEqual(-1);
    expect(result.spearmanRho as number).toBeLessThanOrEqual(1);
  });

  it("mirrors the 2026-07-20 sweep: near-uniform ASA popularity (mostly 1) against varying demand yields a near-zero/undefined correlation", () => {
    // 27/28 real-world terms landed at popularity 1 — near-zero variance in
    // one variable means the demand proxy's variation carries no
    // relationship to ASA ground truth, regardless of how demand itself varies.
    const result = computeSpearmanCorrelation([
      sample("a", 3, 1),
      sample("b", 15, 1),
      sample("c", 1, 1),
      sample("d", 40, 1),
      sample("e", 8, 1),
    ]);
    // Zero variance in popularity -> Pearson-of-ranks denominator is zero -> undefined.
    expect(result.spearmanRho).toBeNull();
  });

  it("returns spearmanRho=null for fewer than 2 samples", () => {
    expect(computeSpearmanCorrelation([]).spearmanRho).toBeNull();
    expect(computeSpearmanCorrelation([sample("a", 1, 1)]).spearmanRho).toBeNull();
  });

  it("echoes the input samples back unchanged", () => {
    const samples = [sample("a", 1, 1), sample("b", 2, 2)];
    const result = computeSpearmanCorrelation(samples);
    expect(result.samples).toEqual(samples);
  });
});

describe("formatCalibrationReport", () => {
  it("renders the sample size, rho, a verdict, and every keyword row", () => {
    const result = computeSpearmanCorrelation([
      sample("budget planner", 12, 1),
      sample("habit tracker", 3, 4),
    ]);
    const report = formatCalibrationReport(result);
    expect(report).toContain("2 probed keyword(s)");
    expect(report).toContain("budget planner");
    expect(report).toContain("habit tracker");
    expect(report).toContain("Spearman rho:");
  });

  it("renders 'n/a' rho and an 'Undefined' verdict when correlation cannot be computed", () => {
    const result = computeSpearmanCorrelation([sample("only-one", 1, 1)]);
    const report = formatCalibrationReport(result);
    expect(report).toContain("Spearman rho: n/a");
    expect(report).toContain("Undefined");
  });
});
