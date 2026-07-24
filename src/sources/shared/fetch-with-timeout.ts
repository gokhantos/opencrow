/**
 * Centralized fetch wrapper that enforces a request timeout.
 *
 * Wraps the global `fetch` with `AbortSignal.timeout(timeoutMs)` so that a
 * wedged or slow upstream can never stall a scraper indefinitely. Any
 * caller-provided `signal` is merged with the timeout signal so both an
 * explicit abort and the timeout will cancel the request.
 *
 * Mirrors the pattern already used by the GitHub trending scraper.
 *
 * `opts` additionally accepts a Bun-specific `proxy` string (a full
 * `http://user:pass@host:port` URL) — not part of the standard `RequestInit`
 * lib type, but Bun's native `fetch()` reads it directly (verified against
 * Bun's docs: `fetch(url, { proxy: "http://..." })`). Forwarded straight
 * through to the underlying `fetch` call via the `...rest` spread below, so
 * this module stays a dumb pass-through with zero proxy-resolution logic of
 * its own — see `src/sources/shared/appstore-proxy.ts` for resolution and
 * `ssrf-safe-fetch.ts`'s `useProxy` option for how callers opt in per-lane.
 */

import { getErrorMessage } from "../../lib/error-serialization";

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Grace period, ADDED to `timeoutMs`, after which the request is force-settled
 * even if the underlying `fetch` promise has neither resolved nor rejected —
 * the hard-deadline backstop (see `fetchWithTimeout`). `AbortSignal.timeout`
 * remains the PRIMARY cancellation path (it lets the runtime tear the socket
 * down); this backstop only fires in the pathological case where the fetch
 * promise never settles even after its abort signal has fired — e.g. a wedged
 * proxied socket that outlives the abort. On a healthy timeout the abort-driven
 * rejection lands at ~`timeoutMs` and wins the race, so this grace governs ONLY
 * the never-settles case. Small on purpose: large enough to absorb event-loop
 * congestion between "abort fires" and "fetch rejects" (observed ~1-2ms on Bun
 * 1.3.14), far short of any sweep's per-pass wall-clock budget.
 *
 * WHY THIS EXISTS: every App Store keyword scan — direct AND proxied lane —
 * awaits exactly one `fetch` here. The sweep loop's wall-clock bail is only
 * checked BETWEEN keywords (see `keyword-gaps.ts`'s `MAX_PASS_DURATION_MS`
 * guard at the top of the batch loop), and the sweep's single-flight lock (see
 * `scraper.ts`'s `keywordSweepRunning` / `proxyStreamRunning`) is released in a
 * `finally` that only runs once the sweep returns — so a single `await fetch`
 * that never settles wedges the ENTIRE lock forever, and no per-request timeout
 * or per-pass bail can rescue it. This hard bound guarantees `fetchWithTimeout`
 * always settles within `timeoutMs + HARD_DEADLINE_GRACE_MS`, so a hung request
 * on either lane can never hold the lock indefinitely.
 */
export const HARD_DEADLINE_GRACE_MS = 2_000;

/**
 * Thrown when the hard-deadline backstop fires (the underlying `fetch` failed
 * to settle even after `timeoutMs + HARD_DEADLINE_GRACE_MS`). Distinct from a
 * normal `TimeoutError` so callers/tests can tell the abort-honored path from
 * the never-settles path. The abandoned `fetch` promise is intentionally left
 * unawaited — it never settles, so it can never surface an unhandled rejection.
 */
export class HardDeadlineError extends Error {
  constructor(url: string, deadlineMs: number) {
    super(`Request exceeded hard deadline of ${deadlineMs}ms (fetch never settled after abort): ${url}`);
    this.name = "HardDeadlineError";
  }
}

/** `RequestInit` plus Bun's `proxy` fetch extension (see module doc above). */
export type FetchWithTimeoutInit = RequestInit & { readonly proxy?: string };

/**
 * Combine the timeout signal with an optional caller-provided signal.
 *
 * Uses `AbortSignal.any` when available; otherwise falls back to the
 * timeout signal alone (still guaranteeing the timeout guard).
 */
function mergeSignals(
  timeoutMs: number,
  callerSignal?: AbortSignal | null,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!callerSignal) return timeoutSignal;

  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any([timeoutSignal, callerSignal]);
  }

  return timeoutSignal;
}

/**
 * `fetch` with a hard timeout.
 *
 * @param url        Request URL.
 * @param opts       Standard `RequestInit`. Any `signal` is merged with the
 *                   timeout signal rather than overriding it.
 * @param timeoutMs  Abort the request after this many milliseconds.
 * @throws Error with a clear message on timeout or network failure.
 */
export async function fetchWithTimeout(
  url: string,
  opts: FetchWithTimeoutInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  const { signal: callerSignal, ...rest } = opts;
  const signal = mergeSignals(timeoutMs, callerSignal);

  // Hard-deadline backstop: `AbortSignal.timeout` (above) is the primary
  // cancellation, but a wedged socket can, in principle, leave the `fetch`
  // promise pending even after the abort has fired — which would hang the
  // caller's sweep loop and never release its single-flight lock. Racing the
  // fetch against a wall-clock deadline guarantees this function ALWAYS settles
  // within `timeoutMs + HARD_DEADLINE_GRACE_MS`. See `HARD_DEADLINE_GRACE_MS`.
  const deadlineMs = timeoutMs + HARD_DEADLINE_GRACE_MS;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const hardDeadline = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(() => reject(new HardDeadlineError(url, deadlineMs)), deadlineMs);
  });

  try {
    return await Promise.race([fetch(url, { ...rest, signal }), hardDeadline]);
  } catch (err) {
    if (err instanceof HardDeadlineError) {
      throw err;
    }
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw new Error(`Fetch failed for ${url}: ${getErrorMessage(err)}`);
  } finally {
    // Clear the backstop timer on the normal path so it never keeps the event
    // loop alive (harmless if it already fired).
    if (deadlineTimer) clearTimeout(deadlineTimer);
  }
}
