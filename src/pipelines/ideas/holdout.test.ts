import { describe, expect, it } from "bun:test";
import { assignHoldoutArm, blankGuidanceForBlindArm } from "./holdout";

describe("assignHoldoutArm", () => {
  it("is deterministic — same runId always yields the same arm", () => {
    const runId = "run-abc-123";
    const first = assignHoldoutArm(runId, 0.5);
    for (let i = 0; i < 20; i++) {
      expect(assignHoldoutArm(runId, 0.5)).toBe(first);
    }
  });

  it("ratio <= 0 → always guided (no holdout)", () => {
    for (let i = 0; i < 100; i++) {
      expect(assignHoldoutArm(`run-${i}`, 0)).toBe("guided");
      expect(assignHoldoutArm(`run-${i}`, -0.3)).toBe("guided");
    }
  });

  it("ratio >= 1 → always blind", () => {
    for (let i = 0; i < 100; i++) {
      expect(assignHoldoutArm(`run-${i}`, 1)).toBe("blind");
      expect(assignHoldoutArm(`run-${i}`, 1.5)).toBe("blind");
    }
  });

  it("splits roughly 50/50 at ratio 0.5 over many ids", () => {
    let blind = 0;
    const total = 2000;
    for (let i = 0; i < total; i++) {
      if (assignHoldoutArm(`run-${i}-xyz`, 0.5) === "blind") blind += 1;
    }
    const share = blind / total;
    // Deterministic hash, not a real RNG, but should be well within [0.4, 0.6].
    expect(share).toBeGreaterThan(0.4);
    expect(share).toBeLessThan(0.6);
  });

  it("a higher ratio sends strictly more (or equal) runs blind", () => {
    const ids = Array.from({ length: 1000 }, (_, i) => `run-${i}`);
    const countBlind = (ratio: number) =>
      ids.filter((id) => assignHoldoutArm(id, ratio) === "blind").length;
    expect(countBlind(0.25)).toBeLessThanOrEqual(countBlind(0.75));
  });
});

describe("blankGuidanceForBlindArm", () => {
  it("returns empty block, segmentDirective and graphDirective", () => {
    expect(blankGuidanceForBlindArm()).toEqual({
      block: "",
      segmentDirective: "",
      graphDirective: "",
    });
  });
});
