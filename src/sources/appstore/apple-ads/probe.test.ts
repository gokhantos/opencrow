/**
 * Unit tests for probe.ts — probeSearchPopularity against a fake fetch (no
 * live network, no real sleeps). Covers the happy path against a sample
 * custom-reports COMPLETED fixture, the polling loop, and the SSRF
 * allowlist rejecting a non-apple.com downloadUri.
 * Lane: *.test.ts — `bun run test:unit`.
 */
import { describe, it, expect } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { probeSearchPopularity, parseReportRows } from "./probe";
import { invalidateAccessToken } from "./client";
import type { AppleAdsCreds } from "./types";

// signClientSecret runs locally (no network) even though the token exchange
// response below is mocked, so it still needs a structurally valid PKCS8 PEM.
const { privateKey: privateKeyObj } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const PRIVATE_KEY_PEM = privateKeyObj.export({ type: "pkcs8", format: "pem" }).toString();

const CREDS: AppleAdsCreds = {
  clientId: "client-probe-test",
  teamId: "team",
  keyId: "key",
  orgId: "42",
  privateKey: PRIVATE_KEY_PEM,
};

function tokenResponse(): Response {
  return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const noopSleep = async (): Promise<void> => {};

describe("probeSearchPopularity", () => {
  it("returns rows parsed from a COMPLETED report's downloadUri (immediate completion)", async () => {
    invalidateAccessToken(CREDS.clientId);
    const calls: string[] = [];
    const fetchFn = async (url: string) => {
      calls.push(url);
      if (url.includes("/auth/oauth2/token")) return tokenResponse();
      if (url === "https://api.searchads.apple.com/api/v5/custom-reports") {
        return jsonResponse({
          data: {
            reportId: "report-1",
            state: "COMPLETED",
            downloadUri: "https://reports.apple.com/download/report-1.json",
          },
        });
      }
      if (url === "https://reports.apple.com/download/report-1.json") {
        return jsonResponse([
          { searchTerm: "todo app", countryOrRegion: "US", searchPopularity: 62 },
          { searchTerm: "habit tracker", countryOrRegion: "US", searchPopularity: 41 },
        ]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const result = await probeSearchPopularity(["todo app", "habit tracker"], "US", {
      creds: CREDS,
      deps: { fetchFn, nowSeconds: () => 1_700_000_000 },
      sleepFn: noopSleep,
    });

    expect(result.state).toBe("COMPLETED");
    expect(result.reportId).toBe("report-1");
    expect(result.rowCount).toBe(2);
    expect(result.sample).toEqual([
      { searchTerm: "todo app", countryOrRegion: "US", searchPopularity: 62 },
      { searchTerm: "habit tracker", countryOrRegion: "US", searchPopularity: 41 },
    ]);
    expect(result.error).toBeUndefined();
    // Never hits the token/create/download endpoints more than expected.
    expect(calls.filter((u) => u.includes("custom-reports")).length).toBe(1);
  });

  it("polls until COMPLETED then downloads", async () => {
    invalidateAccessToken(CREDS.clientId);
    let pollCount = 0;
    const fetchFn = async (url: string) => {
      if (url.includes("/auth/oauth2/token")) return tokenResponse();
      if (url === "https://api.searchads.apple.com/api/v5/custom-reports") {
        return jsonResponse({ data: { reportId: "report-2", state: "PROCESSING" } });
      }
      if (url === "https://api.searchads.apple.com/api/v5/custom-reports/report-2") {
        pollCount++;
        if (pollCount < 2) {
          return jsonResponse({ data: { reportId: "report-2", state: "PROCESSING" } });
        }
        return jsonResponse({
          data: {
            reportId: "report-2",
            state: "COMPLETED",
            downloadUri: "https://api.searchads.apple.com/download/report-2.csv",
          },
        });
      }
      if (url === "https://api.searchads.apple.com/download/report-2.csv") {
        return new Response("searchTerm,countryOrRegion,searchPopularity\nfoo,US,10\n", {
          status: 200,
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const result = await probeSearchPopularity(["foo"], "US", {
      creds: CREDS,
      deps: { fetchFn, nowSeconds: () => 1_700_000_000 },
      sleepFn: noopSleep,
      maxPollAttempts: 5,
      pollIntervalMs: 0,
    });

    expect(result.state).toBe("COMPLETED");
    expect(pollCount).toBe(2);
    expect(result.rowCount).toBe(1);
    expect(result.sample).toEqual([{ searchTerm: "foo", countryOrRegion: "US", searchPopularity: "10" }]);
  });

  it("gives up with a diagnostic after maxPollAttempts without completing", async () => {
    invalidateAccessToken(CREDS.clientId);
    const fetchFn = async (url: string) => {
      if (url.includes("/auth/oauth2/token")) return tokenResponse();
      if (url === "https://api.searchads.apple.com/api/v5/custom-reports") {
        return jsonResponse({ data: { reportId: "report-3", state: "PROCESSING" } });
      }
      return jsonResponse({ data: { reportId: "report-3", state: "PROCESSING" } });
    };

    const result = await probeSearchPopularity(["stuck"], "US", {
      creds: CREDS,
      deps: { fetchFn, nowSeconds: () => 1_700_000_000 },
      sleepFn: noopSleep,
      maxPollAttempts: 2,
      pollIntervalMs: 0,
    });

    expect(result.state).toBe("PROCESSING");
    expect(result.rowCount).toBe(0);
    expect(result.error).toMatch(/did not complete/);
  });

  it("SSRF guard: refuses to fetch a downloadUri that is not *.apple.com", async () => {
    invalidateAccessToken(CREDS.clientId);
    let downloadWasCalled = false;
    const fetchFn = async (url: string) => {
      if (url.includes("/auth/oauth2/token")) return tokenResponse();
      if (url === "https://api.searchads.apple.com/api/v5/custom-reports") {
        return jsonResponse({
          data: {
            reportId: "report-evil",
            state: "COMPLETED",
            downloadUri: "https://evil.example.com/steal-me.json",
          },
        });
      }
      if (url === "https://evil.example.com/steal-me.json") {
        downloadWasCalled = true;
        return jsonResponse([{ shouldNotBeReached: true }]);
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const result = await probeSearchPopularity(["keyword"], "US", {
      creds: CREDS,
      deps: { fetchFn, nowSeconds: () => 1_700_000_000 },
      sleepFn: noopSleep,
    });

    expect(downloadWasCalled).toBe(false);
    expect(result.rowCount).toBe(0);
    expect(result.error).toMatch(/SSRF guard/);
    expect(result.error).toContain("evil.example.com");
  });

  it("caps keywords at 10 in the report selector", async () => {
    invalidateAccessToken(CREDS.clientId);
    let sentValues: readonly string[] = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      if (url.includes("/auth/oauth2/token")) return tokenResponse();
      if (url === "https://api.searchads.apple.com/api/v5/custom-reports") {
        const body = JSON.parse(init!.body as string) as {
          selector: { conditions: Array<{ field: string; values: string[] }> };
        };
        sentValues = body.selector.conditions.find((c) => c.field === "searchTerm")!.values;
        return jsonResponse({ data: { reportId: "r", state: "FAILED" } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const manyKeywords = Array.from({ length: 25 }, (_, i) => `kw-${i}`);
    await probeSearchPopularity(manyKeywords, "US", {
      creds: CREDS,
      deps: { fetchFn, nowSeconds: () => 1_700_000_000 },
      sleepFn: noopSleep,
    });

    expect(sentValues).toHaveLength(10);
    expect(sentValues).toEqual(manyKeywords.slice(0, 10));
  });
});

describe("parseReportRows", () => {
  it("parses a JSON array", () => {
    expect(parseReportRows('[{"a":1},{"a":2}]')).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("parses a JSON envelope with a data array", () => {
    expect(parseReportRows('{"data":[{"a":1}]}')).toEqual([{ a: 1 }]);
  });

  it("falls back to naive CSV parsing for non-JSON text", () => {
    expect(parseReportRows("a,b\n1,2\n3,4")).toEqual([
      { a: "1", b: "2" },
      { a: "3", b: "4" },
    ]);
  });

  it("returns an empty array for empty input", () => {
    expect(parseReportRows("")).toEqual([]);
    expect(parseReportRows("   ")).toEqual([]);
  });
});
