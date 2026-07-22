// Pure adaptive-throttle state machine for the keyword-gap sweep's scan rate
// (see `scraper.ts`'s `keywordSweepTick`, `keyword-gaps.ts`'s
// `runKeywordSweep`). Apple's tolerance for request volume — not anything
// under our control — is the real constraint on how fast this sweep can run,
// so this tracks each sweep's rate-limit (429/503) error rate and backs the
// effective rate off automatically when it spikes, recovering gradually once
// errors subside. No I/O, no Date.now() — every input (rates, prior state)
// is caller-supplied, so this is exhaustively unit-testable.
//
// The scraper process holds ONE `ThrottleState` in memory across sweeps
// (like `lastScreenerRunAt` in `scraper.ts`) — process-local, not persisted;
// a restart simply resets to `INITIAL_THROTTLE_STATE`, which is harmless
// (worst case: one sweep's-worth of unthrottled rate before the state machine
// re-detects a real problem).

/** A sweep whose rate-limit error rate is at or above this fraction trips the throttle-down. */
export const THROTTLE_ERROR_RATE_THRESHOLD = 0.05; // ~5%

/**
 * Minimum requests a tick must have ATTEMPTED before its error rate is
 * allowed to TRIP the throttle-down (B1 fix). Without this gate a lane that
 * attempted a single request and hit one 429 yields `errorRate === 1.0` and
 * instantly halves the SHARED multiplier for every lane — including the main
 * SERP sweep — on one anecdotal failure. Below this floor a tick can never
 * trip (it may still count toward recovery, treated as an under-threshold
 * sweep). Set alongside end-of-tick aggregation in `scraper.ts`, which sums
 * every lane's `(rateLimitErrors, attempted)` into ONE `advanceThrottle`
 * call per tick, so `attempted` here is the whole tick's real request volume,
 * not a single low-volume lane's.
 */
export const MIN_ATTEMPTED_FOR_TRIP = 8;

/** Multiplier applied to the current rate each time the throttle (re-)trips. */
export const THROTTLE_BACKOFF_FACTOR = 0.5;

/** Floor on the throttle multiplier — repeated trips can back off at most this far (1/8th rate), never fully stall the sweep. */
export const MIN_THROTTLE_MULTIPLIER = 0.125;

/** Consecutive under-threshold sweeps required before each gradual recovery step. */
export const THROTTLE_HOLD_SWEEPS = 5;

/** Multiplier gained per recovery step, once `THROTTLE_HOLD_SWEEPS` have passed under threshold. */
export const THROTTLE_RECOVERY_STEP = 0.15;

/**
 * Pre-throughput-bump rate, used by the MANDATORY hard kill-switch
 * (`appstoreKeywordGap.sweepRateSafety.legacyRateOverride`) to revert
 * instantly and unambiguously, bypassing the adaptive throttle and the
 * configured `keywordsPerSweep` / `sweepDelayMs` entirely.
 */
export const LEGACY_KEYWORDS_PER_SWEEP = 25;
export const LEGACY_SWEEP_DELAY_MS = 2_000;

export interface ThrottleState {
  /** Current rate multiplier, `MIN_THROTTLE_MULTIPLIER <= multiplier <= 1`. */
  readonly multiplier: number;
  /** Consecutive sweeps since the multiplier last changed — gates recovery steps. */
  readonly sweepsSinceChange: number;
  /** True iff presently backed off (`multiplier < 1`). */
  readonly throttled: boolean;
}

export const INITIAL_THROTTLE_STATE: ThrottleState = {
  multiplier: 1,
  sweepsSinceChange: 0,
  throttled: false,
};

/**
 * One sweep's rate-limit error rate: `rateLimitErrors / attempted`. An empty
 * sweep (`attempted <= 0` — e.g. skipped on the daily budget) is not
 * evidence of throttling, so it reads as 0 rather than `NaN`.
 */
export function computeErrorRate(rateLimitErrors: number, attempted: number): number {
  if (attempted <= 0) return 0;
  return rateLimitErrors / attempted;
}

/**
 * One tick's aggregated Apple-endpoint outcome — the SUMMED rate-limit errors
 * and attempted requests across every lane on that tick (see `scraper.ts`'s
 * per-tick accumulator). `advanceThrottle` derives the error rate from these
 * so the rate is weighted by real request volume, and gates the trip on the
 * total `attempted` (see `MIN_ATTEMPTED_FOR_TRIP`).
 */
export interface ThrottleOutcome {
  readonly rateLimitErrors: number;
  readonly attempted: number;
}

/**
 * Advances the throttle state machine by one tick's aggregated outcome.
 *
 * - `attempted >= MIN_ATTEMPTED_FOR_TRIP` AND
 *   `errorRate >= THROTTLE_ERROR_RATE_THRESHOLD`: (re-)trip — halve the
 *   CURRENT multiplier (so repeated trips keep backing off further, floored
 *   at `MIN_THROTTLE_MULTIPLIER`) and reset the hold counter. Below the
 *   min-attempted floor a tick can NEVER trip, however high its ratio — a
 *   one-request 429 is anecdote, not signal.
 * - Otherwise, while already throttled: once `THROTTLE_HOLD_SWEEPS`
 *   consecutive sweeps have stayed under threshold (a below-floor tick counts
 *   as one such sweep), take one `THROTTLE_RECOVERY_STEP` step back toward
 *   1.0 (clamped), resetting the hold counter; reaching exactly 1.0 clears
 *   `throttled`.
 * - Otherwise (not throttled, under threshold): just tick the hold counter.
 */
export function advanceThrottle(state: ThrottleState, outcome: ThrottleOutcome): ThrottleState {
  const errorRate = computeErrorRate(outcome.rateLimitErrors, outcome.attempted);
  const canTrip = outcome.attempted >= MIN_ATTEMPTED_FOR_TRIP;

  if (canTrip && errorRate >= THROTTLE_ERROR_RATE_THRESHOLD) {
    return {
      multiplier: Math.max(MIN_THROTTLE_MULTIPLIER, state.multiplier * THROTTLE_BACKOFF_FACTOR),
      sweepsSinceChange: 0,
      throttled: true,
    };
  }

  if (!state.throttled) {
    return { multiplier: 1, sweepsSinceChange: state.sweepsSinceChange + 1, throttled: false };
  }

  if (state.sweepsSinceChange + 1 < THROTTLE_HOLD_SWEEPS) {
    return { ...state, sweepsSinceChange: state.sweepsSinceChange + 1 };
  }

  const recovered = Math.min(1, state.multiplier + THROTTLE_RECOVERY_STEP);
  return { multiplier: recovered, sweepsSinceChange: 0, throttled: recovered < 1 };
}

export interface EffectiveSweepRate {
  readonly keywordsPerSweep: number;
  readonly delayMs: number;
}

/**
 * Resolves the ACTUAL batch size + inter-request delay a sweep should use
 * this cycle, given the configured rate, the current throttle multiplier,
 * and the hard kill-switch. `legacyRateOverride` wins unconditionally — it
 * bypasses both the configured rate and the throttle multiplier. Otherwise
 * the multiplier scales `configuredKeywordsPerSweep` down (floored, minimum
 * 1) — the throttle only ever shrinks the BATCH SIZE (fewer requests per
 * sweep), never the per-request delay, since fewer requests is the more
 * direct lever against a volume-based rate limit.
 */
export function computeEffectiveSweepRate(opts: {
  readonly configuredKeywordsPerSweep: number;
  readonly configuredDelayMs: number;
  readonly legacyRateOverride: boolean;
  readonly throttleMultiplier: number;
}): EffectiveSweepRate {
  if (opts.legacyRateOverride) {
    return { keywordsPerSweep: LEGACY_KEYWORDS_PER_SWEEP, delayMs: LEGACY_SWEEP_DELAY_MS };
  }
  return {
    keywordsPerSweep: Math.max(
      1,
      Math.floor(opts.configuredKeywordsPerSweep * opts.throttleMultiplier),
    ),
    delayMs: opts.configuredDelayMs,
  };
}
