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

// Import AFTER mock.module so the mock is already in place.
const { ssrfSafeFetch } = await import("./ssrf-safe-fetch");

function makeResponse(
  status: number,
  headers: Record<string, string> = {},
  body = "",
): Response {
  return new Response(body, { status, headers });
}

beforeEach(() => {
  mockFetchWithTimeout.mockReset();
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
