import { describe, expect, it } from "bun:test";
import {
  RateLimitError,
  isRateLimitStatus,
  isRetryableRateLimitStatus,
  parseRetryAfterMs,
} from "./rate-limit-error";

describe("isRateLimitStatus", () => {
  it("treats 429 as rate-limited regardless of Retry-After", () => {
    expect(isRateLimitStatus(429, null)).toBe(true);
    expect(isRateLimitStatus(429, "5")).toBe(true);
  });

  it("treats 503 as rate-limited regardless of Retry-After", () => {
    expect(isRateLimitStatus(503, null)).toBe(true);
    expect(isRateLimitStatus(503, "5")).toBe(true);
  });

  it("treats 403 WITH a Retry-After header as rate-limited by default", () => {
    expect(isRateLimitStatus(403, "5")).toBe(true);
  });

  it("does NOT treat a bare 403 (no Retry-After) as rate-limited by default", () => {
    expect(isRateLimitStatus(403, null)).toBe(false);
    expect(isRateLimitStatus(403, null, {})).toBe(false);
    expect(isRateLimitStatus(403, null, { treat403AsRateLimit: false })).toBe(false);
  });

  it("does NOT treat other statuses as rate-limited, even with treat403AsRateLimit set", () => {
    expect(isRateLimitStatus(200, null, { treat403AsRateLimit: true })).toBe(false);
    expect(isRateLimitStatus(404, null, { treat403AsRateLimit: true })).toBe(false);
    expect(isRateLimitStatus(500, null, { treat403AsRateLimit: true })).toBe(false);
    expect(isRateLimitStatus(401, null, { treat403AsRateLimit: true })).toBe(false);
  });

  // The gap this fix closes: Apple's iTunes JSON endpoints burst-throttle
  // with a bare 403 and never send Retry-After — a scoped caller opts in via
  // treat403AsRateLimit to have that recognized as a rate-limit signal.
  it("treats a bare 403 (no Retry-After) as rate-limited when treat403AsRateLimit is set", () => {
    expect(isRateLimitStatus(403, null, { treat403AsRateLimit: true })).toBe(true);
  });

  it("still treats 403+Retry-After as rate-limited when treat403AsRateLimit is also set", () => {
    expect(isRateLimitStatus(403, "5", { treat403AsRateLimit: true })).toBe(true);
  });
});

describe("isRetryableRateLimitStatus", () => {
  it("treats 429 and 503 as retryable (server-signalled bounded backoff)", () => {
    expect(isRetryableRateLimitStatus(429, null)).toBe(true);
    expect(isRetryableRateLimitStatus(503, null)).toBe(true);
  });

  it("treats 403 WITH a Retry-After header as retryable", () => {
    expect(isRetryableRateLimitStatus(403, "5")).toBe(true);
  });

  // The core of this fix: a bare 403 (Apple's per-IP burst ceiling) is a
  // rate-limit signal worth COUNTING but not worth RETRYING — retrying it
  // wastes requests on an endpoint that will 403 again and stalls the sweep.
  it("does NOT treat a bare 403 (no Retry-After) as retryable", () => {
    expect(isRetryableRateLimitStatus(403, null)).toBe(false);
  });

  it("does NOT treat non-rate-limit statuses as retryable", () => {
    expect(isRetryableRateLimitStatus(200, null)).toBe(false);
    expect(isRetryableRateLimitStatus(500, null)).toBe(false);
  });
});

describe("parseRetryAfterMs", () => {
  it("returns undefined for a missing header", () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
  });

  it("returns undefined for an empty header", () => {
    expect(parseRetryAfterMs("")).toBeUndefined();
    expect(parseRetryAfterMs("   ")).toBeUndefined();
  });

  it("parses the delay-seconds form", () => {
    expect(parseRetryAfterMs("5")).toBe(5000);
    expect(parseRetryAfterMs("0")).toBe(0);
  });

  it("returns undefined for an unparseable header", () => {
    expect(parseRetryAfterMs("not-a-date-or-number")).toBeUndefined();
  });
});

describe("RateLimitError", () => {
  it("carries status, retryAfterMs, and a fixed RATE_LIMITED code", () => {
    const err = new RateLimitError("rate limited", 403, 1500);
    expect(err.code).toBe("RATE_LIMITED");
    expect(err.status).toBe(403);
    expect(err.retryAfterMs).toBe(1500);
    expect(err).toBeInstanceOf(Error);
  });

  it("allows an undefined retryAfterMs", () => {
    const err = new RateLimitError("rate limited", 429);
    expect(err.retryAfterMs).toBeUndefined();
  });

  it("defaults retryable to true (preserves 429/503 backoff behavior)", () => {
    expect(new RateLimitError("rate limited", 429).retryable).toBe(true);
  });

  it("carries an explicit retryable=false for bare-403 burst signals", () => {
    const err = new RateLimitError("rate limited", 403, undefined, false);
    expect(err.retryable).toBe(false);
    expect(err.status).toBe(403);
  });
});
