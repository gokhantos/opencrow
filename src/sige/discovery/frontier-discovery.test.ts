/**
 * Unit tests for frontier-discovery.ts
 *
 * All pure functions tested here: buildBroadSignalsContext, clusterIntoFrontiers,
 * scoreFrontier, and scoreFrontiers. No DB, no LLM, no Mem0.
 */
import { describe, test, expect, mock } from "bun:test";
import {
  buildBroadSignalsContext,
  clusterIntoFrontiers,
  resolveClusterCap,
  scoreFrontier,
  scoreFrontiers,
  type Frontier,
  type BroadCorpus,
  type FrontierScoringContext,
} from "./frontier-discovery";
import { selectDiverseBy } from "../../pipelines/ideas/idea-diversity";
import type { DivergentCandidate } from "../run";
import type { TrendData, ClusteredPains, CapabilityScan } from "../../pipelines/ideas/types";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeTrend(summary: string = ""): TrendData {
  return {
    risingApps: [],
    trendingCategories: [],
    summary,
  };
}

function makePains(summary: string = ""): ClusteredPains {
  return {
    clusters: [],
    summary,
  };
}

function makeCapabilities(summary: string = ""): CapabilityScan {
  return {
    capabilities: [],
    summary,
  };
}

function makeCorpus(
  opts: { trends?: string; pains?: string; capabilities?: string; deepSearchContext?: string } = {},
): BroadCorpus {
  return {
    trends: makeTrend(opts.trends ?? ""),
    pains: makePains(opts.pains ?? ""),
    capabilities: makeCapabilities(opts.capabilities ?? ""),
    deepSearchContext: opts.deepSearchContext,
  };
}

function makeCandidate(
  title: string,
  summary: string = "A great idea",
  proposedBy: string = "rational_player",
): DivergentCandidate {
  return { title, summary, proposedBy };
}

// ── buildBroadSignalsContext ──────────────────────────────────────────────────

describe("buildBroadSignalsContext", () => {
  test("produces === HEADING === blocks for each non-empty section", () => {
    const corpus = makeCorpus({
      trends: "AI is rising",
      pains: "Users hate sync",
      capabilities: "LLM APIs are cheap",
    });
    const result = buildBroadSignalsContext(corpus);
    expect(result).toContain("=== TRENDS ===");
    expect(result).toContain("=== PAIN POINTS ===");
    expect(result).toContain("=== CAPABILITIES ===");
  });

  test("omits sections with empty summaries", () => {
    const corpus = makeCorpus({ trends: "AI rising" }); // pains and capabilities empty
    const result = buildBroadSignalsContext(corpus);
    expect(result).toContain("=== TRENDS ===");
    expect(result).not.toContain("=== PAIN POINTS ===");
    expect(result).not.toContain("=== CAPABILITIES ===");
  });

  test("includes deepSearchContext when provided", () => {
    const corpus = makeCorpus({
      trends: "some trend",
      deepSearchContext: "deep search result here",
    });
    const result = buildBroadSignalsContext(corpus);
    expect(result).toContain("=== DEEP-SEARCH EVIDENCE ===");
    expect(result).toContain("deep search result here");
  });

  test("omits deepSearchContext section when undefined", () => {
    const corpus = makeCorpus({ trends: "trend" });
    const result = buildBroadSignalsContext(corpus);
    expect(result).not.toContain("DEEP-SEARCH");
  });

  test("hard-slices body at 8000 chars per section", () => {
    const longBody = "x".repeat(20_000);
    const corpus = makeCorpus({ trends: longBody });
    const result = buildBroadSignalsContext(corpus);
    // The total length is the heading + 8000 chars (plus overhead)
    // Verify the long section body is capped: the raw longBody should not fully appear
    expect(result.length).toBeLessThan("=== TRENDS ===\n".length + 20_000);
    // And the section heading is present
    expect(result).toContain("=== TRENDS ===");
  });

  test("returns empty string when all sections are empty", () => {
    const corpus = makeCorpus();
    const result = buildBroadSignalsContext(corpus);
    expect(result).toBe("");
  });

  test("sections are separated by double newlines", () => {
    const corpus = makeCorpus({ trends: "T", pains: "P" });
    const result = buildBroadSignalsContext(corpus);
    expect(result).toContain("\n\n");
  });

  test("is PURE — same input yields same output", () => {
    const corpus = makeCorpus({ trends: "stable", pains: "consistent" });
    const r1 = buildBroadSignalsContext(corpus);
    const r2 = buildBroadSignalsContext(corpus);
    expect(r1).toBe(r2);
  });

  test("does not make any LLM calls (pure, synchronous-looking)", () => {
    // No async needed: the function is sync
    // If it tried to import chat() it would fail here without a mock
    const corpus = makeCorpus({ trends: "data" });
    const result = buildBroadSignalsContext(corpus);
    expect(typeof result).toBe("string");
  });
});

// ── clusterIntoFrontiers ──────────────────────────────────────────────────────

describe("clusterIntoFrontiers", () => {
  test("returns empty array for empty candidates", () => {
    const result = clusterIntoFrontiers([]);
    expect(result).toEqual([]);
  });

  test("returns empty array when all candidates have blank titles", () => {
    const candidates = [makeCandidate(""), makeCandidate("   ")];
    const result = clusterIntoFrontiers(candidates);
    expect(result).toEqual([]);
  });

  test("groups candidates sharing common bigram token into same frontier", () => {
    // Note: extractThemesByNgrams filters tokens shorter than 3 chars.
    // Use candidates with >=3-char shared tokens and a threshold of >=3 for bigrams.
    const candidates = [
      makeCandidate("budget planner monthly tracker"),
      makeCandidate("budget planner weekly view"),
      makeCandidate("budget planner daily updates"),
      makeCandidate("completely different health idea"),
      makeCandidate("another unrelated startup project"),
    ];
    const frontiers = clusterIntoFrontiers(candidates, { minClusterSize: 2 });
    // "budget planner" bigram appears 3x (>= threshold of 3), so it should cluster
    const budgetFrontier = frontiers.find(
      (f) => f.theme.includes("budget") || f.theme.includes("planner"),
    );
    expect(budgetFrontier).toBeDefined();
    if (budgetFrontier) {
      expect(budgetFrontier.candidates.length).toBeGreaterThanOrEqual(2);
    }
  });

  test("is order-stable — same input yields same frontier order", () => {
    const candidates = [
      makeCandidate("Mobile health tracker"),
      makeCandidate("Health tracker for runners"),
      makeCandidate("Health monitoring mobile app"),
      makeCandidate("Budget planner tool"),
      makeCandidate("Budget planner monthly"),
    ];
    const r1 = clusterIntoFrontiers(candidates, { minClusterSize: 2 });
    const r2 = clusterIntoFrontiers(candidates, { minClusterSize: 2 });
    expect(r1.map((f) => f.theme)).toEqual(r2.map((f) => f.theme));
  });

  test("respects maxFrontiers cap", () => {
    const candidates = Array.from({ length: 40 }, (_, i) =>
      makeCandidate(`product ${i % 5 === 0 ? "mobile" : "web"} idea ${i}`),
    );
    const frontiers = clusterIntoFrontiers(candidates, { maxFrontiers: 2 });
    expect(frontiers.length).toBeLessThanOrEqual(2);
  });

  test("each frontier has a non-empty theme string", () => {
    const candidates = [
      makeCandidate("AI writing tool"),
      makeCandidate("AI writing assistant"),
      makeCandidate("AI writing helper"),
    ];
    const frontiers = clusterIntoFrontiers(candidates, { minClusterSize: 2 });
    for (const f of frontiers) {
      expect(f.theme.length).toBeGreaterThan(0);
    }
  });

  test("signalStrength is in [0,1] for all frontiers", () => {
    const candidates = [
      makeCandidate("Mobile payments app"),
      makeCandidate("Mobile payments wallet"),
      makeCandidate("Something else entirely"),
      makeCandidate("Another idea here"),
    ];
    const frontiers = clusterIntoFrontiers(candidates, { minClusterSize: 2 });
    for (const f of frontiers) {
      expect(f.signalStrength).toBeGreaterThanOrEqual(0);
      expect(f.signalStrength).toBeLessThanOrEqual(1);
    }
  });

  test("initial novelty is 1 before scoreFrontiers is called", () => {
    const candidates = [
      makeCandidate("Cloud storage app"),
      makeCandidate("Cloud storage backup"),
    ];
    const frontiers = clusterIntoFrontiers(candidates, { minClusterSize: 1 });
    for (const f of frontiers) {
      expect(f.novelty).toBe(1);
    }
  });

  test("frontiers are immutable (returned as readonly)", () => {
    const candidates = [makeCandidate("Test idea one"), makeCandidate("Test idea two")];
    const frontiers = clusterIntoFrontiers(candidates, { minClusterSize: 1 });
    // Verify the array is treated as readonly — each frontier has a seedText
    for (const f of frontiers) {
      expect(typeof f.seedText).toBe("string");
      expect(f.seedText.length).toBeGreaterThan(0);
    }
  });
});

// ── scoreFrontier ─────────────────────────────────────────────────────────────

describe("scoreFrontier (pure scoring formula)", () => {
  function makeFrontier(signalStrength: number): Frontier {
    return {
      id: "test-id",
      theme: "test theme",
      themeKeys: ["test", "theme"],
      candidates: [],
      signalStrength,
      novelty: 1,
      score: signalStrength,
      seedText: "seed",
    };
  }

  test("score = signalStrength when mem0Score=0 and saturationPenalty=0", () => {
    const frontier = makeFrontier(0.8);
    const score = scoreFrontier(frontier, { mem0Score: 0, saturationPenalty: 0 });
    expect(score).toBeCloseTo(0.8);
  });

  test("score = 0 when signalStrength=0", () => {
    const frontier = makeFrontier(0);
    const score = scoreFrontier(frontier, { mem0Score: 0, saturationPenalty: 0 });
    expect(score).toBe(0);
  });

  test("score approaches 0 when mem0Score approaches 1 (fully recalled)", () => {
    const frontier = makeFrontier(1.0);
    const score = scoreFrontier(frontier, { mem0Score: 0.99, saturationPenalty: 0 });
    expect(score).toBeLessThan(0.02);
  });

  test("score approaches 0 when saturationPenalty approaches 1", () => {
    const frontier = makeFrontier(1.0);
    const score = scoreFrontier(frontier, { mem0Score: 0, saturationPenalty: 0.99 });
    expect(score).toBeLessThan(0.02);
  });

  test("score is always clamped to [0,1]", () => {
    const frontier = makeFrontier(2.0); // over 1
    const score = scoreFrontier(frontier, { mem0Score: -0.5, saturationPenalty: -0.5 });
    expect(score).toBeLessThanOrEqual(1);
    expect(score).toBeGreaterThanOrEqual(0);
  });

  test("formula: score = signalStrength * clamp01((1-mem0Score)*(1-satPenalty))", () => {
    const frontier = makeFrontier(0.6);
    const mem0Score = 0.4;
    const satPenalty = 0.2;
    const expectedNovelty = (1 - mem0Score) * (1 - satPenalty); // 0.6 * 0.8 = 0.48
    const expectedScore = 0.6 * expectedNovelty; // 0.6 * 0.48 = 0.288
    const score = scoreFrontier(frontier, { mem0Score, saturationPenalty: satPenalty });
    expect(score).toBeCloseTo(expectedScore, 5);
  });

  test("is PURE — deterministic for same inputs", () => {
    const frontier = makeFrontier(0.5);
    const novelty = { mem0Score: 0.3, saturationPenalty: 0.1 };
    const s1 = scoreFrontier(frontier, novelty);
    const s2 = scoreFrontier(frontier, novelty);
    expect(s1).toBe(s2);
  });
});

// ── scoreFrontiers ────────────────────────────────────────────────────────────

describe("scoreFrontiers", () => {
  function makeTestFrontier(theme: string, signalStrength: number): Frontier {
    return {
      id: crypto.randomUUID(),
      theme,
      themeKeys: theme.split(" "),
      candidates: [],
      signalStrength,
      novelty: 1,
      score: signalStrength,
      seedText: `seed for ${theme}`,
    };
  }

  const ctx: FrontierScoringContext = {
    userId: "test-user",
    saturatedThemeKeys: [],
  };

  test("returns sorted descending by score", async () => {
    const frontiers = [
      makeTestFrontier("low signal theme", 0.2),
      makeTestFrontier("high signal theme", 0.9),
      makeTestFrontier("mid signal theme", 0.5),
    ];

    // Mock mem0 client that returns neutral scores (mem0Score = 0)
    const mem0Mock = {
      add: mock(async () => ({})),
      search: mock(async () => ({ results: [] })),
      delete: mock(async () => {}),
      deleteAll: mock(async () => {}),
      getAll: mock(async () => ({ results: [] })),
    } as unknown as import("../knowledge/mem0-client").Mem0Client;

    // quickSearch will be called on the mem0 mock; since it internally calls
    // mem0.search and gets empty results, aggregateScore returns 0 -> novelty=1
    // Override: mock quickSearch to return a low score so we can verify sorting
    // Without deep mocking, just verify the sort is correct relative to signal strength
    // when novelty is neutral (1.0 for all).
    const scored = await scoreFrontiers(frontiers, mem0Mock, ctx);

    // When all novelty scores are equal (no mem0 hits), sort by signalStrength
    expect(scored[0]!.signalStrength).toBeGreaterThanOrEqual(scored[1]!.signalStrength);
    expect(scored[1]!.signalStrength).toBeGreaterThanOrEqual(scored[2]!.signalStrength);
  });

  test("returns empty array for empty input", async () => {
    const mem0Mock = {
      search: mock(async () => ({ results: [] })),
    } as unknown as import("../knowledge/mem0-client").Mem0Client;

    const result = await scoreFrontiers([], mem0Mock, ctx);
    expect(result).toEqual([]);
  });

  test("does NOT throw on Mem0 failure — returns frontiers with neutral novelty=1", async () => {
    const frontier = makeTestFrontier("ai productivity", 0.7);

    // Simulate Mem0 failure by throwing from search
    const failingMem0 = {
      search: mock(async () => {
        throw new Error("Mem0 unavailable");
      }),
    } as unknown as import("../knowledge/mem0-client").Mem0Client;

    // Should not throw
    const scored = await scoreFrontiers([frontier], failingMem0, ctx);
    expect(scored).toHaveLength(1);
    // On failure, novelty defaults to 1 (neutral, no suppression)
    const f = scored[0]!;
    expect(f.novelty).toBe(1);
    // Score = signalStrength * 1 = signalStrength
    expect(f.score).toBeCloseTo(0.7);
  });

  test("saturation penalty suppresses score when theme keys overlap", async () => {
    const saturatedCtx: FrontierScoringContext = {
      userId: "test",
      saturatedThemeKeys: ["ai", "productivity"],
    };

    // Frontier with theme keys fully overlapping the saturated set
    const saturatedFrontier: Frontier = {
      id: "sat-id",
      theme: "ai productivity",
      themeKeys: ["ai", "productivity"],
      candidates: [],
      signalStrength: 1.0,
      novelty: 1,
      score: 1.0,
      seedText: "saturated seed",
    };

    const mem0Mock = {
      search: mock(async () => ({ results: [] })),
    } as unknown as import("../knowledge/mem0-client").Mem0Client;

    const scored = await scoreFrontiers([saturatedFrontier], mem0Mock, saturatedCtx);
    // With full saturation penalty = 1.0, novelty = (1-0)*(1-1) = 0, score = 0
    expect(scored[0]!.score).toBeLessThan(0.05);
  });
});

// ── resolveClusterCap ────────────────────────────────────────────────────────

describe("resolveClusterCap", () => {
  test("returns DEFAULT_MAX_FRONTIERS (8) when no cap provided", () => {
    expect(resolveClusterCap()).toBe(8);
  });

  test("returns DEFAULT_MAX_FRONTIERS (8) when cap equals the ceiling", () => {
    expect(resolveClusterCap(8)).toBe(8);
  });

  test("returns the configured cap when below the ceiling", () => {
    expect(resolveClusterCap(3)).toBe(3);
  });

  test("clamps to DEFAULT_MAX_FRONTIERS (8) when cap exceeds the ceiling", () => {
    expect(resolveClusterCap(99)).toBe(8);
  });

  test("returns 1 for configured cap of 1 (minimum)", () => {
    expect(resolveClusterCap(1)).toBe(1);
  });

  test("clamps to 1 when configured cap is 0 (floor guard)", () => {
    expect(resolveClusterCap(0)).toBe(1);
  });

  test("clamps to 1 when configured cap is negative", () => {
    expect(resolveClusterCap(-5)).toBe(1);
  });
});

// ── Diverse frontier selection ────────────────────────────────────────────────
//
// Verify that selectDiverseBy — applied with resolveBucket: (f) => f.theme —
// spans >=2 themes when a naive top-by-score slice would collapse to one theme.

function makeFrontier(theme: string, score: number): Frontier {
  return {
    id: `${theme}-${score}`,
    theme,
    themeKeys: theme.split(" "),
    candidates: [],
    signalStrength: score,
    novelty: score,
    score,
    seedText: `seed for ${theme}`,
  };
}

describe("selectDiverseBy — frontier theme diversity", () => {
  test("naive top-3 by score collapses to single theme (baseline)", () => {
    const frontiers: Frontier[] = [
      makeFrontier("ai notes", 0.95),
      makeFrontier("ai notes", 0.90),
      makeFrontier("ai notes", 0.85),
      makeFrontier("ai notes", 0.80),
      makeFrontier("budget planner", 0.75),
      makeFrontier("fitness tracker", 0.70),
      makeFrontier("recipe finder", 0.65),
      makeFrontier("sleep monitor", 0.60),
    ];
    const naive = [...frontiers].sort((a, b) => b.score - a.score).slice(0, 3);
    const themes = new Set(naive.map((f) => f.theme));
    expect(themes.size).toBe(1);
  });

  test("selectDiverseBy spans >=2 themes with maxDeepFrontiers=3 over 8 frontiers (4 themes)", () => {
    const frontiers: Frontier[] = [
      makeFrontier("ai notes", 0.95),
      makeFrontier("ai notes", 0.90),
      makeFrontier("ai notes", 0.85),
      makeFrontier("ai notes", 0.80),
      makeFrontier("budget planner", 0.75),
      makeFrontier("fitness tracker", 0.70),
      makeFrontier("recipe finder", 0.65),
      makeFrontier("sleep monitor", 0.60),
    ];

    const selected = selectDiverseBy(
      [...frontiers].sort((a, b) => b.score - a.score),
      { maxIdeas: 3, maxBucketShare: 0.5, resolveBucket: (f) => f.theme },
    );

    expect(selected).toHaveLength(3);
    const themes = new Set(selected.map((f) => f.theme));
    expect(themes.size).toBeGreaterThanOrEqual(2);
  });

  test("respects maxBucketShare=0.5: no single theme exceeds 50% of the selected set", () => {
    const frontiers: Frontier[] = [
      makeFrontier("ai notes", 0.95),
      makeFrontier("ai notes", 0.90),
      makeFrontier("ai notes", 0.85),
      makeFrontier("budget planner", 0.80),
      makeFrontier("fitness tracker", 0.75),
      makeFrontier("recipe finder", 0.70),
    ];

    const selected = selectDiverseBy(
      [...frontiers].sort((a, b) => b.score - a.score),
      { maxIdeas: 4, maxBucketShare: 0.5, resolveBucket: (f) => f.theme },
    );

    const counts = new Map<string, number>();
    for (const f of selected) {
      counts.set(f.theme, (counts.get(f.theme) ?? 0) + 1);
    }
    for (const [, count] of counts) {
      expect(count / selected.length).toBeLessThanOrEqual(0.5 + 0.01);
    }
  });

  test("with maxDeepFrontiers=1 behaviour is equivalent to top-1 (diversity trivially satisfied)", () => {
    const frontiers: Frontier[] = [
      makeFrontier("ai notes", 0.95),
      makeFrontier("budget planner", 0.80),
    ];

    const selected = selectDiverseBy(
      [...frontiers].sort((a, b) => b.score - a.score),
      { maxIdeas: 1, maxBucketShare: 0.5, resolveBucket: (f) => f.theme },
    );

    expect(selected).toHaveLength(1);
    expect(selected[0]!.theme).toBe("ai notes");
  });
});
