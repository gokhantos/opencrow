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
    mock.module("./keyword-store", () => ({ getLatestScan: async () => null }));
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
