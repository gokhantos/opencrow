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

  // Live evidence 2026-07-25: `itunes.apple.com/search` returned bare HTTP
  // 404 in a ~4-minute burst (10 scan failures 18:01-18:05Z, zero in the
  // preceding 2h); every 404'd keyword returned 200 on retry minutes later,
  // on BOTH the direct box IP and the Webshare proxy. So a 404 from THAT
  // endpoint is a transient upstream blip, not "not found" — opt-in only.
  it("treats a bare 404 as a transient (retryable) signal when treat404AsTransient is set", () => {
    expect(isRateLimitStatus(404, null, { treat404AsTransient: true })).toBe(true);
  });

  it("does NOT treat 404 as a transient signal by default (404 stays a hard 404)", () => {
    expect(isRateLimitStatus(404, null)).toBe(false);
    expect(isRateLimitStatus(404, null, {})).toBe(false);
    expect(isRateLimitStatus(404, null, { treat404AsTransient: false })).toBe(false);
    expect(isRateLimitStatus(404, null, { treat403AsRateLimit: true })).toBe(false);
  });

  it("does NOT widen any OTHER status when treat404AsTransient is set", () => {
    expect(isRateLimitStatus(200, null, { treat404AsTransient: true })).toBe(false);
    expect(isRateLimitStatus(400, null, { treat404AsTransient: true })).toBe(false);
    expect(isRateLimitStatus(403, null, { treat404AsTransient: true })).toBe(false);
    expect(isRateLimitStatus(410, null, { treat404AsTransient: true })).toBe(false);
    expect(isRateLimitStatus(500, null, { treat404AsTransient: true })).toBe(false);
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

  // Unlike the bare 403, an opted-in transient 404 IS worth retrying: the
  // SAME url returns 200 moments later (2026-07-25 evidence), so an in-band
  // bounded retry absorbs the blip instead of failing the keyword.
  it("treats an opted-in bare 404 as RETRYABLE (unlike a bare 403)", () => {
    expect(isRetryableRateLimitStatus(404, null, { treat404AsTransient: true })).toBe(true);
    // ...while the bare-403 burst ceiling stays non-retryable even then.
    expect(isRetryableRateLimitStatus(403, null, { treat404AsTransient: true })).toBe(false);
  });

  it("does NOT treat 404 as retryable without the opt-in", () => {
    expect(isRetryableRateLimitStatus(404, null)).toBe(false);
    expect(isRetryableRateLimitStatus(404, null, {})).toBe(false);
    expect(isRetryableRateLimitStatus(404, null, { treat404AsTransient: false })).toBe(false);
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
