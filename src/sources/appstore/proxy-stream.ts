// Pure state machinery for the SECOND, proxy-backed keyword-scan stream
// (2026-07-24 throughput pass — see `scraper.ts`'s `proxyStreamTick` and
// `keyword-gaps.ts`'s `runProxyKeywordSweep`).
//
// Background: the direct gap-sweep lane converges (via the AIMD throttle in
// `sweep-throttle.ts`) on a single IP's sustainable iTunes-JSON rate, so the
// only way to add real throughput is a SECOND request identity. A 2026-07-24
// soak of the paid Webshare pool (1,500 proxied requests to
// itunes.apple.com/search at production pacing) came back 100% HTTP 200
// across >= 5 exit subnets — but the SAME pool went scanned:0/failed:5 on the
// 2026-07-23 morning (Apple intermittently 403s datacenter exits — see
// commit 7b6b5e5's revert). Pool health is TIME-VARYING, so the proxied
// stream must be self-protective: its own AIMD throttle instance (its 403s
// must never slow the direct stream, and vice versa), plus the circuit
// breaker below, which disables the stream entirely for an exponentially
// growing cool-off once the pool looks dead (the scanned:0/failed:N
// pattern), rather than letting the throttle grind against a fully broken
// pool forever.
//
// Two exports, both I/O-free and exhaustively unit-testable
// (`proxy-stream.test.ts`):
//   - the circuit-breaker state machine (`advanceProxyBreaker` et al) —
//     caller supplies `nowMs`, no `Date.now()` here, mirroring
//     `sweep-throttle.ts`'s pure-inputs convention;
//   - the two-stream sweep partition (`createSweepPartition`) — the
//     in-process reservation registry that guarantees the direct and proxied
//     streams never scan the same keyword concurrently.

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------

/**
 * Tunables for the proxied stream's circuit breaker — sourced from
 * `appstoreKeywordGap.proxyStream.*` config (see `src/config/schema.ts`),
 * threaded in by the caller so this module stays config-free (same
 * convention as `sweep-throttle.ts`'s `ThrottleParams`).
 */
export interface ProxyBreakerParams {
  /**
   * Consecutive proxied-scan failures (403/429/network — anything
   * `scanAndRecord` counts as `failed`) with ZERO interleaved successes that
   * trip the breaker. Default 5 in config — the same magnitude as
   * `keyword-gaps.ts`'s `MAX_CONSECUTIVE_FAILURES` batch bail, i.e. the
   * live-observed scanned:0/failed:5 dead-pool signature.
   */
  readonly failureThreshold: number;
  /** Base cool-off after the FIRST trip, in ms. */
  readonly cooloffMs: number;
  /** Ceiling on the exponentially-backed-off cool-off, in ms. */
  readonly maxCooloffMs: number;
}

/**
 * Breaker state — process-local, held by `scraper.ts` across ticks exactly
 * like its `ThrottleState` (a restart resets it, which is harmless: a dead
 * pool re-trips within one sweep's `failureThreshold` failures).
 */
export interface ProxyBreakerState {
  /**
   * Proxied-scan failures accumulated across ticks since the last successful
   * scan — NOT per-tick, so a small (throttled-down) batch that fails
   * completely still reaches the threshold within a few ticks.
   */
  readonly consecutiveFailures: number;
  /**
   * Trips since the last healthy (scanned > 0) tick — drives the
   * exponential cool-off. Reset to 0 by any healthy tick.
   */
  readonly consecutiveTrips: number;
  /** Epoch-ms until which the stream is disabled, or `null` when closed. */
  readonly openUntilMs: number | null;
}

export const INITIAL_PROXY_BREAKER_STATE: ProxyBreakerState = {
  consecutiveFailures: 0,
  consecutiveTrips: 0,
  openUntilMs: null,
};

/** One proxied sweep tick's aggregate outcome, as reported by `runProxyKeywordSweep`. */
export interface ProxyStreamOutcome {
  readonly scanned: number;
  readonly failed: number;
}

/**
 * True while the breaker's cool-off window is still in the future. Once
 * `nowMs` passes `openUntilMs` the stream may run again (a half-open probe:
 * the next tick's outcome either resets the breaker on success or re-trips
 * it — at a LONGER cool-off — on continued failure).
 */
export function isProxyBreakerOpen(state: ProxyBreakerState, nowMs: number): boolean {
  return state.openUntilMs !== null && nowMs < state.openUntilMs;
}

/**
 * Cool-off for the `consecutiveTrips`-th trip (1-based): doubles per
 * consecutive trip (`cooloffMs * 2^(trips-1)`), capped at `maxCooloffMs` —
 * so a pool that keeps failing its half-open probes backs the stream off
 * exponentially instead of re-probing at a fixed cadence forever.
 */
export function computeBreakerCooloffMs(
  consecutiveTrips: number,
  params: ProxyBreakerParams,
): number {
  const trips = Math.max(1, consecutiveTrips);
  const factor = 2 ** (trips - 1);
  return Math.min(params.cooloffMs * factor, params.maxCooloffMs);
}

/**
 * Advances the breaker by one proxied sweep tick's outcome:
 *
 * - `scanned > 0` (any success at all): full reset — the pool works;
 *   isolated failures within an otherwise-working sweep are the AIMD
 *   throttle's job (`sweep-throttle.ts`), not the breaker's.
 * - `scanned === 0 && failed > 0`: accumulate. Once the accumulated run of
 *   uninterrupted failures reaches `failureThreshold`, TRIP: open the
 *   breaker for `computeBreakerCooloffMs(trips)` and reset the failure
 *   accumulator (the next probe starts a fresh count).
 * - `scanned === 0 && failed === 0` (empty/skipped tick): no evidence either
 *   way — state is returned unchanged.
 *
 * Pure: never reads the clock; `nowMs` is caller-supplied.
 */
export function advanceProxyBreaker(
  state: ProxyBreakerState,
  outcome: ProxyStreamOutcome,
  nowMs: number,
  params: ProxyBreakerParams,
): ProxyBreakerState {
  if (outcome.scanned > 0) {
    return INITIAL_PROXY_BREAKER_STATE;
  }
  if (outcome.failed <= 0) {
    return state;
  }
  const consecutiveFailures = state.consecutiveFailures + outcome.failed;
  if (consecutiveFailures >= params.failureThreshold) {
    const consecutiveTrips = state.consecutiveTrips + 1;
    return {
      consecutiveFailures: 0,
      consecutiveTrips,
      openUntilMs: nowMs + computeBreakerCooloffMs(consecutiveTrips, params),
    };
  }
  return { ...state, consecutiveFailures };
}

// ---------------------------------------------------------------------------
// Two-stream sweep partition
// ---------------------------------------------------------------------------

/**
 * A claim on a set of keywords for the duration of one sweep batch. MUST be
 * `release()`d in a `finally` once the batch completes (or throws) — an
 * unreleased claim would permanently fence its keywords off from the other
 * stream. `release()` is idempotent.
 */
export interface StreamClaim {
  /**
   * The candidates actually claimed — `claim()`'s input minus anything the
   * OTHER stream had already claimed by the time this claim ran. Scan
   * exactly this list, nothing else.
   */
  readonly keywords: readonly string[];
  readonly release: () => void;
}

/**
 * One stream's handle onto the shared partition. Usage per sweep:
 *
 *   1. `excluded()` — snapshot of the other stream's in-flight keywords,
 *      passed into the SQL selection (`getStaleKeywordsTiered` /
 *      `getStaleMinedKeywords`) so slots aren't wasted on keywords the
 *      sibling is already scanning.
 *   2. `claim(candidates)` — SYNCHRONOUS filter-and-reserve of the selected
 *      batch. Because there is no `await` between the filter and the
 *      reservation (single-threaded event loop), two streams whose
 *      selections raced each other in the DB can still never both claim the
 *      same keyword: whichever claim runs first wins it, and the later claim
 *      drops it — this post-select re-check is what makes the SQL-level
 *      exclusion (step 1, inherently a stale snapshot) safe.
 *   3. scan `claim.keywords`, then `claim.release()` in a `finally`.
 */
export interface StreamSlot {
  readonly excluded: () => readonly string[];
  readonly claim: (candidates: readonly string[]) => StreamClaim;
}

/** The two coordinated slots — see `createSweepPartition`. */
export interface SweepPartition {
  readonly direct: StreamSlot;
  readonly proxied: StreamSlot;
}

function createSlot(own: Set<string>, other: ReadonlySet<string>): StreamSlot {
  return {
    excluded: () => [...other],
    claim: (candidates) => {
      // Synchronous filter + reserve — no await between, see StreamSlot doc.
      const keywords = candidates.filter((k) => !other.has(k) && !own.has(k));
      for (const k of keywords) own.add(k);
      let released = false;
      return {
        keywords,
        release: () => {
          if (released) return;
          released = true;
          for (const k of keywords) own.delete(k);
        },
      };
    },
  };
}

/**
 * Creates the shared two-stream reservation registry. The two internal Sets
 * are mutable by design (they ARE the coordination point, like `scraper.ts`'s
 * closure-level throttle state) but fully encapsulated — nothing outside the
 * returned slots can touch them, and every public surface deals in readonly
 * snapshots/arrays.
 */
export function createSweepPartition(): SweepPartition {
  const directInFlight = new Set<string>();
  const proxiedInFlight = new Set<string>();
  return {
    direct: createSlot(directInFlight, proxiedInFlight),
    proxied: createSlot(proxiedInFlight, directInFlight),
  };
}
