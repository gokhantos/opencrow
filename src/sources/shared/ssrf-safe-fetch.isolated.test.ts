import { describe, expect, it, mock, beforeEach } from "bun:test";

// ---------------------------------------------------------------------------
// Isolated tests for ssrfSafeFetch — mocks fetch via mock.module so this file
// MUST use the *.isolated.test.ts suffix (runs in its own process).
// ---------------------------------------------------------------------------

// We mock the fetch-with-timeout module so no real network calls are made.
const mockFetchWithTimeout = mock(
  async (_url: string, _opts: RequestInit, _timeout: number): Promise<Response> => {
    throw new Error("not configured");
  },
);

mock.module("./fetch-with-timeout", () => ({
  fetchWithTimeout: mockFetchWithTimeout,
}));

// Proxy-seam mock (throughput wave item 1): `ssrfSafeFetch`'s `useProxy`
// option resolves through `appstore-proxy.ts`'s `getAppstoreProxyUrl` —
// mocked here so this file's proxy tests are fully deterministic and never
// touch the real DB/env/secrets machinery (no real proxy calls in CI).
// Defaults to "unconfigured" (undefined); individual tests override via
// `mockGetAppstoreProxyUrl.mockImplementationOnce(...)`.
const mockGetAppstoreProxyUrl = mock(async (): Promise<string | undefined> => undefined);

mock.module("./appstore-proxy", () => ({
  getAppstoreProxyUrl: mockGetAppstoreProxyUrl,
}));

// Import AFTER mock.module so the mocks are already in place.
const { ssrfSafeFetch, RateLimitError } = await import("./ssrf-safe-fetch");

function makeResponse(
  status: number,
  headers: Record<string, string> = {},
  body = "",
): Response {
  return new Response(body, { status, headers });
}

beforeEach(() => {
  mockFetchWithTimeout.mockReset();
  mockGetAppstoreProxyUrl.mockReset();
  mockGetAppstoreProxyUrl.mockImplementation(async () => undefined);
});

describe("ssrfSafeFetch", () => {
  it("throws immediately on private-IP URL", async () => {
    await expect(ssrfSafeFetch("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(
      "SSRF blocked",
    );
    expect(mockFetchWithTimeout).not.toHaveBeenCalled();
  });

  it("throws immediately on localhost URL", async () => {
    await expect(ssrfSafeFetch("http://localhost/admin")).rejects.toThrow("SSRF blocked");
    expect(mockFetchWithTimeout).not.toHaveBeenCalled();
  });

  it("throws immediately on non-http scheme", async () => {
    await expect(ssrfSafeFetch("file:///etc/passwd")).rejects.toThrow("SSRF blocked");
    expect(mockFetchWithTimeout).not.toHaveBeenCalled();
  });

  it("returns response on 200 from a public URL", async () => {
    mockFetchWithTimeout.mockImplementationOnce(async () => makeResponse(200, {}, "hello"));
    const res = await ssrfSafeFetch("https://example.com/");
    expect(res.status).toBe(200);
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it("follows a redirect to a public URL", async () => {
    // First call: 302 redirect to another public URL
    mockFetchWithTimeout.mockImplementationOnce(async () =>
      makeResponse(302, { location: "https://cdn.example.com/page" }),
    );
    // Second call: 200 OK
    mockFetchWithTimeout.mockImplementationOnce(async () => makeResponse(200, {}, "content"));

    const res = await ssrfSafeFetch("https://example.com/redirect");
    expect(res.status).toBe(200);
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(2);
  });

  it("blocks a redirect that leads to a private IP", async () => {
    // First call: 301 redirect to a private/metadata IP
    mockFetchWithTimeout.mockImplementationOnce(async () =>
      makeResponse(301, { location: "http://169.254.169.254/latest/meta-data/" }),
    );

    await expect(ssrfSafeFetch("https://example.com/evil-redirect")).rejects.toThrow(
      "SSRF blocked",
    );
    // fetch was called once for the initial URL, then redirect is blocked
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it("blocks a redirect that leads to localhost", async () => {
    mockFetchWithTimeout.mockImplementationOnce(async () =>
      makeResponse(302, { location: "http://localhost:8080/internal" }),
    );
    await expect(ssrfSafeFetch("https://example.com/bounce")).rejects.toThrow("SSRF blocked");
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it("throws after too many redirects", async () => {
    // Always return a 302 pointing back to the same URL
    mockFetchWithTimeout.mockImplementation(async () =>
      makeResponse(302, { location: "https://example.com/loop" }),
    );
    await expect(ssrfSafeFetch("https://example.com/loop")).rejects.toThrow(
      "Too many redirects",
    );
  });

  it("blocks a redirect to a 10.x private range", async () => {
    mockFetchWithTimeout.mockImplementationOnce(async () =>
      makeResponse(301, { location: "http://10.0.0.1/internal" }),
    );
    await expect(ssrfSafeFetch("https://example.com/evil")).rejects.toThrow("SSRF blocked");
  });

  it("resolves relative redirect URLs correctly", async () => {
    // Relative redirect Location header
    mockFetchWithTimeout.mockImplementationOnce(async () =>
      makeResponse(302, { location: "/other-page" }),
    );
    mockFetchWithTimeout.mockImplementationOnce(async () => makeResponse(200, {}, "final"));

    const res = await ssrfSafeFetch("https://example.com/start");
    expect(res.status).toBe(200);
    // Second call should be to https://example.com/other-page
    const secondCallUrl = mockFetchWithTimeout.mock.calls[1]?.[0];
    expect(secondCallUrl).toBe("https://example.com/other-page");
  });

  it("handles redirect with missing Location header gracefully", async () => {
    // 302 with no Location — treat as final response
    mockFetchWithTimeout.mockImplementationOnce(async () => makeResponse(302, {}));
    const res = await ssrfSafeFetch("https://example.com/");
    expect(res.status).toBe(302);
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it("throws when fetch itself throws", async () => {
    mockFetchWithTimeout.mockImplementationOnce(async () => {
      throw new Error("network error");
    });
    await expect(ssrfSafeFetch("https://example.com/")).rejects.toThrow("Fetch error");
  });

  it("passes custom timeoutMs to fetchWithTimeout", async () => {
    mockFetchWithTimeout.mockImplementationOnce(async () => makeResponse(200));
    await ssrfSafeFetch("https://example.com/", { timeoutMs: 5000 });
    expect(mockFetchWithTimeout.mock.calls[0]?.[2]).toBe(5000);
  });

  it("passes custom headers to fetchWithTimeout", async () => {
    mockFetchWithTimeout.mockImplementationOnce(async () => makeResponse(200));
    await ssrfSafeFetch("https://example.com/", { headers: { "x-test": "yes" } });
    const opts = mockFetchWithTimeout.mock.calls[0]?.[1] as RequestInit;
    expect((opts.headers as Record<string, string>)?.["x-test"]).toBe("yes");
  });

  it("uses redirect:manual so browser-level redirects are not auto-followed", async () => {
    mockFetchWithTimeout.mockImplementationOnce(async () => makeResponse(200));
    await ssrfSafeFetch("https://example.com/");
    const opts = mockFetchWithTimeout.mock.calls[0]?.[1] as RequestInit;
    expect(opts.redirect).toBe("manual");
  });
});

// ---------------------------------------------------------------------------
// Rate-limit-aware retry (opt-in via retryOnRateLimit). Delay bounds are set
// to a few ms via minDelayMs/maxDelayMs so these tests exercise the real
// retry/backoff code path without actually sleeping for seconds.
// ---------------------------------------------------------------------------
describe("ssrfSafeFetch rate-limit retry", () => {
  const FAST_RETRY_OPTS = { retryOnRateLimit: true, minDelayMs: 1, maxDelayMs: 5 } as const;

  it("does NOT retry on 429 when retryOnRateLimit is not set (default-unchanged path)", async () => {
    mockFetchWithTimeout.mockImplementationOnce(async () => makeResponse(429, {}));
    const res = await ssrfSafeFetch("https://example.com/search");
    expect(res.status).toBe(429);
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 with Retry-After and succeeds once the upstream recovers", async () => {
    mockFetchWithTimeout
      .mockImplementationOnce(async () => makeResponse(429, { "retry-after": "0" }))
      .mockImplementationOnce(async () => makeResponse(200, {}, "ok"));

    const res = await ssrfSafeFetch("https://example.com/search", FAST_RETRY_OPTS);

    expect(res.status).toBe(200);
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(2);
  });

  it("retries on 503 (no Retry-After header) using computed backoff", async () => {
    mockFetchWithTimeout
      .mockImplementationOnce(async () => makeResponse(503, {}))
      .mockImplementationOnce(async () => makeResponse(200, {}, "ok"));

    const res = await ssrfSafeFetch("https://example.com/search", FAST_RETRY_OPTS);

    expect(res.status).toBe(200);
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a bare 403 (no Retry-After) — treated as a block, not throttling", async () => {
    mockFetchWithTimeout.mockImplementationOnce(async () => makeResponse(403, {}));
    const res = await ssrfSafeFetch("https://example.com/search", FAST_RETRY_OPTS);
    expect(res.status).toBe(403);
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it("retries a 403 WITH a Retry-After header (throttling signal)", async () => {
    mockFetchWithTimeout
      .mockImplementationOnce(async () => makeResponse(403, { "retry-after": "0" }))
      .mockImplementationOnce(async () => makeResponse(200, {}, "ok"));

    const res = await ssrfSafeFetch("https://example.com/search", FAST_RETRY_OPTS);

    expect(res.status).toBe(200);
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(2);
  });

  // The gap this fix closes: Apple's iTunes JSON endpoints (search, lookup,
  // review RSS, search-hints) burst-throttle with a bare 403 and never send
  // Retry-After, so those callers opt in via `treat403AsRateLimit: true` —
  // see rate-limit-error.ts's `RateLimitStatusOptions.treat403AsRateLimit`.
  it("does NOT retry a bare 403 when treat403AsRateLimit is unset — unchanged default", async () => {
    mockFetchWithTimeout.mockImplementationOnce(async () => makeResponse(403, {}));
    const res = await ssrfSafeFetch("https://example.com/search", {
      ...FAST_RETRY_OPTS,
      treat403AsRateLimit: false,
    });
    expect(res.status).toBe(403);
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  // A bare 403 recognized via treat403AsRateLimit is Apple's per-IP burst
  // ceiling: worth COUNTING (thrown as RateLimitError so the sweep tallies it
  // and the adaptive throttle backs off batch size across ticks) but NOT
  // worth RETRYING — retrying wastes 4× requests on an endpoint that will 403
  // again and stalls a 600-keyword sweep. So it throws IMMEDIATELY, no retry.
  it("throws RateLimitError immediately (no retry) on a bare 403 when treat403AsRateLimit is set", async () => {
    mockFetchWithTimeout.mockImplementation(async () => makeResponse(403, {}));

    const err = await ssrfSafeFetch("https://example.com/search", {
      ...FAST_RETRY_OPTS,
      treat403AsRateLimit: true,
      maxRetries: 3,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as InstanceType<typeof RateLimitError>).code).toBe("RATE_LIMITED");
    expect((err as InstanceType<typeof RateLimitError>).status).toBe(403);
    expect((err as InstanceType<typeof RateLimitError>).retryable).toBe(false);
    // Fast-failed after a single fetch despite maxRetries: 3 — never retried.
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it("throws a distinct RateLimitError once retries are exhausted", async () => {
    mockFetchWithTimeout.mockImplementation(async () => makeResponse(429, { "retry-after": "0" }));

    const err = await ssrfSafeFetch("https://example.com/search", {
      ...FAST_RETRY_OPTS,
      maxRetries: 2,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as InstanceType<typeof RateLimitError>).code).toBe("RATE_LIMITED");
    expect((err as InstanceType<typeof RateLimitError>).status).toBe(429);
    // initial try + 2 retries = 3 calls
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(3);
  });

  it("stops retrying once cumulative backoff wait would exceed maxTotalWaitMs", async () => {
    mockFetchWithTimeout.mockImplementation(async () => makeResponse(429, {}));

    const err = await ssrfSafeFetch("https://example.com/search", {
      retryOnRateLimit: true,
      minDelayMs: 5,
      maxDelayMs: 5,
      maxTotalWaitMs: 8,
      maxRetries: 10,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RateLimitError);
    // 5ms + 5ms = 10ms > 8ms budget, so the 3rd attempt's retry is refused.
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(3);
  });

  it("does not retry a plain network error, even with retryOnRateLimit set", async () => {
    mockFetchWithTimeout.mockImplementationOnce(async () => {
      throw new Error("ECONNRESET");
    });

    await expect(
      ssrfSafeFetch("https://example.com/search", FAST_RETRY_OPTS),
    ).rejects.toThrow("Fetch error");
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it("still blocks a private-IP URL immediately with retryOnRateLimit set (SSRF guard intact)", async () => {
    await expect(
      ssrfSafeFetch("http://169.254.169.254/latest/meta-data/", FAST_RETRY_OPTS),
    ).rejects.toThrow("SSRF blocked");
    expect(mockFetchWithTimeout).not.toHaveBeenCalled();
  });

  it("still blocks a redirect to a private IP even with retryOnRateLimit set", async () => {
    mockFetchWithTimeout.mockImplementationOnce(async () =>
      makeResponse(302, { location: "http://169.254.169.254/latest/meta-data/" }),
    );
    await expect(
      ssrfSafeFetch("https://example.com/bounce", FAST_RETRY_OPTS),
    ).rejects.toThrow("SSRF blocked");
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Transient-404 retry (opt-in via treat404AsTransient), 2026-07-25.
//
// Live evidence: `itunes.apple.com/search` returned bare HTTP 404 in a
// ~4-minute burst (10 production scan failures between 18:01-18:05Z, zero in
// the preceding two hours). Every keyword that 404'd returned 200 on retry
// minutes later, on BOTH the direct box IP and through the Webshare proxy —
// so the 404 was upstream-Apple flapping, not "no such resource". Before
// this option existed a 404 fell through `isRateLimitStatus` entirely, so
// `fetchTopApps` threw `HTTP 404`, the sweep logged "Keyword scan failed" and
// five in a row tripped `MAX_CONSECUTIVE_FAILURES`, throwing away the whole
// remaining pass. It is OPT-IN because a 404 legitimately means "gone" for
// other callers (e.g. `app-pages.ts` maps 404 -> `recordPageGone`).
// ---------------------------------------------------------------------------
describe("ssrfSafeFetch transient-404 retry (treat404AsTransient)", () => {
  const FAST_RETRY_OPTS = { retryOnRateLimit: true, minDelayMs: 1, maxDelayMs: 5 } as const;

  // The crux: a 404-then-200 sequence must be absorbed in-band.
  it("retries a bare 404 and returns the 200 once the upstream recovers", async () => {
    mockFetchWithTimeout
      .mockImplementationOnce(async () => makeResponse(404, {}))
      .mockImplementationOnce(async () => makeResponse(200, {}, "ok"));

    const res = await ssrfSafeFetch("https://itunes.apple.com/search?term=habit+tracker", {
      ...FAST_RETRY_OPTS,
      treat404AsTransient: true,
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(2);
  });

  it("absorbs a 404 burst that clears only on the last allowed attempt", async () => {
    mockFetchWithTimeout
      .mockImplementationOnce(async () => makeResponse(404, {}))
      .mockImplementationOnce(async () => makeResponse(404, {}))
      .mockImplementationOnce(async () => makeResponse(404, {}))
      .mockImplementationOnce(async () => makeResponse(200, {}, "ok"));

    const res = await ssrfSafeFetch("https://itunes.apple.com/search?term=mr", {
      ...FAST_RETRY_OPTS,
      treat404AsTransient: true,
      maxRetries: 3,
    });

    expect(res.status).toBe(200);
    // initial try + 3 retries = 4 calls (DEFAULT_RATE_LIMIT_MAX_RETRIES budget)
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(4);
  });

  // A sustained Apple outage must still bail the pass: retries are bounded,
  // and on exhaustion the throw feeds BOTH `rateLimitErrors` (throttle backs
  // off) and the caller's consecutive-failure bail.
  it("throws RateLimitError(404) once retries are exhausted on sustained 404s", async () => {
    mockFetchWithTimeout.mockImplementation(async () => makeResponse(404, {}));

    const err = await ssrfSafeFetch("https://itunes.apple.com/search?term=tomatos", {
      ...FAST_RETRY_OPTS,
      treat404AsTransient: true,
      maxRetries: 2,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as InstanceType<typeof RateLimitError>).code).toBe("RATE_LIMITED");
    expect((err as InstanceType<typeof RateLimitError>).status).toBe(404);
    expect((err as InstanceType<typeof RateLimitError>).retryable).toBe(true);
    // initial try + 2 retries = 3 calls — bounded, never an open loop.
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(3);
  });

  it("respects maxTotalWaitMs for transient 404s (bounded total backoff)", async () => {
    mockFetchWithTimeout.mockImplementation(async () => makeResponse(404, {}));

    const err = await ssrfSafeFetch("https://itunes.apple.com/search?term=creepy", {
      retryOnRateLimit: true,
      treat404AsTransient: true,
      minDelayMs: 5,
      maxDelayMs: 5,
      maxTotalWaitMs: 8,
      maxRetries: 10,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RateLimitError);
    // 5ms + 5ms = 10ms > 8ms budget, so the 3rd attempt's retry is refused.
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(3);
  });

  // Scoping guarantee: every caller that does NOT opt in keeps today's
  // "404 is a hard, immediate 404" behavior — no retry, response returned
  // as-is (that's what lets `app-pages.ts` map it to `recordPageGone`).
  it("returns a 404 immediately, unretried, when treat404AsTransient is unset", async () => {
    mockFetchWithTimeout.mockImplementation(async () => makeResponse(404, {}));

    const res = await ssrfSafeFetch("https://apps.apple.com/us/app/id1", FAST_RETRY_OPTS);

    expect(res.status).toBe(404);
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it("returns a 404 immediately when treat404AsTransient is explicitly false", async () => {
    mockFetchWithTimeout.mockImplementation(async () => makeResponse(404, {}));

    const res = await ssrfSafeFetch("https://apps.apple.com/us/app/id1", {
      ...FAST_RETRY_OPTS,
      treat404AsTransient: false,
    });

    expect(res.status).toBe(404);
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it("returns a 404 immediately when retryOnRateLimit is unset, even with treat404AsTransient", async () => {
    mockFetchWithTimeout.mockImplementation(async () => makeResponse(404, {}));

    const res = await ssrfSafeFetch("https://itunes.apple.com/search?term=level", {
      treat404AsTransient: true,
    });

    expect(res.status).toBe(404);
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  // Regression guard for PRs #340/#341: the bare-403 burst ceiling stays
  // COUNTED-but-NON-RETRYABLE, and enabling the 404 opt-in must not change it.
  it("keeps a bare 403 non-retryable when treat403AsRateLimit AND treat404AsTransient are both set", async () => {
    mockFetchWithTimeout.mockImplementation(async () => makeResponse(403, {}));

    const err = await ssrfSafeFetch("https://itunes.apple.com/search?term=balls", {
      ...FAST_RETRY_OPTS,
      treat403AsRateLimit: true,
      treat404AsTransient: true,
      maxRetries: 3,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as InstanceType<typeof RateLimitError>).status).toBe(403);
    expect((err as InstanceType<typeof RateLimitError>).retryable).toBe(false);
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it("does not widen 410 Gone or 400 into a transient retry", async () => {
    mockFetchWithTimeout.mockImplementation(async () => makeResponse(410, {}));
    const gone = await ssrfSafeFetch("https://itunes.apple.com/search?term=x", {
      ...FAST_RETRY_OPTS,
      treat404AsTransient: true,
    });
    expect(gone.status).toBe(410);
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  // SSRF guard must hold on EVERY attempt, retries included.
  it("still blocks a private-IP URL with treat404AsTransient set (SSRF guard intact)", async () => {
    await expect(
      ssrfSafeFetch("http://169.254.169.254/latest/meta-data/", {
        ...FAST_RETRY_OPTS,
        treat404AsTransient: true,
      }),
    ).rejects.toThrow("SSRF blocked");
    expect(mockFetchWithTimeout).not.toHaveBeenCalled();
  });

  it("re-validates the URL on every 404 retry attempt (guard is inside the retry loop)", async () => {
    // A redirect hop to a PUBLIC url that then 404s twice before succeeding:
    // proves the retried hop went back through validateUrl (no bypass) and
    // still recovered.
    mockFetchWithTimeout
      .mockImplementationOnce(async () => makeResponse(302, { location: "https://cdn.example.com/j" }))
      .mockImplementationOnce(async () => makeResponse(404, {}))
      .mockImplementationOnce(async () => makeResponse(200, {}, "ok"));

    const res = await ssrfSafeFetch("https://itunes.apple.com/search?term=y", {
      ...FAST_RETRY_OPTS,
      treat404AsTransient: true,
    });

    expect(res.status).toBe(200);
    expect(mockFetchWithTimeout).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// Proxy seam (throughput wave, item 1). `useProxy` is per-call opt-in; the
// resolved URL is sourced from the mocked `getAppstoreProxyUrl` above — no
// real DB/env/secrets access and no real proxy connection anywhere here.
// ---------------------------------------------------------------------------
describe("ssrfSafeFetch proxy (useProxy)", () => {
  it("does NOT consult the proxy resolver at all when useProxy is unset (default false)", async () => {
    mockFetchWithTimeout.mockImplementationOnce(async () => makeResponse(200));
    await ssrfSafeFetch("https://example.com/");
    expect(mockGetAppstoreProxyUrl).not.toHaveBeenCalled();
    const opts = mockFetchWithTimeout.mock.calls[0]?.[1] as RequestInit & { proxy?: string };
    expect(opts.proxy).toBeUndefined();
  });

  it("does NOT consult the proxy resolver when useProxy is explicitly false", async () => {
    mockFetchWithTimeout.mockImplementationOnce(async () => makeResponse(200));
    await ssrfSafeFetch("https://example.com/", { useProxy: false });
    expect(mockGetAppstoreProxyUrl).not.toHaveBeenCalled();
  });

  it("passes the resolved proxy URL through to fetchWithTimeout when useProxy is true and a proxy is configured", async () => {
    mockGetAppstoreProxyUrl.mockImplementationOnce(async () => "http://u:p@proxy.example.com:80");
    mockFetchWithTimeout.mockImplementationOnce(async () => makeResponse(200));

    await ssrfSafeFetch("https://example.com/", { useProxy: true });

    expect(mockGetAppstoreProxyUrl).toHaveBeenCalledTimes(1);
    const opts = mockFetchWithTimeout.mock.calls[0]?.[1] as RequestInit & { proxy?: string };
    expect(opts.proxy).toBe("http://u:p@proxy.example.com:80");
  });

  it("gracefully falls back to a direct fetch (no `proxy` field) when useProxy is true but the proxy is unconfigured", async () => {
    // mockGetAppstoreProxyUrl already defaults to resolving undefined (see beforeEach).
    mockFetchWithTimeout.mockImplementationOnce(async () => makeResponse(200));

    const res = await ssrfSafeFetch("https://example.com/", { useProxy: true });

    expect(res.status).toBe(200);
    expect(mockGetAppstoreProxyUrl).toHaveBeenCalledTimes(1);
    const opts = mockFetchWithTimeout.mock.calls[0]?.[1] as RequestInit & { proxy?: string };
    expect(opts.proxy).toBeUndefined();
  });

  it("still applies SSRF validation to the TARGET url regardless of useProxy", async () => {
    mockGetAppstoreProxyUrl.mockImplementationOnce(async () => "http://u:p@proxy.example.com:80");
    await expect(
      ssrfSafeFetch("http://169.254.169.254/latest/meta-data/", { useProxy: true }),
    ).rejects.toThrow("SSRF blocked");
    expect(mockFetchWithTimeout).not.toHaveBeenCalled();
  });

  it("re-resolves (consults the resolver again) on every hop, including a redirect follow", async () => {
    mockGetAppstoreProxyUrl.mockImplementation(async () => "http://u:p@proxy.example.com:80");
    mockFetchWithTimeout
      .mockImplementationOnce(async () => makeResponse(302, { location: "https://cdn.example.com/page" }))
      .mockImplementationOnce(async () => makeResponse(200, {}, "content"));

    const res = await ssrfSafeFetch("https://example.com/redirect", { useProxy: true });

    expect(res.status).toBe(200);
    expect(mockGetAppstoreProxyUrl).toHaveBeenCalledTimes(2);
    const secondOpts = mockFetchWithTimeout.mock.calls[1]?.[1] as RequestInit & { proxy?: string };
    expect(secondOpts.proxy).toBe("http://u:p@proxy.example.com:80");
  });
});
