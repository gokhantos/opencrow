import { describe, expect, it } from "bun:test";
import {
  advanceThrottle,
  computeEffectiveSweepRate,
  computeErrorRate,
  INITIAL_THROTTLE_STATE,
  LEGACY_KEYWORDS_PER_SWEEP,
  LEGACY_SWEEP_DELAY_MS,
  MIN_THROTTLE_MULTIPLIER,
  THROTTLE_BACKOFF_FACTOR,
  THROTTLE_ERROR_RATE_THRESHOLD,
  THROTTLE_HOLD_SWEEPS,
  THROTTLE_RECOVERY_STEP,
} from "./sweep-throttle";
import type { ThrottleState } from "./sweep-throttle";

describe("computeErrorRate", () => {
  it("is 0 when nothing was attempted", () => {
    expect(computeErrorRate(0, 0)).toBe(0);
    expect(computeErrorRate(5, 0)).toBe(0);
  });

  it("is the plain ratio otherwise", () => {
    expect(computeErrorRate(5, 100)).toBeCloseTo(0.05, 10);
    expect(computeErrorRate(0, 100)).toBe(0);
    expect(computeErrorRate(100, 100)).toBe(1);
  });
});

describe("advanceThrottle", () => {
  it("stays at full rate and ticks the hold counter when under threshold and not throttled", () => {
    const next = advanceThrottle(INITIAL_THROTTLE_STATE, 0);
    expect(next).toEqual({ multiplier: 1, sweepsSinceChange: 1, throttled: false });
  });

  it("trips (halves the multiplier) when the error rate is at the threshold", () => {
    const next = advanceThrottle(INITIAL_THROTTLE_STATE, THROTTLE_ERROR_RATE_THRESHOLD);
    expect(next).toEqual({
      multiplier: THROTTLE_BACKOFF_FACTOR,
      sweepsSinceChange: 0,
      throttled: true,
    });
  });

  it("trips further (halves again) when re-tripped while already throttled", () => {
    const throttled: ThrottleState = { multiplier: 0.5, sweepsSinceChange: 2, throttled: true };
    const next = advanceThrottle(throttled, 0.5);
    expect(next).toEqual({ multiplier: 0.25, sweepsSinceChange: 0, throttled: true });
  });

  it("floors repeated trips at MIN_THROTTLE_MULTIPLIER", () => {
    let state: ThrottleState = INITIAL_THROTTLE_STATE;
    for (let i = 0; i < 10; i++) {
      state = advanceThrottle(state, 1);
    }
    expect(state.multiplier).toBeCloseTo(MIN_THROTTLE_MULTIPLIER, 10);
    expect(state.multiplier).toBeGreaterThanOrEqual(MIN_THROTTLE_MULTIPLIER);
  });

  it("holds the halved rate for THROTTLE_HOLD_SWEEPS sweeps before recovering", () => {
    let state: ThrottleState = advanceThrottle(INITIAL_THROTTLE_STATE, 1); // trip
    expect(state.throttled).toBe(true);
    expect(state.multiplier).toBe(THROTTLE_BACKOFF_FACTOR);

    // THROTTLE_HOLD_SWEEPS - 1 more under-threshold sweeps: still held, no change.
    for (let i = 0; i < THROTTLE_HOLD_SWEEPS - 1; i++) {
      state = advanceThrottle(state, 0);
      expect(state.multiplier).toBe(THROTTLE_BACKOFF_FACTOR);
      expect(state.throttled).toBe(true);
    }

    // The THROTTLE_HOLD_SWEEPS-th under-threshold sweep triggers one recovery step.
    state = advanceThrottle(state, 0);
    expect(state.multiplier).toBeCloseTo(
      Math.min(1, THROTTLE_BACKOFF_FACTOR + THROTTLE_RECOVERY_STEP),
      10,
    );
    expect(state.sweepsSinceChange).toBe(0);
  });

  it("clears `throttled` once the multiplier recovers exactly to 1", () => {
    // Start already close to full rate so one recovery step reaches exactly 1.
    const almostRecovered: ThrottleState = {
      multiplier: 1 - THROTTLE_RECOVERY_STEP,
      sweepsSinceChange: THROTTLE_HOLD_SWEEPS - 1,
      throttled: true,
    };
    const next = advanceThrottle(almostRecovered, 0);
    expect(next.multiplier).toBeCloseTo(1, 10);
    expect(next.throttled).toBe(false);
  });

  it("re-trips instead of recovering if the error rate spikes again mid-hold", () => {
    let state: ThrottleState = advanceThrottle(INITIAL_THROTTLE_STATE, 1); // trip -> 0.5
    state = advanceThrottle(state, 0); // 1 sweep into the hold
    state = advanceThrottle(state, THROTTLE_ERROR_RATE_THRESHOLD); // spikes again
    expect(state.multiplier).toBeCloseTo(0.25, 10);
    expect(state.sweepsSinceChange).toBe(0);
    expect(state.throttled).toBe(true);
  });
});

describe("computeEffectiveSweepRate", () => {
  it("scales keywordsPerSweep by the throttle multiplier, leaving delayMs untouched", () => {
    const result = computeEffectiveSweepRate({
      configuredKeywordsPerSweep: 75,
      configuredDelayMs: 1000,
      legacyRateOverride: false,
      throttleMultiplier: 0.5,
    });
    expect(result).toEqual({ keywordsPerSweep: 37, delayMs: 1000 });
  });

  it("never scales keywordsPerSweep below 1", () => {
    const result = computeEffectiveSweepRate({
      configuredKeywordsPerSweep: 2,
      configuredDelayMs: 1000,
      legacyRateOverride: false,
      throttleMultiplier: MIN_THROTTLE_MULTIPLIER,
    });
    expect(result.keywordsPerSweep).toBeGreaterThanOrEqual(1);
  });

  it("is a no-op at multiplier 1", () => {
    const result = computeEffectiveSweepRate({
      configuredKeywordsPerSweep: 75,
      configuredDelayMs: 1000,
      legacyRateOverride: false,
      throttleMultiplier: 1,
    });
    expect(result).toEqual({ keywordsPerSweep: 75, delayMs: 1000 });
  });

  it("the hard kill-switch (legacyRateOverride) wins unconditionally, ignoring configured values and the multiplier", () => {
    const result = computeEffectiveSweepRate({
      configuredKeywordsPerSweep: 75,
      configuredDelayMs: 1000,
      legacyRateOverride: true,
      throttleMultiplier: 1,
    });
    expect(result).toEqual({
      keywordsPerSweep: LEGACY_KEYWORDS_PER_SWEEP,
      delayMs: LEGACY_SWEEP_DELAY_MS,
    });
  });
});
