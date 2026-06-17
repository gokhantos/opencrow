import { test, expect, describe } from "bun:test";
import {
  convergenceVeto,
  dissentAdjustedScore,
  paretoFrontier,
  bradleyTerryRank,
  type PairwiseWin,
} from "./sige-select";

// ─── convergenceVeto ────────────────────────────────────────────────────────────

describe("convergenceVeto", () => {
  test("does not veto a healthy, diverse round", () => {
    const r = convergenceVeto({ convergenceRate: 0.3, diversityIndex: 0.8 });
    expect(r.vetoed).toBe(false);
    expect(r.reasons).toHaveLength(0);
  });

  test("vetoes when convergenceRate crosses the threshold", () => {
    const r = convergenceVeto({ convergenceRate: 0.9, diversityIndex: 0.8 });
    expect(r.vetoed).toBe(true);
    expect(r.reasons.some((x) => x.includes("convergenceRate"))).toBe(true);
  });

  test("vetoes when diversityIndex collapses", () => {
    const r = convergenceVeto({ convergenceRate: 0.1, diversityIndex: 0.1 });
    expect(r.vetoed).toBe(true);
    expect(r.reasons.some((x) => x.includes("diversityIndex"))).toBe(true);
  });

  test("threshold boundaries are inclusive (>= and <=)", () => {
    const exactHigh = convergenceVeto(
      { convergenceRate: 0.85, diversityIndex: 0.9 },
      { maxConvergenceRate: 0.85 },
    );
    expect(exactHigh.vetoed).toBe(true);
    const exactLow = convergenceVeto(
      { convergenceRate: 0.1, diversityIndex: 0.2 },
      { minDiversityIndex: 0.2 },
    );
    expect(exactLow.vetoed).toBe(true);
  });

  test("respects custom thresholds", () => {
    const r = convergenceVeto(
      { convergenceRate: 0.6, diversityIndex: 0.5 },
      { maxConvergenceRate: 0.5, minDiversityIndex: 0.4 },
    );
    expect(r.vetoed).toBe(true);
  });

  test("clamps non-finite inputs defensively", () => {
    const r = convergenceVeto({
      convergenceRate: Number.NaN,
      diversityIndex: Number.POSITIVE_INFINITY,
    });
    expect(r.convergenceRate).toBe(0);
    expect(r.diversityIndex).toBe(1);
    expect(r.vetoed).toBe(false);
  });

  test("reports both reasons when both fire", () => {
    const r = convergenceVeto({ convergenceRate: 0.95, diversityIndex: 0.05 });
    expect(r.reasons).toHaveLength(2);
  });
});

// ─── dissentAdjustedScore ───────────────────────────────────────────────────────

describe("dissentAdjustedScore", () => {
  test("zero dissent is a no-op", () => {
    expect(dissentAdjustedScore(0.8, 0, 0.3)).toBeCloseTo(0.8);
  });

  test("weight zero ignores dissent entirely", () => {
    expect(dissentAdjustedScore(0.8, 1, 0)).toBeCloseTo(0.8);
  });

  test("full dissent at full weight collapses to zero", () => {
    expect(dissentAdjustedScore(0.8, 1, 1)).toBeCloseTo(0);
  });

  test("monotonic decreasing in dissent for fixed base/weight", () => {
    const base = 1;
    const w = 0.5;
    const a = dissentAdjustedScore(base, 0.2, w);
    const b = dissentAdjustedScore(base, 0.5, w);
    const c = dissentAdjustedScore(base, 0.9, w);
    expect(a).toBeGreaterThan(b);
    expect(b).toBeGreaterThan(c);
  });

  test("never silently averages dissent away (penalty is real)", () => {
    const adjusted = dissentAdjustedScore(0.9, 0.5, 0.4);
    // 0.9 * (1 - 0.4*0.5) = 0.9 * 0.8 = 0.72
    expect(adjusted).toBeCloseTo(0.72);
    expect(adjusted).toBeLessThan(0.9);
  });

  test("clamps out-of-range dissent and weight", () => {
    expect(dissentAdjustedScore(1, 2, 1)).toBeCloseTo(0); // dissent clamped to 1
    expect(dissentAdjustedScore(1, 0.5, 5)).toBeCloseTo(0.5); // weight clamped to 1
  });

  test("non-finite base is treated as zero", () => {
    expect(dissentAdjustedScore(Number.NaN, 0.5, 0.3)).toBe(0);
  });

  test("uses default weight when omitted", () => {
    // 1 * (1 - 0.3*1) = 0.7
    expect(dissentAdjustedScore(1, 1)).toBeCloseTo(0.7);
  });
});

// ─── paretoFrontier ─────────────────────────────────────────────────────────────

interface Idea {
  readonly id: string;
  readonly orig: number;
  readonly qual: number;
}

const origOf = (i: Idea) => i.orig;
const qualOf = (i: Idea) => i.qual;

describe("paretoFrontier", () => {
  test("empty input yields empty frontier and ranking", () => {
    const r = paretoFrontier<Idea>([], origOf, qualOf);
    expect(r.frontier).toHaveLength(0);
    expect(r.ranked).toHaveLength(0);
  });

  test("a generic-but-polished idea is dominated off the frontier", () => {
    const items: Idea[] = [
      { id: "polished", orig: 0.2, qual: 0.95 }, // high quality, low originality
      { id: "balanced", orig: 0.5, qual: 0.95 }, // matches quality, more original
      { id: "original", orig: 0.95, qual: 0.6 },
    ];
    const r = paretoFrontier(items, origOf, qualOf);
    const frontierIds = r.frontier.map((p) => p.item.id);
    // "polished" is dominated by "balanced" (>= qual, > orig).
    expect(frontierIds).not.toContain("polished");
    expect(frontierIds).toContain("balanced");
    expect(frontierIds).toContain("original");
  });

  test("no frontier point is dominated by another", () => {
    const items: Idea[] = [
      { id: "a", orig: 0.9, qual: 0.1 },
      { id: "b", orig: 0.5, qual: 0.5 },
      { id: "c", orig: 0.1, qual: 0.9 },
      { id: "d", orig: 0.2, qual: 0.2 }, // dominated by b
    ];
    const r = paretoFrontier(items, origOf, qualOf);
    const frontier = r.frontier;
    for (const p of frontier) {
      for (const q of frontier) {
        if (p === q) continue;
        const qDominatesP =
          q.originality >= p.originality &&
          q.quality >= p.quality &&
          (q.originality > p.originality || q.quality > p.quality);
        expect(qDominatesP).toBe(false);
      }
    }
    expect(frontier.map((p) => p.item.id)).not.toContain("d");
  });

  test("ranks the high-on-weakest-axis (balanced) point first", () => {
    const items: Idea[] = [
      { id: "extreme-orig", orig: 1.0, qual: 0.1 },
      { id: "balanced", orig: 0.7, qual: 0.7 },
      { id: "extreme-qual", orig: 0.1, qual: 1.0 },
    ];
    const r = paretoFrontier(items, origOf, qualOf);
    expect(r.ranked[0]!.item.id).toBe("balanced");
  });

  test("ranked appends dominated points after the frontier", () => {
    const items: Idea[] = [
      { id: "top", orig: 0.9, qual: 0.9 },
      { id: "weak", orig: 0.1, qual: 0.1 }, // dominated
    ];
    const r = paretoFrontier(items, origOf, qualOf);
    expect(r.ranked.map((p) => p.item.id)).toEqual(["top", "weak"]);
  });

  test("clamps non-finite axis values to zero", () => {
    const items: Idea[] = [
      { id: "nan", orig: Number.NaN, qual: 0.5 },
      { id: "ok", orig: 0.5, qual: 0.5 },
    ];
    const r = paretoFrontier(items, origOf, qualOf);
    // "ok" dominates "nan" (orig 0.5 > 0, qual equal).
    expect(r.frontier.map((p) => p.item.id)).toEqual(["ok"]);
  });

  test("single item is its own frontier", () => {
    const r = paretoFrontier([{ id: "solo", orig: 0.3, qual: 0.4 }], origOf, qualOf);
    expect(r.frontier).toHaveLength(1);
    expect(r.ranked).toHaveLength(1);
  });
});

// ─── bradleyTerryRank ───────────────────────────────────────────────────────────

describe("bradleyTerryRank", () => {
  test("empty input yields empty ranking", () => {
    const r = bradleyTerryRank([]);
    expect(r.ranking).toHaveLength(0);
    expect(r.strengths.size).toBe(0);
  });

  test("single comparison ranks winner above loser", () => {
    const r = bradleyTerryRank([{ winner: "a", loser: "b" }]);
    expect(r.ranking).toEqual(["a", "b"]);
    expect(r.strengths.get("a")!).toBeGreaterThan(r.strengths.get("b")!);
  });

  test("transitive chain produces a consistent total order", () => {
    const wins: PairwiseWin[] = [
      { winner: "a", loser: "b" },
      { winner: "a", loser: "b" },
      { winner: "b", loser: "c" },
      { winner: "b", loser: "c" },
      { winner: "a", loser: "c" },
      { winner: "a", loser: "c" },
    ];
    const r = bradleyTerryRank(wins);
    expect(r.ranking).toEqual(["a", "b", "c"]);
  });

  test("tolerates an undefeated player without infinite strength", () => {
    const wins: PairwiseWin[] = [
      { winner: "a", loser: "b" },
      { winner: "a", loser: "c" },
      { winner: "a", loser: "d" },
      { winner: "b", loser: "c" },
    ];
    const r = bradleyTerryRank(wins);
    expect(r.ranking[0]).toBe("a");
    for (const v of r.strengths.values()) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  test("tolerates sparse / asymmetric data", () => {
    // d only ever loses; e only appears once.
    const wins: PairwiseWin[] = [
      { winner: "a", loser: "d" },
      { winner: "b", loser: "d" },
      { winner: "c", loser: "e" },
    ];
    const r = bradleyTerryRank(wins);
    expect(r.strengths.size).toBe(5);
    expect(r.ranking).toContain("d");
    // d (loses everything) should rank at or near the bottom.
    expect(r.ranking[r.ranking.length - 1]).toBe("d");
  });

  test("is deterministic across runs", () => {
    const wins: PairwiseWin[] = [
      { winner: "x", loser: "y" },
      { winner: "y", loser: "z" },
      { winner: "x", loser: "z" },
    ];
    const a = bradleyTerryRank(wins);
    const b = bradleyTerryRank(wins);
    expect(a.ranking).toEqual(b.ranking);
  });

  test("stable id tie-break for symmetric data", () => {
    // a and b split their games → equal strength → id-ascending tie-break.
    const wins: PairwiseWin[] = [
      { winner: "a", loser: "b" },
      { winner: "b", loser: "a" },
    ];
    const r = bradleyTerryRank(wins);
    expect(r.ranking).toEqual(["a", "b"]);
  });

  test("ignores self-comparisons", () => {
    const r = bradleyTerryRank([{ winner: "a", loser: "a" }, { winner: "a", loser: "b" }]);
    expect(r.ranking).toEqual(["a", "b"]);
  });
});
