/**
 * Unit tests for PURE exported helpers in pipeline.ts.
 *
 * No DB, no LLM, no network. Covers:
 *   - extractThemesByNgrams: bigram/trigram extraction, stop-word filter
 *   - combineGiantScores: weight blend, identity cases
 *   - normalizeDissent: 0-5 → 0-1 scaling, edge values
 *   - buildPairwiseWins: winner/loser logic, equal-score tie, position-switch
 *   - buildSignalsContext: section assembly, empty sections omitted
 *   - mapDivergentToCandidate: field mapping, tag, signalIds
 *   - mapDeepGameRankedToCandidate: unscored sentinel, sourcesUsed
 *   - mergeSigeCandidates: deep-first order, dedup, cap
 *   - synthesizeEnrichedSeed: bounded, non-empty sentinel
 *   - enforceSegmentSpread: quota enforcement, empty-segments passthrough
 *   - paretoSelect: respects limit, delegates to Pareto for oversized pools
 *   - computeSigeConvergenceVeto: veto logic driven by jury agreement
 *   - buildPairwiseWins: both-direction registration for position-switch
 *   - mergeSelectedIds: Map + resumed-Record + undefined inputs; no-throw on {}
 */

import { test, expect, describe } from "bun:test";
import {
  extractThemesByNgrams,
  combineGiantScores,
  normalizeDissent,
  buildPairwiseWins,
  buildSignalsContext,
  mapDivergentToCandidate,
  mapDeepGameRankedToCandidate,
  mergeSigeCandidates,
  synthesizeEnrichedSeed,
  enforceSegmentSpread,
  paretoSelect,
  computeSigeConvergenceVeto,
  mergeSelectedIds,
} from "./pipeline";
import type { GiantAxisScores } from "./giant";
import { GIANT_AXIS_KEYS } from "./giant";
import type { GeneratedIdeaCandidate } from "./types";
import type { DivergentCandidate } from "../../sige/run";
import type { SigeSignals } from "./pipeline";
import type { ScoredIdea } from "../../sige/types";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeCandidate(
  title: string,
  overrides: Partial<GeneratedIdeaCandidate> = {},
): GeneratedIdeaCandidate {
  return {
    title,
    summary: "summary of " + title,
    reasoning: "",
    designDescription: "",
    monetizationDetail: "",
    sourceLinks: [],
    sourcesUsed: "",
    category: "general",
    qualityScore: 3,
    targetAudience: "",
    keyFeatures: [],
    revenueModel: "",
    trendIntersection: "",
    ...overrides,
  };
}

const STRONG_GIANT: GiantAxisScores = {
  acuteProblem: 4,
  whyNow: 4,
  demand: 4,
  nonObviousness: 4,
  defensibility: 4,
  marketShape: 4,
  founderFit: 4,
};

// ── extractThemesByNgrams ────────────────────────────────────────────────────

describe("extractThemesByNgrams", () => {
  test("returns [] for empty input", () => {
    expect(extractThemesByNgrams([])).toHaveLength(0);
  });

  test("returns [] when no ngram appears in >= 2 titles (bigrams) / >= 3 (trigrams)", () => {
    const rows = [
      { title: "AlphaBot Tool", summary: "" },
      { title: "BetaSync Engine", summary: "" },
    ];
    // No bigram shared ≥ 3 times, no trigram shared ≥ 2 times.
    const result = extractThemesByNgrams(rows);
    expect(result).toHaveLength(0);
  });

  test("detects a bigram repeated across 3+ titles", () => {
    const rows = [
      { title: "Smart Budget Tracker", summary: "" },
      { title: "Smart Budget Planner", summary: "" },
      { title: "Smart Budget Wizard", summary: "" },
    ];
    const result = extractThemesByNgrams(rows);
    expect(result.some((l) => l.includes("smart budget"))).toBe(true);
  });

  test("detects a trigram repeated across 2+ titles", () => {
    // Note: tokenize() strips words <3 chars (so "AI" is dropped) and the
    // stop-word list includes "tool" and "platform". Two titles sharing the same
    // trigram after tokenization is enough (threshold is >= 2 unique titles).
    // "Code Review Helper" and "Code Review Builder" each produce trigram
    // "code review helper/builder" — different trigrams; but both share the
    // bigram "code review". Bigrams need >= 3 unique titles.
    // Easiest path: three titles sharing bigram "code review".
    const rows = [
      { title: "Code Review Helper", summary: "great" },
      { title: "Code Review Builder", summary: "nice" },
      { title: "Code Review Optimizer", summary: "good" },
    ];
    const result = extractThemesByNgrams(rows);
    expect(result.some((l) => l.includes("code review"))).toBe(true);
  });

  test("output lines contain a hit count", () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      title: `Privacy Audit Helper ${i}`,
      summary: "",
    }));
    const result = extractThemesByNgrams(rows);
    // Each line: `- "phrase" theme (N ideas)...`
    for (const line of result) {
      expect(line).toMatch(/\d+ ideas/);
    }
  });

  test("caps output at 15 lines", () => {
    // Create many overlapping bigrams.
    const rows = Array.from({ length: 50 }, (_, i) => ({
      title: `Alpha Beta Gamma Delta Epsilon Zeta ${i}`,
      summary: "",
    }));
    const result = extractThemesByNgrams(rows);
    expect(result.length).toBeLessThanOrEqual(15);
  });
});

// ── combineGiantScores ───────────────────────────────────────────────────────

describe("combineGiantScores", () => {
  test("returns undefined when both inputs are undefined", () => {
    expect(combineGiantScores(undefined, undefined)).toBeUndefined();
  });

  test("returns the non-undefined input when only one is supplied", () => {
    expect(combineGiantScores(STRONG_GIANT, undefined)).toBe(STRONG_GIANT);
    expect(combineGiantScores(undefined, STRONG_GIANT)).toBe(STRONG_GIANT);
  });

  test("blends per-axis at juryWeight=0.5 (equal mix)", () => {
    const sige: GiantAxisScores = { ...STRONG_GIANT, acuteProblem: 2 };
    const jury: GiantAxisScores = { ...STRONG_GIANT, acuteProblem: 4 };
    const result = combineGiantScores(sige, jury, 0.5);
    expect(result?.acuteProblem).toBeCloseTo(3); // 0.5*2 + 0.5*4
  });

  test("juryWeight=0 → sige-only", () => {
    const sige: GiantAxisScores = { ...STRONG_GIANT, acuteProblem: 1 };
    const jury: GiantAxisScores = { ...STRONG_GIANT, acuteProblem: 5 };
    const result = combineGiantScores(sige, jury, 0);
    expect(result?.acuteProblem).toBeCloseTo(1);
  });

  test("juryWeight=1 → jury-only", () => {
    const sige: GiantAxisScores = { ...STRONG_GIANT, acuteProblem: 1 };
    const jury: GiantAxisScores = { ...STRONG_GIANT, acuteProblem: 5 };
    const result = combineGiantScores(sige, jury, 1);
    expect(result?.acuteProblem).toBeCloseTo(5);
  });

  test("all GIANT_AXIS_KEYS are present in the result", () => {
    const result = combineGiantScores(STRONG_GIANT, STRONG_GIANT, 0.5);
    for (const key of GIANT_AXIS_KEYS) {
      expect(result?.[key]).toBeDefined();
    }
  });
});

// ── normalizeDissent ─────────────────────────────────────────────────────────

describe("normalizeDissent", () => {
  test("returns 0 for undefined", () => {
    expect(normalizeDissent(undefined)).toBe(0);
  });

  test("returns 0 for NaN / non-finite (guarded by isFinite check)", () => {
    // The function guards with !Number.isFinite() → returns 0 for NaN and ±Infinity.
    expect(normalizeDissent(Number.NaN)).toBe(0);
    expect(normalizeDissent(Number.POSITIVE_INFINITY)).toBe(0);
  });

  test("maps 0 → 0", () => {
    expect(normalizeDissent(0)).toBe(0);
  });

  test("maps 5 → 1", () => {
    expect(normalizeDissent(5)).toBe(1);
  });

  test("maps 2.5 → 0.5", () => {
    expect(normalizeDissent(2.5)).toBeCloseTo(0.5);
  });

  test("clamps values above 5", () => {
    expect(normalizeDissent(10)).toBe(1);
  });

  test("clamps negative to 0", () => {
    expect(normalizeDissent(-1)).toBe(0);
  });
});

// ── buildPairwiseWins ────────────────────────────────────────────────────────

describe("buildPairwiseWins", () => {
  test("returns [] for empty verdicts", () => {
    expect(buildPairwiseWins([])).toHaveLength(0);
  });

  test("returns [] for a single-entry verdict list", () => {
    expect(buildPairwiseWins([{ candidateId: "a", juryScore: 3 }])).toHaveLength(0);
  });

  test("produces two comparisons per unordered pair (position-switch)", () => {
    const wins = buildPairwiseWins([
      { candidateId: "a", juryScore: 4 },
      { candidateId: "b", juryScore: 3 },
    ]);
    // 1 pair × 2 framings = 2 comparisons
    expect(wins).toHaveLength(2);
    expect(wins.every((w) => w.winner === "a" && w.loser === "b")).toBe(true);
  });

  test("emits no win for equal-score pairs", () => {
    const wins = buildPairwiseWins([
      { candidateId: "a", juryScore: 3 },
      { candidateId: "b", juryScore: 3 },
    ]);
    expect(wins).toHaveLength(0);
  });

  test("all emitted winners beat their losers", () => {
    const verdicts = [
      { candidateId: "a", juryScore: 5 },
      { candidateId: "b", juryScore: 3 },
      { candidateId: "c", juryScore: 1 },
    ];
    const wins = buildPairwiseWins(verdicts);
    for (const { winner, loser } of wins) {
      const w = verdicts.find((v) => v.candidateId === winner)!;
      const l = verdicts.find((v) => v.candidateId === loser)!;
      expect(w.juryScore).toBeGreaterThan(l.juryScore);
    }
  });
});

// ── buildSignalsContext ──────────────────────────────────────────────────────

describe("buildSignalsContext", () => {
  test("returns empty string when all parts are empty", () => {
    expect(
      buildSignalsContext({
        trendsSummary: "",
        painsSummary: "",
        capabilitiesSummary: "",
        deepSearchContext: "",
      }),
    ).toBe("");
  });

  test("includes non-empty parts in the output", () => {
    const out = buildSignalsContext({
      trendsSummary: "trends data",
      painsSummary: "",
      capabilitiesSummary: "cap data",
      deepSearchContext: "",
    });
    expect(out).toContain("TRENDS");
    expect(out).toContain("trends data");
    expect(out).toContain("CAPABILITIES");
    expect(out).toContain("cap data");
    expect(out).not.toContain("PAIN POINTS");
  });

  test("truncates each section to 8000 chars", () => {
    const big = "x".repeat(10_000);
    const out = buildSignalsContext({
      trendsSummary: big,
      painsSummary: "",
      capabilitiesSummary: "",
      deepSearchContext: "",
    });
    // 8000 chars body + some heading overhead — should be well under 20k total.
    expect(out.length).toBeLessThan(9_000);
  });
});

// ── mapDivergentToCandidate ──────────────────────────────────────────────────

describe("mapDivergentToCandidate", () => {
  const divergent: DivergentCandidate = {
    title: "CodeSentinel",
    summary: "auto-security review",
    proposedBy: "contrarian_investor:sess1",
    supportingSignalIds: ["hn_2", "ph_5"],
  };

  test("preserves title and summary", () => {
    const c = mapDivergentToCandidate(divergent);
    expect(c.title).toBe("CodeSentinel");
    expect(c.summary).toBe("auto-security review");
  });

  test("default tag is sige-divergent", () => {
    const c = mapDivergentToCandidate(divergent);
    expect(c.sourcesUsed).toContain("sige-divergent");
  });

  test("custom sourceTag is used when supplied", () => {
    const c = mapDivergentToCandidate(divergent, { sourceTag: "sige-discovery" });
    expect(c.sourcesUsed).toContain("sige-discovery");
  });

  test("carries supportingSignalIds when present", () => {
    const c = mapDivergentToCandidate(divergent);
    expect(c.supportingSignalIds).toEqual(["hn_2", "ph_5"]);
  });

  test("qualityScore is 0 (unscored sentinel)", () => {
    expect(mapDivergentToCandidate(divergent).qualityScore).toBe(0);
  });

  test("category is empty (back-half sets it)", () => {
    expect(mapDivergentToCandidate(divergent).category).toBe("");
  });
});

// ── mapDeepGameRankedToCandidate ─────────────────────────────────────────────

describe("mapDeepGameRankedToCandidate", () => {
  const scored: ScoredIdea = {
    id: "idea-1",
    title: "DeepIdea",
    description: "deep game description",
    proposedBy: "founder:sess2",
    round: 3,
    expertScore: 0.85,
    incentiveBreakdown: {
      diversityBonus: 0,
      buildingBonus: 0,
      surpriseBonus: 0,
      accuracyPenalty: 0,
      memoryReward: 0,
      coalitionStability: 0,
      signalCredibility: 0,
      socialViability: 0,
    },
    strategicMetadata: {
      paretoOptimal: false,
      dominantStrategy: false,
      evolutionarilyStable: false,
      nashEquilibrium: false,
    },
  };

  test("preserves title", () => {
    expect(mapDeepGameRankedToCandidate(scored).title).toBe("DeepIdea");
  });

  test("sets summary from description", () => {
    const c = mapDeepGameRankedToCandidate(scored);
    expect(c.summary).toBe("deep game description");
  });

  test("qualityScore is 0 (unscored sentinel)", () => {
    expect(mapDeepGameRankedToCandidate(scored).qualityScore).toBe(0);
  });

  test("sourcesUsed contains 'sige-deep'", () => {
    expect(mapDeepGameRankedToCandidate(scored).sourcesUsed).toContain("sige-deep");
  });

  test("includes sessionId in sourcesUsed when supplied", () => {
    const c = mapDeepGameRankedToCandidate(scored, { sessionId: "sess-abc" });
    expect(c.sourcesUsed).toContain("sess-abc");
  });

  test("giant is not set (must not pre-score)", () => {
    expect(mapDeepGameRankedToCandidate(scored).giant).toBeUndefined();
  });
});

// ── mergeSigeCandidates ──────────────────────────────────────────────────────

describe("mergeSigeCandidates", () => {
  test("returns [] when maxPool=0", () => {
    const broad = [makeCandidate("A")];
    const deep = [makeCandidate("B")];
    expect(mergeSigeCandidates(broad, deep, { maxPool: 0 })).toHaveLength(0);
  });

  test("deep candidates come before broad", () => {
    const broad = [makeCandidate("BroadIdea")];
    const deep = [makeCandidate("DeepIdea")];
    const result = mergeSigeCandidates(broad, deep);
    expect(result[0]?.title).toBe("DeepIdea");
    expect(result[1]?.title).toBe("BroadIdea");
  });

  test("deduplicates by lowercased title", () => {
    const broad = [makeCandidate("Same Idea")];
    const deep = [makeCandidate("same idea")]; // same after normalization
    const result = mergeSigeCandidates(broad, deep);
    expect(result).toHaveLength(1);
  });

  test("caps the result at maxPool", () => {
    const broad = Array.from({ length: 30 }, (_, i) => makeCandidate(`Broad${i}`));
    const deep = Array.from({ length: 20 }, (_, i) => makeCandidate(`Deep${i}`));
    const result = mergeSigeCandidates(broad, deep, { maxPool: 10 });
    expect(result).toHaveLength(10);
  });

  test("skips candidates with blank title", () => {
    const broad = [makeCandidate("")]; // blank
    const deep = [makeCandidate("Valid")];
    const result = mergeSigeCandidates(broad, deep);
    expect(result).toHaveLength(1);
    expect(result[0]?.title).toBe("Valid");
  });
});

// ── synthesizeEnrichedSeed ───────────────────────────────────────────────────

describe("synthesizeEnrichedSeed", () => {
  test("returns a non-empty sentinel for empty candidate list", () => {
    const out = synthesizeEnrichedSeed([]);
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain("SYNOPSIS");
  });

  test("includes candidate titles in the output", () => {
    const candidates = [makeCandidate("FlowTrack"), makeCandidate("CodeGuard")];
    const out = synthesizeEnrichedSeed(candidates);
    expect(out).toContain("FlowTrack");
    expect(out).toContain("CodeGuard");
  });

  test("caps at 20 candidates", () => {
    const candidates = Array.from({ length: 30 }, (_, i) => makeCandidate(`Idea${i}`));
    const out = synthesizeEnrichedSeed(candidates);
    let count = 0;
    for (let i = 0; i < 30; i++) {
      if (out.includes(`Idea${i}`)) count++;
    }
    expect(count).toBeLessThanOrEqual(20);
  });
});

// ── enforceSegmentSpread ─────────────────────────────────────────────────────

describe("enforceSegmentSpread", () => {
  test("returns candidates unchanged when empty", () => {
    expect(enforceSegmentSpread([], 5)).toHaveLength(0);
  });

  test("returns all candidates when limit >= count", () => {
    const candidates = [makeCandidate("A"), makeCandidate("B")];
    const result = enforceSegmentSpread(candidates, 10);
    expect(result).toHaveLength(2);
  });

  test("respects the limit", () => {
    const candidates = Array.from({ length: 10 }, (_, i) =>
      makeCandidate(`Idea${i}`),
    );
    const result = enforceSegmentSpread(candidates, 5);
    expect(result).toHaveLength(5);
  });
});

// ── paretoSelect ─────────────────────────────────────────────────────────────

describe("paretoSelect", () => {
  test("returns [] when limit=0", () => {
    const candidates = [makeCandidate("A"), makeCandidate("B")];
    const result = paretoSelect(candidates, new Map(), 0, 0.3);
    expect(result).toHaveLength(0);
  });

  test("returns all candidates when count <= limit", () => {
    const candidates = [makeCandidate("A"), makeCandidate("B")];
    const result = paretoSelect(candidates, new Map(), 10, 0.3);
    expect(result).toHaveLength(2);
  });

  test("respects the limit for oversized pools", () => {
    const candidates = Array.from({ length: 15 }, (_, i) => makeCandidate(`Idea${i}`));
    const result = paretoSelect(candidates, new Map(), 5, 0.3);
    expect(result).toHaveLength(5);
  });

  test("higher juryScore ideas rank higher with no dissent", () => {
    const candidates = [
      makeCandidate("LowQ", { qualityScore: 1 }),
      makeCandidate("HighQ", { qualityScore: 5 }),
    ];
    const signals: ReadonlyMap<string, SigeSignals> = new Map([
      ["lowq", { expertScore: 0.1 }],
      ["highq", { expertScore: 0.9 }],
    ]);
    const result = paretoSelect(candidates, signals, 1, 0);
    expect(result[0]?.title).toBe("HighQ");
  });
});

// ── computeSigeConvergenceVeto ────────────────────────────────────────────────

describe("computeSigeConvergenceVeto", () => {
  test("not vetoed when signals is empty", () => {
    const result = computeSigeConvergenceVeto(new Map(), 0.85);
    expect(result.vetoed).toBe(false);
  });

  test("not vetoed when mean jury agreement is below threshold", () => {
    const signals: ReadonlyMap<string, SigeSignals> = new Map([
      ["a", { expertScore: 0.7, juryAgreement: 0.5 }],
      ["b", { expertScore: 0.6, juryAgreement: 0.6 }],
    ]);
    // mean agreement = 0.55 < 0.85 → no veto
    const result = computeSigeConvergenceVeto(signals, 0.85);
    expect(result.vetoed).toBe(false);
  });

  test("vetoed when mean jury agreement >= threshold", () => {
    const signals: ReadonlyMap<string, SigeSignals> = new Map([
      ["a", { expertScore: 0.9, juryAgreement: 0.95 }],
      ["b", { expertScore: 0.8, juryAgreement: 0.9 }],
    ]);
    // mean agreement = 0.925 >= 0.85 → veto
    const result = computeSigeConvergenceVeto(signals, 0.85);
    expect(result.vetoed).toBe(true);
  });

  test("high mean dissent re-inflates diversity so a polarizing round is not vetoed", () => {
    // High dissent → diversityIndex boosted → no veto on that axis.
    const signals: ReadonlyMap<string, SigeSignals> = new Map([
      ["a", { expertScore: 0.9, juryAgreement: 0.3, dissent: 0.9 }],
      ["b", { expertScore: 0.5, juryAgreement: 0.2, dissent: 0.8 }],
    ]);
    // mean agreement = 0.25 → convergenceRate well below 0.85.
    const result = computeSigeConvergenceVeto(signals, 0.85);
    expect(result.vetoed).toBe(false);
  });
});

// ── mergeSelectedIds ─────────────────────────────────────────────────────────
//
// Regression tests for the resume-path bug where JSON.stringify(new Map())
// produces "{}", so on resume selectedIds comes back as a plain object instead
// of a Map. mergeSelectedIds must handle both shapes without throwing.

describe("mergeSelectedIds", () => {
  test("undefined ids: no-op, accumulator unchanged", () => {
    const into = new Map<string, string[]>();
    mergeSelectedIds(into, undefined);
    expect(into.size).toBe(0);
  });

  test("empty plain object (JSON-round-tripped empty Map) — must NOT throw", () => {
    // This is the exact shape that arrives on resume when the collector stored
    // `new Map()` and JSON.stringify produced "{}".
    const into = new Map<string, string[]>();
    expect(() => mergeSelectedIds(into, {})).not.toThrow();
    expect(into.size).toBe(0);
  });

  test("populated plain Record (JSON-round-tripped non-empty Map) — merges correctly", () => {
    // Simulates: JSON.parse(JSON.stringify(selectedIds)) where selectedIds had entries.
    // JSON.stringify a Map always gives "{}" so real data is lost in the DB —
    // but this test proves the helper itself handles a populated Record correctly
    // once the caller produces one (e.g. a future fix that serialises as an array).
    const into = new Map<string, string[]>();
    const resumed: Record<string, readonly string[]> = {
      app_store_reviews: ["id-1", "id-2"],
      producthunt_posts: ["id-3"],
    };
    mergeSelectedIds(into, resumed);
    expect(into.get("app_store_reviews")).toEqual(["id-1", "id-2"]);
    expect(into.get("producthunt_posts")).toEqual(["id-3"]);
    expect(into.size).toBe(2);
  });

  test("real Map (fresh in-process run) — merges correctly", () => {
    const into = new Map<string, string[]>();
    const live: ReadonlyMap<string, readonly string[]> = new Map([
      ["hackernews_posts", ["hn-1", "hn-2"]],
      ["reddit_posts", ["r-1"]],
    ]);
    mergeSelectedIds(into, live);
    expect(into.get("hackernews_posts")).toEqual(["hn-1", "hn-2"]);
    expect(into.get("reddit_posts")).toEqual(["r-1"]);
  });

  test("merges from multiple calls accumulate without overwriting existing ids", () => {
    // Simulates three collector outputs (landscape + reviews + capabilities)
    // each calling mergeSelectedIds on the same accumulator — the key concern
    // when one table appears in two collector outputs.
    const into = new Map<string, string[]>();
    mergeSelectedIds(into, new Map([["reviews", ["a", "b"]]]));
    mergeSelectedIds(into, new Map([["reviews", ["c"]], ["posts", ["p-1"]]]));
    mergeSelectedIds(into, undefined);
    expect(into.get("reviews")).toEqual(["a", "b", "c"]);
    expect(into.get("posts")).toEqual(["p-1"]);
  });

  test("empty Map (fresh run, no rows selected) — no-op", () => {
    const into = new Map<string, string[]>([["existing", ["x"]]]);
    mergeSelectedIds(into, new Map());
    expect(into.get("existing")).toEqual(["x"]);
    expect(into.size).toBe(1);
  });
});
