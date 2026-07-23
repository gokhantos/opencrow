// Pure adaptive-throttle state machine for the keyword-gap sweep's scan rate
// (see `scraper.ts`'s `keywordSweepTick`, `keyword-gaps.ts`'s
// `runKeywordSweep`). Apple's tolerance for request volume — not anything
// under our control — is the real constraint on how fast this sweep can run,
// so this tracks each sweep's rate-limit (429/503) error rate and backs the
// effective rate off automatically when it spikes, recovering gradually once
// errors subside. No I/O, no Date.now() — every input (rates, prior state)
// is caller-supplied, so this is exhaustively unit-testable.
//
// This IS an AIMD (additive-increase/multiplicative-decrease) controller:
// `advanceThrottle` halves the multiplier on a real error-rate spike
// (`THROTTLE_BACKOFF_FACTOR` / `throttleBackoffFactor` config) and, once
// `THROTTLE_HOLD_SWEEPS` consecutive sweeps come back clean, steps it back up
// by `THROTTLE_RECOVERY_STEP` / `throttleRecoveryStep` (config) toward 1.0 —
// repeating until it either reaches the configured rate or trips again. The
// intent (continuous-fetch pass, 2026-07-23, once mined exploration stopped
// being paced by idle sweeps — see keyword-tiering.ts) is for the sustained
// rate to OSCILLATE just under Apple's real ceiling: back off hard on a real
// spike, then keep probing back up rather than staying permanently throttled.
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

/**
 * Multiplier applied to the current rate each time the throttle (re-)trips
 * (the "MD" of AIMD — multiplicative decrease). Default, overridable via
 * `appstoreKeywordGap.sweepRateSafety.throttleBackoffFactor`.
 */
export const THROTTLE_BACKOFF_FACTOR = 0.5;

/** Floor on the throttle multiplier — repeated trips can back off at most this far (1/8th rate), never fully stall the sweep. */
export const MIN_THROTTLE_MULTIPLIER = 0.125;

/**
 * Consecutive under-threshold sweeps required before each gradual recovery
 * step. Retuned 5 -> 3 (continuous-fetch pass, 2026-07-23): with mined
 * exploration no longer paced by idle gaps (see keyword-tiering.ts), a
 * throttled-down sweep's OWN batch is small (and therefore fast), so its
 * real-world cadence sits close to the `scanIntervalMs` floor while
 * recovering — 5 hold-sweeps at the old `THROTTLE_RECOVERY_STEP` (0.15) could
 * still take on the order of half an hour to fully recover from the floor
 * once sweeps stopped being idle-gapped; 3 hold-sweeps at the new 0.25 step
 * (see `THROTTLE_RECOVERY_STEP`) gets there in roughly a third of that.
 */
export const THROTTLE_HOLD_SWEEPS = 3;

/**
 * Multiplier gained per recovery step, once `THROTTLE_HOLD_SWEEPS` have
 * passed under threshold (the "AI" of AIMD — additive increase). Raised
 * 0.15 -> 0.25 alongside `THROTTLE_HOLD_SWEEPS`'s 5 -> 3 retune (continuous-
 * fetch pass, 2026-07-23) — see that constant's doc comment for the
 * recovery-time math. Default, overridable via
 * `appstoreKeywordGap.sweepRateSafety.throttleRecoveryStep`.
 */
export const THROTTLE_RECOVERY_STEP = 0.25;

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
 * Caller-tunable AIMD knobs for `advanceThrottle`, each defaulting to this
 * module's own constant when omitted — see
 * `appstoreKeywordGap.sweepRateSafety.throttleBackoffFactor` /
 * `throttleRecoveryStep` in `src/config/schema.ts`, the config-driven values
 * `scraper.ts` actually passes in production. `holdSweeps` stays
 * code-tunable only (not exposed as its own config knob) — see
 * `THROTTLE_HOLD_SWEEPS`'s doc comment.
 */
export interface ThrottleParams {
  /** Multiplicative-decrease factor on a trip. Defaults to `THROTTLE_BACKOFF_FACTOR`. */
  readonly backoffFactor?: number;
  /** Additive-increase step per recovery step. Defaults to `THROTTLE_RECOVERY_STEP`. */
  readonly recoveryStep?: number;
  /** Consecutive clean sweeps required per recovery step. Defaults to `THROTTLE_HOLD_SWEEPS`. */
  readonly holdSweeps?: number;
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
 * - Otherwise, while already throttled: once `holdSweeps` consecutive
 *   sweeps have stayed under threshold (a below-floor tick counts as one
 *   such sweep), take one `recoveryStep` step back toward 1.0 (clamped),
 *   resetting the hold counter; reaching exactly 1.0 clears `throttled`.
 * - Otherwise (not throttled, under threshold): just tick the hold counter.
 *
 * `params` overrides the AIMD step sizes (see `ThrottleParams`) — omitted
 * fields fall back to this module's own constants, so every existing
 * 2-arg caller (and every test written before these knobs existed) keeps
 * its exact prior behavior.
 */
export function advanceThrottle(
  state: ThrottleState,
  outcome: ThrottleOutcome,
  params: ThrottleParams = {},
): ThrottleState {
  const backoffFactor = params.backoffFactor ?? THROTTLE_BACKOFF_FACTOR;
  const recoveryStep = params.recoveryStep ?? THROTTLE_RECOVERY_STEP;
  const holdSweeps = params.holdSweeps ?? THROTTLE_HOLD_SWEEPS;
  const errorRate = computeErrorRate(outcome.rateLimitErrors, outcome.attempted);
  const canTrip = outcome.attempted >= MIN_ATTEMPTED_FOR_TRIP;

  if (canTrip && errorRate >= THROTTLE_ERROR_RATE_THRESHOLD) {
    return {
      multiplier: Math.max(MIN_THROTTLE_MULTIPLIER, state.multiplier * backoffFactor),
      sweepsSinceChange: 0,
      throttled: true,
    };
  }

  if (!state.throttled) {
    return { multiplier: 1, sweepsSinceChange: state.sweepsSinceChange + 1, throttled: false };
  }

  if (state.sweepsSinceChange + 1 < holdSweeps) {
    return { ...state, sweepsSinceChange: state.sweepsSinceChange + 1 };
  }

  const recovered = Math.min(1, state.multiplier + recoveryStep);
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
