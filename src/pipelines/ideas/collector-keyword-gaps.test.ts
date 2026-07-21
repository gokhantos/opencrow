import { describe, expect, it } from "bun:test";
import { filterKnownZeroVolume, selectGapSeeds } from "./collector-keyword-gaps";
import type { KeywordScanRow, OpportunityRow } from "../../sources/appstore/keyword-store";

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
    buildability: 0,
    lowConfidence: false,
    brandNavigational: false,
    hintBestRank: null,
    hintSeedCount: null,
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

  it("dedups scans whose KEYWORD is already consumed", () => {
    const scans = [
      makeScan({ id: 10, keyword: "fresh", opportunity: 0.9 }),
      makeScan({ id: 11, keyword: "seen", opportunity: 0.95 }),
    ];

    // Dedup unit is the keyword, not the scan row id — getTopOpportunities
    // returns the newest scan per keyword, so a new scan cycle mints a new row
    // id for the same keyword on every run; id-based dedup would never filter.
    const seeds = selectGapSeeds(scans, new Set(["seen"]), { limit: 10, minOpportunity: 0.4 });

    expect(seeds.map((s) => s.keyword)).toEqual(["fresh"]);
    expect(seeds.map((s) => s.sourceId)).toEqual(["10"]);
  });

  it("does NOT dedup on sourceId — a stale row id for a fresh keyword still seeds", () => {
    const scans = [makeScan({ id: 11, keyword: "fresh", opportunity: 0.9 })];

    // "11" is a scan row id, not a keyword — must not be treated as consumed.
    const seeds = selectGapSeeds(scans, new Set(["11"]), { limit: 10, minOpportunity: 0.4 });

    expect(seeds.map((s) => s.keyword)).toEqual(["fresh"]);
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
      [
        makeScan({
          id: 7,
          keyword: "x",
          opportunity: 0.8,
          demand: 12.5,
          competitiveness: 33.3,
          incumbentWeakness: 0.6,
          trend: "heating",
          lowConfidence: false,
        }),
      ],
      new Set(),
      { limit: 5, minOpportunity: 0.4 },
    );

    expect(seeds[0]).toEqual({
      keyword: "x",
      opportunity: 0.8,
      store: "appstore",
      signalType: "keyword_gap",
      sourceId: "7",
      demand: 12.5,
      competitiveness: 33.3,
      incumbentWeakness: 0.6,
      trend: "heating",
      lowConfidence: false,
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

  // Batch F, F5 leg 2/3: a PIPELINE-sourced (screener) soft-downweight verdict
  // must only affect SORT RANK, never exclude the keyword or distort its
  // reported opportunity.
  describe("downweightedKeywords (Batch F, F5)", () => {
    it("ranks a downweighted keyword below an equal-opportunity keyword with no flag", () => {
      const scans = [
        makeScan({ id: 1, keyword: "flagged", opportunity: 0.8 }),
        makeScan({ id: 2, keyword: "clean", opportunity: 0.8 }),
      ];
      const seeds = selectGapSeeds(
        scans,
        new Set(),
        { limit: 10, minOpportunity: 0.4 },
        new Set(["flagged"]),
      );
      expect(seeds.map((s) => s.keyword)).toEqual(["clean", "flagged"]);
    });

    it("still includes a downweighted keyword — soft, never a hard exclude", () => {
      const scans = [makeScan({ id: 1, keyword: "flagged", opportunity: 0.9 })];
      const seeds = selectGapSeeds(
        scans,
        new Set(),
        { limit: 10, minOpportunity: 0.4 },
        new Set(["flagged"]),
      );
      expect(seeds.map((s) => s.keyword)).toEqual(["flagged"]);
    });

    it("never distorts the seed's reported opportunity value", () => {
      const scans = [makeScan({ id: 1, keyword: "flagged", opportunity: 0.9 })];
      const seeds = selectGapSeeds(
        scans,
        new Set(),
        { limit: 10, minOpportunity: 0.4 },
        new Set(["flagged"]),
      );
      expect(seeds[0]?.opportunity).toBe(0.9);
    });

    it("a strong downweighted keyword can still outrank a much weaker clean one", () => {
      const scans = [
        makeScan({ id: 1, keyword: "flagged", opportunity: 0.95 }),
        makeScan({ id: 2, keyword: "clean", opportunity: 0.1 }),
      ];
      const seeds = selectGapSeeds(
        scans,
        new Set(),
        { limit: 10, minOpportunity: 0.05 },
        new Set(["flagged"]),
      );
      // 0.95 * 0.5 = 0.475, still well above 0.1 — a soft downweight, not a
      // hard demotion to the bottom regardless of real opportunity.
      expect(seeds.map((s) => s.keyword)).toEqual(["flagged", "clean"]);
    });

    it("defaults to no downweighting when the parameter is omitted", () => {
      const scans = [
        makeScan({ id: 1, keyword: "a", opportunity: 0.5 }),
        makeScan({ id: 2, keyword: "b", opportunity: 0.6 }),
      ];
      const seeds = selectGapSeeds(scans, new Set(), { limit: 10, minOpportunity: 0.4 });
      expect(seeds.map((s) => s.keyword)).toEqual(["b", "a"]);
    });
  });
});

/**
 * Minimal OpportunityRow factory — extends makeScan with the
 * `firstFoundAt`/`source`/`peakOpportunity`/`asaPopularity`/
 * `asaPopularityCheckedAt` fields `filterKnownZeroVolume` reads.
 */
function makeOpportunity(
  overrides: Partial<OpportunityRow> & { id: number },
): OpportunityRow {
  return {
    ...makeScan(overrides),
    firstFoundAt: null,
    source: null,
    peakOpportunity: overrides.opportunity ?? 0.5,
    asaPopularity: null,
    asaPopularityCheckedAt: null,
    ...overrides,
  };
}

describe("filterKnownZeroVolume", () => {
  const NOW = 2_000_000;
  const DAY = 86_400;

  it("drops a keyword with recorded popularity at or under the threshold, within the freshness window", () => {
    const scans = [
      makeOpportunity({
        id: 1,
        keyword: "dead",
        asaPopularity: 1,
        asaPopularityCheckedAt: NOW - 1 * DAY,
      }),
      makeOpportunity({
        id: 2,
        keyword: "alive",
        asaPopularity: 4,
        asaPopularityCheckedAt: NOW - 1 * DAY,
      }),
    ];

    const result = filterKnownZeroVolume(scans, {
      threshold: 1,
      freshnessDays: 45,
      nowEpochSeconds: NOW,
    });

    expect(result.map((r) => r.keyword)).toEqual(["alive"]);
  });

  it("keeps a keyword never probed (asaPopularity null)", () => {
    const scans = [makeOpportunity({ id: 1, keyword: "unprobed" })];

    const result = filterKnownZeroVolume(scans, {
      threshold: 1,
      freshnessDays: 45,
      nowEpochSeconds: NOW,
    });

    expect(result.map((r) => r.keyword)).toEqual(["unprobed"]);
  });

  it("keeps a known-dead keyword whose reading has aged past the freshness window (stale probe can't permanently blacklist)", () => {
    const scans = [
      makeOpportunity({
        id: 1,
        keyword: "stale-dead",
        asaPopularity: 1,
        asaPopularityCheckedAt: NOW - 46 * DAY,
      }),
    ];

    const result = filterKnownZeroVolume(scans, {
      threshold: 1,
      freshnessDays: 45,
      nowEpochSeconds: NOW,
    });

    expect(result.map((r) => r.keyword)).toEqual(["stale-dead"]);
  });

  it("keeps a keyword exactly at the freshness boundary (checked_at == floor)", () => {
    const scans = [
      makeOpportunity({
        id: 1,
        keyword: "boundary",
        asaPopularity: 1,
        asaPopularityCheckedAt: NOW - 45 * DAY,
      }),
    ];

    // freshnessFloorSec == NOW - 45*DAY; checked_at < floor is stale, so an
    // exact match at the floor is still "fresh" and the veto applies.
    const result = filterKnownZeroVolume(scans, {
      threshold: 1,
      freshnessDays: 45,
      nowEpochSeconds: NOW,
    });

    expect(result.map((r) => r.keyword)).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const scans = [
      makeOpportunity({ id: 1, keyword: "a", asaPopularity: 1, asaPopularityCheckedAt: NOW }),
    ];
    const snapshot = scans.map((s) => s.keyword);

    filterKnownZeroVolume(scans, { threshold: 1, freshnessDays: 45, nowEpochSeconds: NOW });

    expect(scans.map((s) => s.keyword)).toEqual(snapshot);
  });
});
