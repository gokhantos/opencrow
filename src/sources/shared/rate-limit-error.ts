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

  constructor(message: string, status: number, retryAfterMs?: number) {
    super(message);
    this.name = "RateLimitError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

const RATE_LIMIT_STATUSES: ReadonlySet<number> = new Set([429, 503]);

/**
 * Returns true if `status` indicates upstream throttling that is worth
 * backing off for. 403 only counts when a `Retry-After` header is present —
 * a bare 403 usually means "blocked" (ToS/ban), not "slow down", so
 * retrying it blind would just hammer a dead endpoint.
 */
export function isRateLimitStatus(status: number, retryAfterHeader: string | null): boolean {
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
