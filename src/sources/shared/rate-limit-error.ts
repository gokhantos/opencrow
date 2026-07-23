/**
 * rate-limit-error.ts — shared rate-limit signal for scraper fetch paths.
 *
 * `RateLimitError` is the distinct, detectable error thrown by
 * `ssrfSafeFetch` (see ssrf-safe-fetch.ts) once a request exhausts its
 * rate-limit backoff retries. Callers can `err instanceof RateLimitError`
 * or check `err.code === "RATE_LIMITED"` to special-case throttling (e.g.
 * bail out of a sweep, surface a distinct tool error) without parsing
 * error-message strings.
 */

export class RateLimitError extends Error {
  readonly code = "RATE_LIMITED" as const;
  readonly status: number;
  readonly retryAfterMs: number | undefined;
  /**
   * Whether backing off and re-issuing this request is worthwhile. True for
   * 429/503 and 403+Retry-After (the server signalled a bounded backoff).
   * FALSE for a bare-403 recognized only via `treat403AsRateLimit`: that is
   * Apple's per-IP burst ceiling, which does NOT clear inside the retry
   * budget — retrying it wastes 4× requests on an endpoint that will 403
   * again AND stalls the caller (a 600-keyword sweep of ~20s-capped retries
   * per 403 cannot finish inside its tick). Such errors are still THROWN
   * (so callers count them and the adaptive throttle backs off batch size
   * across ticks), just never retried in-place. Default true.
   */
  readonly retryable: boolean;

  constructor(message: string, status: number, retryAfterMs?: number, retryable = true) {
    super(message);
    this.name = "RateLimitError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.retryable = retryable;
  }
}

const RATE_LIMIT_STATUSES: ReadonlySet<number> = new Set([429, 503]);

export interface RateLimitStatusOptions {
  /**
   * Treat ANY bare HTTP 403 (no `Retry-After` header) as a rate-limit
   * signal, not just 403+Retry-After. Default `false` — DO NOT flip this on
   * for a general-purpose caller: most 403s really do mean "blocked" (ToS/
   * ban/auth failure) and blindly retrying one just hammers a dead endpoint.
   *
   * Scoped opt-in for Apple's iTunes JSON endpoints (search, lookup, review
   * RSS, search-hints — see `ssrf-safe-fetch.ts`'s `treat403AsRateLimit`
   * caller doc): live traffic showed Apple enforcing its per-IP burst
   * ceiling on these endpoints with a bare 403 (no `Retry-After`), not
   * 429/503 — single requests return 200, but a sustained fetch rate got
   * 51+ 403s in a 10-minute window while the adaptive throttle (see
   * `sweep-throttle.ts`) stayed at multiplier 1.0 because those 403s never
   * matched `RATE_LIMIT_STATUSES` or the 403+Retry-After case. Every OTHER
   * `ssrfSafeFetch` caller (HN, Reddit, GitHub, news, the App Store HTML
   * product-pages lane) leaves this unset and keeps today's "bare 403 is a
   * block" behavior.
   */
  readonly treat403AsRateLimit?: boolean;
}

/**
 * Returns true if `status` indicates upstream throttling that is worth
 * backing off for. 403 counts when a `Retry-After` header is present, OR
 * (only for callers that opt in via `opts.treat403AsRateLimit`) as a bare
 * 403 with no header — see `RateLimitStatusOptions.treat403AsRateLimit`'s
 * doc comment for why that opt-in exists and is scoped, not global.
 */
export function isRateLimitStatus(
  status: number,
  retryAfterHeader: string | null,
  opts: RateLimitStatusOptions = {},
): boolean {
  if (RATE_LIMIT_STATUSES.has(status)) return true;
  if (status === 403 && retryAfterHeader !== null) return true;
  if (status === 403 && opts.treat403AsRateLimit) return true;
  return false;
}

/**
 * Whether a rate-limit response is worth RETRYING in-place (as opposed to
 * merely counting + throwing). True for 429/503 and 403+Retry-After, where
 * the server signalled a bounded backoff. False for a bare-403 recognized
 * only via `treat403AsRateLimit` — that is a burst ceiling that will not
 * clear inside the retry budget, so retrying wastes requests and stalls the
 * caller. See `RateLimitError.retryable`. Callers should only consult this
 * for statuses that already passed `isRateLimitStatus`.
 */
export function isRetryableRateLimitStatus(
  status: number,
  retryAfterHeader: string | null,
): boolean {
  if (RATE_LIMIT_STATUSES.has(status)) return true;
  if (status === 403 && retryAfterHeader !== null) return true;
  return false;
}

/**
 * Parse a `Retry-After` header value into milliseconds. Supports both the
 * delay-seconds form (`"120"`) and the HTTP-date form
 * (`"Wed, 21 Oct 2026 07:28:00 GMT"`). Returns undefined if the header is
 * missing, empty, or unparseable — callers should fall back to their own
 * backoff schedule in that case.
 */
export function parseRetryAfterMs(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  if (!trimmed) return undefined;

  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    const deltaMs = dateMs - Date.now();
    return deltaMs > 0 ? deltaMs : 0;
  }

  return undefined;
}
