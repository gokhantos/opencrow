import { describe, expect, it } from "bun:test";
import { isPassOverBudget } from "./pass-deadline";

describe("isPassOverBudget", () => {
  it("is false when no time has elapsed", () => {
    expect(isPassOverBudget(1_000, 5_000, 1_000)).toBe(false);
  });

  it("is false while under budget", () => {
    expect(isPassOverBudget(1_000, 5_000, 4_999)).toBe(false);
  });

  it("is true exactly at the budget boundary", () => {
    expect(isPassOverBudget(1_000, 5_000, 6_000)).toBe(true);
  });

  it("is true once elapsed exceeds the budget", () => {
    expect(isPassOverBudget(1_000, 5_000, 10_000)).toBe(true);
  });

  it("defaults `nowMs` to the real clock when omitted", () => {
    const startedAt = Date.now() - 10;
    expect(isPassOverBudget(startedAt, 100_000)).toBe(false);
    expect(isPassOverBudget(startedAt, 1)).toBe(true);
  });
});
