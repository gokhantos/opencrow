import { describe, expect, it } from "bun:test";
import {
  detectZeroYield,
  formatZeroYieldAlert,
  type ZeroYieldInput,
} from "./zero-yield";

function input(over: Partial<ZeroYieldInput> = {}): ZeroYieldInput {
  return {
    totalIdeasGenerated: 5,
    totalIdeasKept: 3,
    totalSignalsFound: 40,
    durationMs: 120_000,
    ...over,
  };
}

describe("detectZeroYield", () => {
  it("a healthy run is not zero-yield", () => {
    const v = detectZeroYield(input());
    expect(v.isZeroYield).toBe(false);
    expect(v.reason).toBeNull();
    expect(v.message).toBeNull();
  });

  it("flags synthesis_empty when synthesis ran on real signals and emitted nothing", () => {
    // The 2026-07-19 run 2f00f949 shape: every collector succeeded, synthesis
    // burned 406s, emitted 0 candidates, and the run reported "completed".
    const v = detectZeroYield(
      input({ totalIdeasGenerated: 0, totalIdeasKept: 0, totalSignalsFound: 120, durationMs: 824_914 }),
    );
    expect(v.isZeroYield).toBe(true);
    expect(v.reason).toBe("synthesis_empty");
    expect(v.message).toContain("0 ideas");
  });

  it("flags no_fresh_signals when there was nothing to synthesize from", () => {
    const v = detectZeroYield(
      input({ totalIdeasGenerated: 0, totalIdeasKept: 0, totalSignalsFound: 0 }),
    );
    expect(v.isZeroYield).toBe(true);
    expect(v.reason).toBe("no_fresh_signals");
  });

  it("flags all_ideas_rejected when synthesis produced candidates but none survived", () => {
    const v = detectZeroYield(input({ totalIdeasGenerated: 12, totalIdeasKept: 0 }));
    expect(v.isZeroYield).toBe(true);
    expect(v.reason).toBe("all_ideas_rejected");
    expect(v.message).toContain("12");
  });

  it("is not zero-yield when at least one idea was kept", () => {
    expect(detectZeroYield(input({ totalIdeasGenerated: 1, totalIdeasKept: 1 })).isZeroYield).toBe(
      false,
    );
  });

  it("treats negative/NaN counts defensively as zero", () => {
    const v = detectZeroYield(
      input({ totalIdeasGenerated: Number.NaN, totalIdeasKept: -3, totalSignalsFound: 10 }),
    );
    expect(v.isZeroYield).toBe(true);
    expect(v.reason).toBe("synthesis_empty");
  });
});

describe("formatZeroYieldAlert", () => {
  it("renders an operator-readable alert naming the pipeline, run and duration", () => {
    const v = detectZeroYield(
      input({ totalIdeasGenerated: 0, totalIdeasKept: 0, totalSignalsFound: 120, durationMs: 824_914 }),
    );
    const text = formatZeroYieldAlert({
      pipelineId: "mobile-app-ideas",
      runId: "2f00f949",
      verdict: v,
      input: input({ totalIdeasGenerated: 0, totalIdeasKept: 0, totalSignalsFound: 120, durationMs: 824_914 }),
    });
    expect(text).toContain("mobile-app-ideas");
    expect(text).toContain("2f00f949");
    expect(text).toContain("synthesis_empty");
    // 824,914ms -> ~13.7 min, must be legible not raw ms
    expect(text).toMatch(/13\.7 min|13\.7min/);
  });

  it("returns an empty string for a healthy run", () => {
    const v = detectZeroYield(input());
    expect(
      formatZeroYieldAlert({
        pipelineId: "p",
        runId: "r",
        verdict: v,
        input: input(),
      }),
    ).toBe("");
  });
});
