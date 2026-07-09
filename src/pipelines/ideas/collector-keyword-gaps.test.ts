import { describe, expect, it } from "bun:test";
import { selectGapSeeds } from "./collector-keyword-gaps";
import type { KeywordScanRow } from "../../sources/appstore/keyword-store";

/**
 * Minimal KeywordScanRow factory — only the fields selectGapSeeds reads
 * (id, keyword, opportunity) carry meaning; the rest are filled with inert
 * values so the pure selector can be exercised without a DB.
 */
function makeScan(overrides: Partial<KeywordScanRow> & { id: number }): KeywordScanRow {
  return {
    keyword: overrides.keyword ?? `kw-${overrides.id}`,
    store: "app",
    scannedAt: 0,
    competitiveness: 0,
    demand: 0,
    incumbentWeakness: 0,
    opportunity: 0.5,
    trend: "stable",
    topAppReviews: 0,
    avgRating: 0,
    avgAgeDays: 0,
    topApps: [],
    ...overrides,
  };
}

describe("selectGapSeeds", () => {
  it("sorts surviving scans by opportunity DESC", () => {
    const scans = [
      makeScan({ id: 1, keyword: "low", opportunity: 0.55 }),
      makeScan({ id: 2, keyword: "high", opportunity: 0.95 }),
      makeScan({ id: 3, keyword: "mid", opportunity: 0.75 }),
    ];

    const seeds = selectGapSeeds(scans, new Set(), { limit: 10, minOpportunity: 0.4 });

    expect(seeds.map((s) => s.keyword)).toEqual(["high", "mid", "low"]);
    expect(seeds.map((s) => s.opportunity)).toEqual([0.95, 0.75, 0.55]);
  });

  it("filters out scans below minOpportunity", () => {
    const scans = [
      makeScan({ id: 1, keyword: "keep", opportunity: 0.6 }),
      makeScan({ id: 2, keyword: "drop", opportunity: 0.39 }),
      makeScan({ id: 3, keyword: "edge", opportunity: 0.4 }),
    ];

    const seeds = selectGapSeeds(scans, new Set(), { limit: 10, minOpportunity: 0.4 });

    // >= threshold is kept (edge at exactly 0.4 survives); below is dropped.
    expect(seeds.map((s) => s.keyword).sort()).toEqual(["edge", "keep"]);
    expect(seeds.some((s) => s.keyword === "drop")).toBe(false);
  });

  it("dedups scans whose sourceId is already consumed", () => {
    const scans = [
      makeScan({ id: 10, keyword: "fresh", opportunity: 0.9 }),
      makeScan({ id: 11, keyword: "seen", opportunity: 0.95 }),
    ];

    // consumed ids are compared as STRINGS (scan id 11 -> "11").
    const seeds = selectGapSeeds(scans, new Set(["11"]), { limit: 10, minOpportunity: 0.4 });

    expect(seeds.map((s) => s.keyword)).toEqual(["fresh"]);
    expect(seeds.map((s) => s.sourceId)).toEqual(["10"]);
  });

  it("caps the result at limit, keeping the highest-opportunity seeds", () => {
    const scans = [
      makeScan({ id: 1, keyword: "a", opportunity: 0.91 }),
      makeScan({ id: 2, keyword: "b", opportunity: 0.92 }),
      makeScan({ id: 3, keyword: "c", opportunity: 0.93 }),
      makeScan({ id: 4, keyword: "d", opportunity: 0.94 }),
    ];

    const seeds = selectGapSeeds(scans, new Set(), { limit: 2, minOpportunity: 0.4 });

    expect(seeds).toHaveLength(2);
    expect(seeds.map((s) => s.keyword)).toEqual(["d", "c"]);
  });

  it("stamps store=appstore and signalType=keyword_gap on every seed", () => {
    const seeds = selectGapSeeds(
      [makeScan({ id: 7, keyword: "x", opportunity: 0.8 })],
      new Set(),
      { limit: 5, minOpportunity: 0.4 },
    );

    expect(seeds[0]).toEqual({
      keyword: "x",
      opportunity: 0.8,
      store: "appstore",
      signalType: "keyword_gap",
      sourceId: "7",
    });
  });

  it("does not mutate the input scans array", () => {
    const scans = [
      makeScan({ id: 1, keyword: "a", opportunity: 0.5 }),
      makeScan({ id: 2, keyword: "b", opportunity: 0.9 }),
    ];
    const snapshot = scans.map((s) => s.keyword);

    selectGapSeeds(scans, new Set(), { limit: 10, minOpportunity: 0.4 });

    expect(scans.map((s) => s.keyword)).toEqual(snapshot);
  });

  it("returns nothing when limit is zero", () => {
    const seeds = selectGapSeeds(
      [makeScan({ id: 1, opportunity: 0.9 })],
      new Set(),
      { limit: 0, minOpportunity: 0.4 },
    );
    expect(seeds).toEqual([]);
  });
});
