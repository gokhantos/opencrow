import { describe, expect, test } from "bun:test";
import {
  aggregateMetrics,
  computeQueryMetrics,
  meanRankDisplacement,
  overlapAtK,
  recallAtK,
  scoreStats,
  setDifference,
  spearman,
} from "./metrics";

describe("overlapAtK", () => {
  test("identical top-k lists → 1.0", () => {
    const ids = ["a", "b", "c", "d"];
    expect(overlapAtK(ids, ids, 4)).toBe(1);
  });

  test("disjoint lists → 0", () => {
    expect(overlapAtK(["a", "b"], ["c", "d"], 2)).toBe(0);
  });

  test("partial overlap divides by k, not by intersection size", () => {
    // {a,b,c} ∩ {b,c,d} = {b,c} → 2/3.
    expect(overlapAtK(["a", "b", "c"], ["b", "c", "d"], 3)).toBeCloseTo(2 / 3);
  });

  test("k larger than result count penalizes short lists", () => {
    // both have only {a,b}; intersection 2 but k=4 → 2/4.
    expect(overlapAtK(["a", "b"], ["a", "b"], 4)).toBe(0.5);
  });

  test("truncates each list to k before intersecting", () => {
    // ref top-2 = {a,b}; cand top-2 = {x,a}; ∩ = {a} → 1/2.
    expect(overlapAtK(["a", "b", "c"], ["x", "a", "b"], 2)).toBe(0.5);
  });

  test("k <= 0 → 0", () => {
    expect(overlapAtK(["a"], ["a"], 0)).toBe(0);
  });
});

describe("recallAtK", () => {
  test("identical lists → 1.0", () => {
    expect(recallAtK(["a", "b", "c"], ["a", "b", "c"], 3)).toBe(1);
  });

  test("empty reference → 0 (no ground truth)", () => {
    expect(recallAtK([], ["a", "b"], 3)).toBe(0);
  });

  test("divides by reference size, not k", () => {
    // ref top-3 = {a,b,c}; cand = {a,b}; recall = 2/3.
    expect(recallAtK(["a", "b", "c"], ["a", "b"], 3)).toBeCloseTo(2 / 3);
  });

  test("candidate superset of reference → 1.0", () => {
    expect(recallAtK(["a", "b"], ["a", "b", "c", "d"], 4)).toBe(1);
  });
});

describe("meanRankDisplacement", () => {
  test("identical order → 0", () => {
    const ids = ["a", "b", "c"];
    expect(meanRankDisplacement(ids, ids, 3)).toBe(0);
  });

  test("empty intersection → null", () => {
    expect(meanRankDisplacement(["a", "b"], ["c", "d"], 2)).toBeNull();
  });

  test("fully reversed list → mean abs displacement", () => {
    // ref ranks a:0,b:1,c:2 ; cand ranks c:0,b:1,a:2.
    // |0-2| + |1-1| + |2-0| = 4 over 3 shared = 4/3.
    expect(meanRankDisplacement(["a", "b", "c"], ["c", "b", "a"], 3)).toBeCloseTo(
      4 / 3,
    );
  });

  test("single shared id with rank shift", () => {
    // ref a:0 ; cand a:2 → |0-2| / 1 = 2.
    expect(meanRankDisplacement(["a", "x", "y"], ["p", "q", "a"], 3)).toBe(2);
  });
});

describe("spearman", () => {
  test("identical order → 1", () => {
    const ids = ["a", "b", "c", "d"];
    expect(spearman(ids, ids, 4)).toBe(1);
  });

  test("fully reversed order → -1", () => {
    expect(spearman(["a", "b", "c"], ["c", "b", "a"], 3)).toBe(-1);
  });

  test("fewer than two shared ids → null", () => {
    expect(spearman(["a", "x"], ["a", "y"], 2)).toBeNull();
    expect(spearman(["a"], ["a"], 1)).toBeNull();
  });

  test("known intermediate value", () => {
    // shared = {a,b,c,d}; ref order a,b,c,d ; cand order a,c,b,d.
    // dense ref ranks: a0 b1 c2 d3 ; dense cand ranks: a0 c1 b2 d3.
    // d for a=0,b=(1-2)=-1,c=(2-1)=1,d=0 → Σd²=2 ; n=4.
    // ρ = 1 - 6*2 / (4*15) = 1 - 12/60 = 0.8.
    expect(spearman(["a", "b", "c", "d"], ["a", "c", "b", "d"], 4)).toBeCloseTo(
      0.8,
    );
  });
});

describe("setDifference", () => {
  test("reference-only ids in reference order", () => {
    expect(setDifference(["a", "b", "c"], ["b"], 3)).toEqual(["a", "c"]);
  });

  test("empty when subset", () => {
    expect(setDifference(["a", "b"], ["a", "b", "c"], 3)).toEqual([]);
  });

  test("respects k truncation on both sides", () => {
    // a-list top-2 = {a,b}; b-list top-1 = {a}; diff = {b}.
    expect(setDifference(["a", "b", "c"], ["a", "z"], 2)).toEqual(["b"]);
  });
});

describe("scoreStats", () => {
  test("empty → all zero, count 0", () => {
    expect(scoreStats([])).toEqual({
      count: 0,
      min: 0,
      mean: 0,
      median: 0,
      max: 0,
    });
  });

  test("odd-length median is the middle element", () => {
    const s = scoreStats([0.1, 0.9, 0.5]);
    expect(s.min).toBeCloseTo(0.1);
    expect(s.max).toBeCloseTo(0.9);
    expect(s.median).toBeCloseTo(0.5);
    expect(s.mean).toBeCloseTo(0.5);
    expect(s.count).toBe(3);
  });

  test("even-length median averages the two middle elements", () => {
    const s = scoreStats([0.2, 0.4, 0.6, 0.8]);
    expect(s.median).toBeCloseTo(0.5);
    expect(s.mean).toBeCloseTo(0.5);
  });

  test("single element", () => {
    expect(scoreStats([0.42])).toEqual({
      count: 1,
      min: 0.42,
      mean: 0.42,
      median: 0.42,
      max: 0.42,
    });
  });
});

describe("computeQueryMetrics", () => {
  test("perfect parity row", () => {
    const m = computeQueryMetrics({
      query: "q1",
      referenceIds: ["a", "b", "c"],
      candidateIds: ["a", "b", "c"],
      referenceScores: [0.9, 0.8, 0.7],
      candidateScores: [0.85, 0.75, 0.65],
      k: 3,
    });
    expect(m.overlapAtK).toBe(1);
    expect(m.recallAtK).toBe(1);
    expect(m.meanRankDisplacement).toBe(0);
    expect(m.spearman).toBe(1);
    expect(m.referenceOnly).toEqual([]);
    expect(m.candidateOnly).toEqual([]);
    expect(m.referenceScores.max).toBeCloseTo(0.9);
    expect(m.candidateScores.max).toBeCloseTo(0.85);
  });

  test("disjoint row → zero overlap, null displacement/spearman", () => {
    const m = computeQueryMetrics({
      query: "q2",
      referenceIds: ["a", "b"],
      candidateIds: ["c", "d"],
      referenceScores: [0.5, 0.4],
      candidateScores: [0.3, 0.2],
      k: 2,
    });
    expect(m.overlapAtK).toBe(0);
    expect(m.recallAtK).toBe(0);
    expect(m.meanRankDisplacement).toBeNull();
    expect(m.spearman).toBeNull();
    expect(m.referenceOnly).toEqual(["a", "b"]);
    expect(m.candidateOnly).toEqual(["c", "d"]);
  });

  test("scores are truncated to k before stats", () => {
    const m = computeQueryMetrics({
      query: "q3",
      referenceIds: ["a", "b", "c"],
      candidateIds: ["a", "b", "c"],
      referenceScores: [1, 0.5, 0.0],
      candidateScores: [0.9, 0.5, 0.1],
      k: 2,
    });
    // only first 2 ref scores [1, 0.5] → max 1, min 0.5.
    expect(m.referenceScores.max).toBe(1);
    expect(m.referenceScores.min).toBe(0.5);
    expect(m.referenceScores.count).toBe(2);
  });
});

describe("aggregateMetrics", () => {
  test("means and medians across query rows", () => {
    const rows = [
      computeQueryMetrics({
        query: "q1",
        referenceIds: ["a", "b"],
        candidateIds: ["a", "b"],
        referenceScores: [0.9, 0.8],
        candidateScores: [0.9, 0.8],
        k: 2,
      }),
      computeQueryMetrics({
        query: "q2",
        referenceIds: ["a", "b"],
        candidateIds: ["c", "d"],
        referenceScores: [0.5, 0.4],
        candidateScores: [0.3, 0.2],
        k: 2,
      }),
    ];
    const agg = aggregateMetrics(rows);
    expect(agg.queryCount).toBe(2);
    // overlaps: [1, 0] → mean 0.5, median 0.5.
    expect(agg.meanOverlapAtK).toBeCloseTo(0.5);
    expect(agg.medianOverlapAtK).toBeCloseTo(0.5);
    expect(agg.meanRecallAtK).toBeCloseTo(0.5);
    // q1 displacement 0 (defined), q2 null → mean of defined = 0.
    expect(agg.meanRankDisplacement).toBe(0);
    // q1 spearman 1 (defined), q2 null → mean of defined = 1.
    expect(agg.meanSpearman).toBe(1);
    expect(agg.totalReferenceOnly).toBe(2);
    expect(agg.totalCandidateOnly).toBe(2);
  });

  test("all-null displacement/spearman → null aggregate", () => {
    const rows = [
      computeQueryMetrics({
        query: "q1",
        referenceIds: ["a"],
        candidateIds: ["b"],
        referenceScores: [0.5],
        candidateScores: [0.5],
        k: 1,
      }),
    ];
    const agg = aggregateMetrics(rows);
    expect(agg.meanRankDisplacement).toBeNull();
    expect(agg.meanSpearman).toBeNull();
  });

  test("empty rows → zeros and nulls", () => {
    const agg = aggregateMetrics([]);
    expect(agg.queryCount).toBe(0);
    expect(agg.meanOverlapAtK).toBe(0);
    expect(agg.meanRankDisplacement).toBeNull();
    expect(agg.meanSpearman).toBeNull();
  });
});
