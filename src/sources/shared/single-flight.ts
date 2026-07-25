/**
 * single-flight.ts — self-healing single-flight guard for scraper lanes.
 *
 * Every scraper lane is guarded by a plain `let xRunning = false` set before
 * the work and cleared in a `finally`. That is correct only while the work
 * always settles. When it doesn't — see `lane-deadline.ts`'s incident log for
 * the two 2026-07-24/25 hangs — the `finally` never runs, the flag stays true
 * forever, and every subsequent tick silently skips. The lane is then dead
 * until someone notices and restarts the process. Both times, the only
 * external symptom was a periodic "already running, skipping" line at INFO
 * level and a table that quietly stopped receiving rows.
 *
 * `createSingleFlight` keeps the mutual exclusion but adds a stale-claim
 * escape hatch: a claim older than `maxDurationMs` is treated as abandoned,
 * reported LOUDLY via `onStaleRelease`, and superseded by the new run. The
 * lane recovers on its own cadence instead of waiting for a human.
 *
 * Generation guard: the abandoned run may still be pending and WILL eventually
 * hit its own `finally`. Each run captures a generation number and clears the
 * active claim only if it still owns it, so a zombie that settles an hour
 * later can never release the lock held by the live run. This is what makes
 * "abandon and supersede" safe.
 *
 * What this does NOT do: it cannot cancel the abandoned work, so a superseded
 * run keeps whatever socket/connection it was stuck on. Pair it with
 * `withLaneDeadline` on the individual awaits — the deadline stops most hangs
 * at the source, this guard is the backstop for the ones it misses.
 *
 * Pure inputs (`now` is injectable) so the whole state machine is unit-
 * testable without timers, mirroring `sweep-throttle.ts` / `proxy-stream.ts`.
 */

export interface SingleFlight {
  /**
   * Runs `fn` unless a claim is already active and still within budget, in
   * which case the tick is skipped and `undefined` is returned. A claim past
   * `maxDurationMs` is abandoned and superseded.
   */
  readonly run: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
  /** True while a claim is held (including a stale one not yet superseded). */
  readonly isRunning: () => boolean;
}

export interface SingleFlightOptions {
  /** Stable lane identifier for logs (e.g. "appstore:hourly-tick"). */
  readonly label: string;
  /**
   * Wall-clock budget after which an in-flight claim is considered abandoned.
   * Set well ABOVE the lane's worst legitimate runtime — superseding a lane
   * that is merely slow would run it twice concurrently.
   */
  readonly maxDurationMs: number;
  /** Injectable clock for tests. */
  readonly now?: () => number;
  /** Called when a tick is skipped because a healthy claim is in flight. */
  readonly onSkip?: (elapsedMs: number) => void;
  /** Called when a stale claim is abandoned — log this loudly. */
  readonly onStaleRelease?: (elapsedMs: number) => void;
}

export function createSingleFlight(opts: SingleFlightOptions): SingleFlight {
  const now = opts.now ?? (() => Date.now());
  let generation = 0;
  let active: { readonly generation: number; readonly startedAtMs: number } | null = null;

  return {
    isRunning: () => active !== null,

    async run<T>(fn: () => Promise<T>): Promise<T | undefined> {
      if (active !== null) {
        const elapsedMs = now() - active.startedAtMs;
        if (elapsedMs < opts.maxDurationMs) {
          opts.onSkip?.(elapsedMs);
          return undefined;
        }
        // Past budget: the previous run is presumed wedged. Abandon its claim
        // (its own `finally` is now a no-op thanks to the generation guard)
        // and let this tick proceed.
        opts.onStaleRelease?.(elapsedMs);
      }

      const myGeneration = generation + 1;
      generation = myGeneration;
      active = { generation: myGeneration, startedAtMs: now() };

      try {
        return await fn();
      } finally {
        // Only the owner clears — a superseded zombie must not release the
        // live run's claim.
        if (active?.generation === myGeneration) {
          active = null;
        }
      }
    },
  };
}
