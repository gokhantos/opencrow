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

  try {
    return await fetch(url, { ...rest, signal });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw new Error(`Fetch failed for ${url}: ${getErrorMessage(err)}`);
  }
}
