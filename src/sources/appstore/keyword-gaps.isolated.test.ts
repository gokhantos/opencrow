import { describe, expect, it, mock, beforeEach } from "bun:test";

const sample = {
  results: [
    {
      trackId: 1,
      trackName: "LiverPal",
      userRatingCount: 7,
      averageUserRating: 5,
      releaseDate: "2020-01-01T00:00:00Z",
    },
    {
      trackId: 2,
      trackName: "Fatty Liver",
      userRatingCount: 1,
      averageUserRating: 1,
      releaseDate: "2019-01-01T00:00:00Z",
    },
  ],
};

describe("scanKeyword", () => {
  beforeEach(() => {
    mock.module("../shared/ssrf-safe-fetch", () => ({
      ssrfSafeFetch: async () => ({ ok: true, json: async () => sample }),
    }));
    mock.module("./keyword-store", () => ({
      getLatestScan: async () => null,
      getStaleKeywords: async () => [],
      getStaleKeywordsAcrossZones: async () => [],
      insertScan: async () => {},
      markScanned: async () => {},
      countScansSince: async () => 0,
    }));
  });

  it("scores an open gap from live results", async () => {
    const { scanKeyword } = await import("./keyword-gaps");
    const p = await scanKeyword("fatty liver diet");
    expect(p.topApps.length).toBe(2);
    expect(p.competitiveness).toBeLessThan(30);
    expect(p.trend).toBe("new");
    expect(p.opportunity).toBeGreaterThan(0);
  });
});

describe("runScanSlice", () => {
  let insertScanCalls: unknown[];
  let markScannedCalls: Array<{ keywords: readonly string[]; at: number }>;

  beforeEach(() => {
    insertScanCalls = [];
    markScannedCalls = [];

    mock.module("./keyword-store", () => ({
      getStaleKeywords: async () => ["a", "b"],
      getStaleKeywordsAcrossZones: async () => [],
      insertScan: async (p: unknown) => {
        insertScanCalls.push(p);
      },
      markScanned: async (keywords: readonly string[], at: number) => {
        markScannedCalls.push({ keywords, at });
      },
      getLatestScan: async () => null,
      countScansSince: async () => 0,
    }));

    let fetchCallCount = 0;
    mock.module("../shared/ssrf-safe-fetch", () => ({
      ssrfSafeFetch: async () => {
        fetchCallCount++;
        if (fetchCallCount === 1) {
          return { ok: true, json: async () => sample };
        }
        throw new Error("network failure");
      },
    }));
  });

  it("scans the stale slice, tolerates a failing keyword, and marks only successes", async () => {
    const { runScanSlice } = await import("./keyword-gaps");
    const result = await runScanSlice({ genreZone: "health", budget: 10, delayMs: 0 });

    expect(result).toEqual({ scanned: 1, failed: 1 });
    expect(insertScanCalls.length).toBe(1);
    expect(markScannedCalls.length).toBe(1);
    expect(markScannedCalls[0]?.keywords).toEqual(["a"]);
  });

  it("never throws even if every keyword fails", async () => {
    mock.module("../shared/ssrf-safe-fetch", () => ({
      ssrfSafeFetch: async () => {
        throw new Error("network failure");
      },
    }));

    const { runScanSlice } = await import("./keyword-gaps");
    const result = await runScanSlice({ genreZone: "health", budget: 10, delayMs: 0 });

    expect(result).toEqual({ scanned: 0, failed: 2 });
    expect(insertScanCalls.length).toBe(0);
    expect(markScannedCalls.length).toBe(0);
  });
});

describe("runKeywordSweep", () => {
  let insertScanCalls: unknown[];
  let markScannedCalls: Array<{ keywords: readonly string[]; at: number }>;
  let staleKeywordsAcrossZonesCalls: number[];

  beforeEach(() => {
    insertScanCalls = [];
    markScannedCalls = [];
    staleKeywordsAcrossZonesCalls = [];

    mock.module("./keyword-store", () => ({
      getStaleKeywords: async () => [],
      getStaleKeywordsAcrossZones: async (limit: number) => {
        staleKeywordsAcrossZonesCalls.push(limit);
        return ["a", "b"];
      },
      insertScan: async (p: unknown) => {
        insertScanCalls.push(p);
      },
      markScanned: async (keywords: readonly string[], at: number) => {
        markScannedCalls.push({ keywords, at });
      },
      getLatestScan: async () => null,
      countScansSince: async () => 0,
    }));

    let fetchCallCount = 0;
    mock.module("../shared/ssrf-safe-fetch", () => ({
      ssrfSafeFetch: async () => {
        fetchCallCount++;
        if (fetchCallCount === 1) {
          return { ok: true, json: async () => sample };
        }
        throw new Error("network failure");
      },
    }));
  });

  it("scans the globally stalest slice across zones, tolerates a failing keyword, and marks only successes", async () => {
    const { runKeywordSweep } = await import("./keyword-gaps");
    const result = await runKeywordSweep({ limit: 25, delayMs: 0 });

    expect(result).toEqual({ scanned: 1, failed: 1, skipped: false });
    expect(staleKeywordsAcrossZonesCalls).toEqual([25]);
    expect(insertScanCalls.length).toBe(1);
    expect(markScannedCalls.length).toBe(1);
    expect(markScannedCalls[0]?.keywords).toEqual(["a"]);
  });

  it("skips the sweep without scanning anything when the rolling 24h budget is reached", async () => {
    mock.module("./keyword-store", () => ({
      getStaleKeywords: async () => [],
      getStaleKeywordsAcrossZones: async (limit: number) => {
        staleKeywordsAcrossZonesCalls.push(limit);
        return ["a", "b"];
      },
      insertScan: async (p: unknown) => {
        insertScanCalls.push(p);
      },
      markScanned: async (keywords: readonly string[], at: number) => {
        markScannedCalls.push({ keywords, at });
      },
      getLatestScan: async () => null,
      // Default config's dailyKeywordBudget is 40_000 — return a count that
      // already meets it so the sweep must skip.
      countScansSince: async () => 40_000,
    }));

    const { runKeywordSweep } = await import("./keyword-gaps");
    const result = await runKeywordSweep({ limit: 25, delayMs: 0 });

    expect(result).toEqual({ scanned: 0, failed: 0, skipped: true });
    expect(staleKeywordsAcrossZonesCalls.length).toBe(0);
    expect(insertScanCalls.length).toBe(0);
    expect(markScannedCalls.length).toBe(0);
  });
});
