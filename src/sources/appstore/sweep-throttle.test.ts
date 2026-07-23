import { describe, expect, it } from "bun:test";
import {
  advanceThrottle,
  computeEffectiveSweepRate,
  computeErrorRate,
  INITIAL_THROTTLE_STATE,
  LEGACY_KEYWORDS_PER_SWEEP,
  LEGACY_SWEEP_DELAY_MS,
  MIN_ATTEMPTED_FOR_TRIP,
  MIN_THROTTLE_MULTIPLIER,
  THROTTLE_BACKOFF_FACTOR,
  THROTTLE_ERROR_RATE_THRESHOLD,
  THROTTLE_HOLD_SWEEPS,
  THROTTLE_RECOVERY_STEP,
} from "./sweep-throttle";
import type { ThrottleOutcome, ThrottleState } from "./sweep-throttle";

/**
 * A tick outcome with enough attempted requests to clear the min-attempted
 * trip gate, whose error rate equals `rate`. Rounds up so the ratio is at or
 * above `rate` even after integer division.
 */
function tick(rate: number, attempted: number = MIN_ATTEMPTED_FOR_TRIP): ThrottleOutcome {
  return { rateLimitErrors: Math.ceil(rate * attempted), attempted };
}

/** A clean tick (zero errors) that still clears the min-attempted gate. */
const CLEAN: ThrottleOutcome = { rateLimitErrors: 0, attempted: MIN_ATTEMPTED_FOR_TRIP };

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
    const next = advanceThrottle(INITIAL_THROTTLE_STATE, CLEAN);
    expect(next).toEqual({ multiplier: 1, sweepsSinceChange: 1, throttled: false });
  });

  it("trips (halves the multiplier) when the error rate is at the threshold", () => {
    const next = advanceThrottle(INITIAL_THROTTLE_STATE, tick(THROTTLE_ERROR_RATE_THRESHOLD, 100));
    expect(next).toEqual({
      multiplier: THROTTLE_BACKOFF_FACTOR,
      sweepsSinceChange: 0,
      throttled: true,
    });
  });

  it("trips further (halves again) when re-tripped while already throttled", () => {
    const throttled: ThrottleState = { multiplier: 0.5, sweepsSinceChange: 2, throttled: true };
    const next = advanceThrottle(throttled, tick(0.5, 100));
    expect(next).toEqual({ multiplier: 0.25, sweepsSinceChange: 0, throttled: true });
  });

  it("floors repeated trips at MIN_THROTTLE_MULTIPLIER", () => {
    let state: ThrottleState = INITIAL_THROTTLE_STATE;
    for (let i = 0; i < 10; i++) {
      state = advanceThrottle(state, tick(1, 100));
    }
    expect(state.multiplier).toBeCloseTo(MIN_THROTTLE_MULTIPLIER, 10);
    expect(state.multiplier).toBeGreaterThanOrEqual(MIN_THROTTLE_MULTIPLIER);
  });

  it("holds the halved rate for THROTTLE_HOLD_SWEEPS sweeps before recovering", () => {
    let state: ThrottleState = advanceThrottle(INITIAL_THROTTLE_STATE, tick(1, 100)); // trip
    expect(state.throttled).toBe(true);
    expect(state.multiplier).toBe(THROTTLE_BACKOFF_FACTOR);

    // THROTTLE_HOLD_SWEEPS - 1 more under-threshold sweeps: still held, no change.
    for (let i = 0; i < THROTTLE_HOLD_SWEEPS - 1; i++) {
      state = advanceThrottle(state, CLEAN);
      expect(state.multiplier).toBe(THROTTLE_BACKOFF_FACTOR);
      expect(state.throttled).toBe(true);
    }

    // The THROTTLE_HOLD_SWEEPS-th under-threshold sweep triggers one recovery step.
    state = advanceThrottle(state, CLEAN);
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
    const next = advanceThrottle(almostRecovered, CLEAN);
    expect(next.multiplier).toBeCloseTo(1, 10);
    expect(next.throttled).toBe(false);
  });

  it("re-trips instead of recovering if the error rate spikes again mid-hold", () => {
    let state: ThrottleState = advanceThrottle(INITIAL_THROTTLE_STATE, tick(1, 100)); // trip -> 0.5
    state = advanceThrottle(state, CLEAN); // 1 sweep into the hold
    state = advanceThrottle(state, tick(THROTTLE_ERROR_RATE_THRESHOLD, 100)); // spikes again
    expect(state.multiplier).toBeCloseTo(0.25, 10);
    expect(state.sweepsSinceChange).toBe(0);
    expect(state.throttled).toBe(true);
  });

  describe("min-attempted trip gate (B1)", () => {
    it("never trips below MIN_ATTEMPTED_FOR_TRIP, even at a 100% error rate", () => {
      const lowVolume: ThrottleOutcome = {
        rateLimitErrors: MIN_ATTEMPTED_FOR_TRIP - 1,
        attempted: MIN_ATTEMPTED_FOR_TRIP - 1,
      };
      const next = advanceThrottle(INITIAL_THROTTLE_STATE, lowVolume);
      // Treated as an under-threshold sweep: full rate, hold counter ticks.
      expect(next).toEqual({ multiplier: 1, sweepsSinceChange: 1, throttled: false });
    });

    it("trips at exactly MIN_ATTEMPTED_FOR_TRIP when the ratio clears the threshold", () => {
      const atGate: ThrottleOutcome = {
        rateLimitErrors: MIN_ATTEMPTED_FOR_TRIP,
        attempted: MIN_ATTEMPTED_FOR_TRIP,
      };
      const next = advanceThrottle(INITIAL_THROTTLE_STATE, atGate);
      expect(next.throttled).toBe(true);
      expect(next.multiplier).toBe(THROTTLE_BACKOFF_FACTOR);
    });

    it("a below-floor tick still counts toward recovery while throttled", () => {
      let state: ThrottleState = advanceThrottle(INITIAL_THROTTLE_STATE, tick(1, 100)); // trip
      const belowFloor: ThrottleOutcome = { rateLimitErrors: 1, attempted: 1 };
      for (let i = 0; i < THROTTLE_HOLD_SWEEPS; i++) {
        state = advanceThrottle(state, belowFloor);
      }
      // Even though each below-floor tick had a 100% ratio, none re-tripped;
      // they advanced recovery instead.
      expect(state.multiplier).toBeCloseTo(
        Math.min(1, THROTTLE_BACKOFF_FACTOR + THROTTLE_RECOVERY_STEP),
        10,
      );
    });

    it("weights the error rate by real volume across a tick's aggregated lanes", () => {
      // One lane's single 429 amid a high-volume tick is well under threshold.
      const aggregated: ThrottleOutcome = { rateLimitErrors: 1, attempted: 100 };
      const next = advanceThrottle(INITIAL_THROTTLE_STATE, aggregated);
      expect(next.throttled).toBe(false);
      expect(next.multiplier).toBe(1);
    });

    it("an empty tick (attempted 0) never trips and advances recovery when throttled", () => {
      const empty: ThrottleOutcome = { rateLimitErrors: 0, attempted: 0 };
      expect(advanceThrottle(INITIAL_THROTTLE_STATE, empty)).toEqual({
        multiplier: 1,
        sweepsSinceChange: 1,
        throttled: false,
      });
    });
  });

  // Continuous fetch (2026-07-23): AIMD step sizes are now caller-tunable
  // (`ThrottleParams`, wired from `appstoreKeywordGap.sweepRateSafety.
  // throttleBackoffFactor`/`throttleRecoveryStep` in production — see
  // scraper.ts) so the throttle can be tuned to probe closer to (or further
  // from) Apple's real ceiling without a code change.
  describe("ThrottleParams overrides", () => {
    it("omitted params fall back to the module's own constants (backward compatible)", () => {
      const tripped = advanceThrottle(INITIAL_THROTTLE_STATE, tick(1, 100), {});
      expect(tripped.multiplier).toBe(THROTTLE_BACKOFF_FACTOR);
    });

    it("a custom backoffFactor overrides THROTTLE_BACKOFF_FACTOR on trip", () => {
      const tripped = advanceThrottle(INITIAL_THROTTLE_STATE, tick(1, 100), {
        backoffFactor: 0.9,
      });
      expect(tripped.multiplier).toBeCloseTo(0.9, 10);
    });

    it("a custom recoveryStep overrides THROTTLE_RECOVERY_STEP once the hold clears", () => {
      let state: ThrottleState = advanceThrottle(INITIAL_THROTTLE_STATE, tick(1, 100)); // trip -> 0.5
      // Custom holdSweeps of 1: the very next clean tick recovers.
      state = advanceThrottle(state, CLEAN, { recoveryStep: 0.4, holdSweeps: 1 });
      expect(state.multiplier).toBeCloseTo(0.9, 10);
      expect(state.sweepsSinceChange).toBe(0);
    });

    it("a custom holdSweeps shortens (or lengthens) the recovery hold independent of the module default", () => {
      let state: ThrottleState = advanceThrottle(INITIAL_THROTTLE_STATE, tick(1, 100)); // trip -> 0.5
      // holdSweeps: 1 means the very next clean sweep recovers, instead of
      // waiting for THROTTLE_HOLD_SWEEPS (3) clean sweeps.
      state = advanceThrottle(state, CLEAN, { holdSweeps: 1 });
      expect(state.multiplier).toBeGreaterThan(0.5);
      expect(state.sweepsSinceChange).toBe(0);
    });

    it("a full backoff/recovery cycle with custom params reaches full rate in the expected number of steps", () => {
      // backoffFactor 0.5 (trip -> 0.5), recoveryStep 0.5, holdSweeps 1: one
      // clean sweep after the trip should recover exactly to 1.0.
      let state: ThrottleState = advanceThrottle(INITIAL_THROTTLE_STATE, tick(1, 100), {
        backoffFactor: 0.5,
      });
      expect(state.multiplier).toBeCloseTo(0.5, 10);
      state = advanceThrottle(state, CLEAN, { recoveryStep: 0.5, holdSweeps: 1 });
      expect(state.multiplier).toBeCloseTo(1, 10);
      expect(state.throttled).toBe(false);
    });
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
