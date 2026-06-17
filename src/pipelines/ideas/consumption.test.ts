import { test, expect, describe } from "bun:test";
import {
  consumptionWeight,
  effectiveHalfLifeDays,
  isStillConsumed,
  DEFAULT_DECAY_CONFIG,
  type DecayConfig,
} from "./consumption";

const SECONDS_PER_DAY = 86_400;

const ENABLED: DecayConfig = {
  ...DEFAULT_DECAY_CONFIG,
  enabled: true,
  halfLifeDays: 14,
  resurfaceThreshold: 0.5,
  corroborationBoost: 0.25,
};

function daysAgo(now: number, days: number): number {
  return now - days * SECONDS_PER_DAY;
}

describe("effectiveHalfLifeDays", () => {
  test("single consumption uses the base half-life", () => {
    expect(effectiveHalfLifeDays(1, ENABLED)).toBe(14);
  });

  test("more consumptions shorten the effective half-life", () => {
    const one = effectiveHalfLifeDays(1, ENABLED);
    const three = effectiveHalfLifeDays(3, ENABLED);
    expect(three).toBeLessThan(one);
    // 14 / (1 + 0.25*2) = 14 / 1.5
    expect(three).toBeCloseTo(14 / 1.5, 6);
  });

  test("zero corroboration boost keeps half-life constant", () => {
    const cfg: DecayConfig = { ...ENABLED, corroborationBoost: 0 };
    expect(effectiveHalfLifeDays(5, cfg)).toBe(14);
  });

  test("counts below 1 are clamped to 1", () => {
    expect(effectiveHalfLifeDays(0, ENABLED)).toBe(14);
    expect(effectiveHalfLifeDays(-3, ENABLED)).toBe(14);
  });

  test("invalid half-life falls back to default", () => {
    const cfg: DecayConfig = { ...ENABLED, halfLifeDays: 0 };
    expect(effectiveHalfLifeDays(1, cfg)).toBe(DEFAULT_DECAY_CONFIG.halfLifeDays);
  });
});

describe("consumptionWeight", () => {
  const now = 1_700_000_000;

  test("just-consumed signal has full weight", () => {
    expect(
      consumptionWeight({ lastUsedAt: now, consumptionCount: 1, now, config: ENABLED }),
    ).toBe(1);
  });

  test("future-dated signal clamps to full weight", () => {
    expect(
      consumptionWeight({
        lastUsedAt: now + 1000,
        consumptionCount: 1,
        now,
        config: ENABLED,
      }),
    ).toBe(1);
  });

  test("weight is exactly 0.5 at one half-life", () => {
    const w = consumptionWeight({
      lastUsedAt: daysAgo(now, 14),
      consumptionCount: 1,
      now,
      config: ENABLED,
    });
    expect(w).toBeCloseTo(0.5, 6);
  });

  test("weight is 0.25 at two half-lives", () => {
    const w = consumptionWeight({
      lastUsedAt: daysAgo(now, 28),
      consumptionCount: 1,
      now,
      config: ENABLED,
    });
    expect(w).toBeCloseTo(0.25, 6);
  });

  test("weight decreases monotonically with age", () => {
    const young = consumptionWeight({
      lastUsedAt: daysAgo(now, 3),
      consumptionCount: 1,
      now,
      config: ENABLED,
    });
    const old = consumptionWeight({
      lastUsedAt: daysAgo(now, 30),
      consumptionCount: 1,
      now,
      config: ENABLED,
    });
    expect(young).toBeGreaterThan(old);
  });

  test("more corroboration decays faster (lower weight at same age)", () => {
    const once = consumptionWeight({
      lastUsedAt: daysAgo(now, 14),
      consumptionCount: 1,
      now,
      config: ENABLED,
    });
    const many = consumptionWeight({
      lastUsedAt: daysAgo(now, 14),
      consumptionCount: 5,
      now,
      config: ENABLED,
    });
    expect(many).toBeLessThan(once);
  });

  test("weight stays within [0, 1]", () => {
    const w = consumptionWeight({
      lastUsedAt: daysAgo(now, 10_000),
      consumptionCount: 1,
      now,
      config: ENABLED,
    });
    expect(w).toBeGreaterThanOrEqual(0);
    expect(w).toBeLessThanOrEqual(1);
  });
});

describe("isStillConsumed", () => {
  const now = 1_700_000_000;

  test("disabled config always keeps signal consumed (legacy)", () => {
    const w = isStillConsumed({
      lastUsedAt: daysAgo(now, 10_000),
      consumptionCount: 1,
      now,
      config: { ...ENABLED, enabled: false },
    });
    expect(w).toBe(true);
  });

  test("fresh signal stays consumed when enabled", () => {
    expect(
      isStillConsumed({
        lastUsedAt: daysAgo(now, 1),
        consumptionCount: 1,
        now,
        config: ENABLED,
      }),
    ).toBe(true);
  });

  test("signal resurfaces once weight falls below threshold", () => {
    // At threshold 0.5, one half-life (14d) is exactly the boundary; just past
    // it the weight is < 0.5 → resurfaces.
    expect(
      isStillConsumed({
        lastUsedAt: daysAgo(now, 20),
        consumptionCount: 1,
        now,
        config: ENABLED,
      }),
    ).toBe(false);
  });

  test("strongly-corroborated signal resurfaces sooner than a singly-consumed one", () => {
    const params = (count: number) => ({
      lastUsedAt: daysAgo(now, 12),
      consumptionCount: count,
      now,
      config: ENABLED,
    });
    // At 12 days the single-consumption signal is still consumed, but the
    // heavily-corroborated one has decayed past the threshold and resurfaces.
    expect(isStillConsumed(params(1))).toBe(true);
    expect(isStillConsumed(params(10))).toBe(false);
  });
});
