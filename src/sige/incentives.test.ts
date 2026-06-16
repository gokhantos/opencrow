import { test, expect, describe } from "bun:test";
import {
  diversityBonus,
  buildingBonus,
  surpriseBonus,
  accuracyPenalty,
  memoryReward,
  coalitionStability,
  signalCredibility,
  applyIncentives,
  computeIncentives,
  computeAutoBalancing,
} from "./incentives";
import type {
  ScoredIdea,
  StrategicMetadata,
  IncentiveBreakdown,
  IncentiveWeights,
} from "./types";

// ── Fixtures ───────────────────────────────────────────────────────────────

function makeMetadata(overrides: Partial<StrategicMetadata> = {}): StrategicMetadata {
  return {
    paretoOptimal: true,
    dominantStrategy: false,
    evolutionarilyStable: true,
    nashEquilibrium: true,
    ...overrides,
  };
}

function makeIdea(overrides: Partial<ScoredIdea> = {}): ScoredIdea {
  return {
    id: "idea-1",
    title: "Title",
    description: "Description",
    proposedBy: "agent-a",
    round: 1,
    expertScore: 0.5,
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
    strategicMetadata: makeMetadata(),
    ...overrides,
  };
}

// ── diversityBonus ─────────────────────────────────────────────────────────

describe("diversityBonus", () => {
  test("returns neutral 0.5 when there are no other ideas", () => {
    const idea = makeIdea();
    expect(diversityBonus(idea, [idea])).toBe(0.5);
  });

  test("identical ideas yield zero diversity (max similarity)", () => {
    const a = makeIdea({ id: "a", title: "shared words here", description: "common text body" });
    const b = makeIdea({ id: "b", title: "shared words here", description: "common text body" });
    // Identical token sets → similarity 1 → distance 0.
    expect(diversityBonus(a, [a, b])).toBe(0);
  });

  test("fully disjoint ideas yield maximum diversity of 1", () => {
    const a = makeIdea({ id: "a", title: "alpha bravo charlie", description: "delta echo foxtrot" });
    const b = makeIdea({ id: "b", title: "zulu yankee xray", description: "whiskey victor uniform" });
    expect(diversityBonus(a, [a, b])).toBe(1);
  });

  test("result is bounded within [0, 1]", () => {
    const a = makeIdea({ id: "a", title: "one two three", description: "four five six" });
    const b = makeIdea({ id: "b", title: "one two seven", description: "eight nine ten" });
    const score = diversityBonus(a, [a, b]);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});

// ── buildingBonus ──────────────────────────────────────────────────────────

describe("buildingBonus", () => {
  test("returns 0 when there are no prior ideas", () => {
    expect(buildingBonus(makeIdea(), [])).toBe(0);
  });

  test("returns 0 when no prior idea clears the 0.6 winning threshold", () => {
    const idea = makeIdea({ title: "match these tokens", description: "" });
    const weakPrior = makeIdea({ id: "p", title: "match these tokens", description: "", expertScore: 0.3 });
    expect(buildingBonus(idea, [weakPrior])).toBe(0);
  });

  test("rewards overlap with a winning prior idea (fusedScore preferred)", () => {
    const idea = makeIdea({ title: "carbon tracking app", description: "" });
    const winningPrior = makeIdea({
      id: "p",
      title: "carbon tracking app",
      description: "",
      fusedScore: 0.8,
      expertScore: 0.1,
    });
    // Identical token set → jaccard 1.
    expect(buildingBonus(idea, [winningPrior])).toBe(1);
  });

  test("falls back to expertScore when fusedScore is absent", () => {
    const idea = makeIdea({ title: "fitness coach", description: "" });
    const winningPrior = makeIdea({ id: "p", title: "fitness coach", description: "", expertScore: 0.7 });
    expect(buildingBonus(idea, [winningPrior])).toBe(1);
  });
});

// ── surpriseBonus ──────────────────────────────────────────────────────────

describe("surpriseBonus", () => {
  test("returns neutral 0.5 with no other ideas", () => {
    const idea = makeIdea();
    expect(surpriseBonus(idea, [idea])).toBe(0.5);
  });

  test("a standalone idea among similar peers scores high surprise", () => {
    const odd = makeIdea({ id: "odd", title: "quantum origami nebula", description: "" });
    const peerA = makeIdea({ id: "a", title: "social fitness tracker", description: "" });
    const peerB = makeIdea({ id: "b", title: "social fitness tracker", description: "" });
    expect(surpriseBonus(odd, [odd, peerA, peerB])).toBe(1);
  });
});

// ── accuracyPenalty ────────────────────────────────────────────────────────

describe("accuracyPenalty", () => {
  test("clean metadata incurs no penalty", () => {
    const idea = makeIdea({
      strategicMetadata: makeMetadata({
        evolutionarilyStable: true,
        paretoOptimal: true,
        nashEquilibrium: true,
        dominantStrategy: false,
      }),
    });
    expect(accuracyPenalty(idea)).toBe(0);
  });

  test("non-stable idea incurs the 0.2 penalty", () => {
    const idea = makeIdea({ strategicMetadata: makeMetadata({ evolutionarilyStable: false }) });
    expect(accuracyPenalty(idea)).toBeCloseTo(0.2, 5);
  });

  test("non-pareto AND non-nash incurs the 0.3 penalty", () => {
    const idea = makeIdea({
      strategicMetadata: makeMetadata({ paretoOptimal: false, nashEquilibrium: false }),
    });
    expect(accuracyPenalty(idea)).toBeCloseTo(0.3, 5);
  });

  test("dominant strategy adds 0.1", () => {
    const idea = makeIdea({ strategicMetadata: makeMetadata({ dominantStrategy: true }) });
    expect(accuracyPenalty(idea)).toBeCloseTo(0.1, 5);
  });

  test("penalties accumulate and clamp at 1", () => {
    const idea = makeIdea({
      strategicMetadata: makeMetadata({
        evolutionarilyStable: false,
        paretoOptimal: false,
        nashEquilibrium: false,
        dominantStrategy: true,
      }),
    });
    // 0.2 + 0.3 + 0.1 = 0.6, within bounds.
    expect(accuracyPenalty(idea)).toBeCloseTo(0.6, 5);
  });
});

// ── memoryReward ───────────────────────────────────────────────────────────

describe("memoryReward", () => {
  test("returns 0 with no prior ideas", () => {
    expect(memoryReward(makeIdea(), [])).toBe(0);
  });

  test("returns 0 when no prior idea clears the 0.65 threshold", () => {
    const idea = makeIdea({ title: "habit tracker", description: "" });
    const prior = makeIdea({ id: "p", title: "habit tracker", description: "", expertScore: 0.5 });
    expect(memoryReward(idea, [prior])).toBe(0);
  });

  test("rewards similarity to successful prior ideas above the threshold", () => {
    const idea = makeIdea({ title: "budget planner", description: "" });
    const prior = makeIdea({ id: "p", title: "budget planner", description: "", fusedScore: 0.7 });
    expect(memoryReward(idea, [prior])).toBe(1);
  });
});

// ── coalitionStability ─────────────────────────────────────────────────────

describe("coalitionStability", () => {
  test("returns 0.3 when there is no coalition", () => {
    const idea = makeIdea({ strategicMetadata: makeMetadata({ supportingCoalition: undefined }) });
    expect(coalitionStability(idea)).toBe(0.3);
  });

  test("returns 0.3 for an empty coalition", () => {
    const idea = makeIdea({ strategicMetadata: makeMetadata({ supportingCoalition: [] }) });
    expect(coalitionStability(idea)).toBe(0.3);
  });

  test("larger coalition with nash boost scores higher and clamps at 1", () => {
    const idea = makeIdea({
      strategicMetadata: makeMetadata({
        supportingCoalition: ["a", "b", "c", "d", "e"],
        nashEquilibrium: true,
      }),
    });
    // size 5 → 1.0 + 0.2 nash boost → clamped to 1.
    expect(coalitionStability(idea)).toBe(1);
  });

  test("single-member coalition without nash uses pareto boost", () => {
    const idea = makeIdea({
      strategicMetadata: makeMetadata({
        supportingCoalition: ["a"],
        nashEquilibrium: false,
        paretoOptimal: true,
      }),
    });
    // 1/5 = 0.2 size + 0.1 pareto boost = 0.3.
    expect(coalitionStability(idea)).toBeCloseTo(0.3, 5);
  });
});

// ── signalCredibility ──────────────────────────────────────────────────────

describe("signalCredibility", () => {
  test("returns neutral 0.5 for an unknown agent", () => {
    expect(signalCredibility("ghost", {})).toBe(0.5);
  });

  test("returns the recorded score for a known agent", () => {
    expect(signalCredibility("agent-a", { "agent-a": 0.8 })).toBe(0.8);
  });

  test("clamps an out-of-range score", () => {
    expect(signalCredibility("agent-a", { "agent-a": 1.7 })).toBe(1);
    expect(signalCredibility("agent-b", { "agent-b": -0.3 })).toBe(0);
  });
});

// ── applyIncentives ────────────────────────────────────────────────────────

describe("applyIncentives", () => {
  const weights: IncentiveWeights = {
    diversity: 0.2,
    building: 0.1,
    surprise: 0.1,
    accuracyPenalty: 0.5,
    socialViability: 0.1,
  };

  function makeBreakdown(overrides: Partial<IncentiveBreakdown> = {}): IncentiveBreakdown {
    return {
      diversityBonus: 0,
      buildingBonus: 0,
      surpriseBonus: 0,
      accuracyPenalty: 0,
      memoryReward: 0,
      coalitionStability: 0,
      signalCredibility: 0,
      socialViability: 0,
      ...overrides,
    };
  }

  test("adds weighted bonuses to the base score", () => {
    const result = applyIncentives(0.5, makeBreakdown({ diversityBonus: 1 }), weights);
    // 0.5 + 1 * 0.2 = 0.7.
    expect(result).toBeCloseTo(0.7, 5);
  });

  test("subtracts weighted accuracy penalty", () => {
    const result = applyIncentives(0.5, makeBreakdown({ accuracyPenalty: 0.6 }), weights);
    // 0.5 - 0.6 * 0.5 = 0.2.
    expect(result).toBeCloseTo(0.2, 5);
  });

  test("clamps the result to [0, 1]", () => {
    const high = applyIncentives(1, makeBreakdown({ diversityBonus: 1, surpriseBonus: 1 }), weights);
    expect(high).toBe(1);
    const low = applyIncentives(0, makeBreakdown({ accuracyPenalty: 1 }), weights);
    expect(low).toBe(0);
  });
});

// ── computeIncentives ──────────────────────────────────────────────────────

describe("computeIncentives", () => {
  test("assembles a full breakdown and clamps socialViability", () => {
    const idea = makeIdea({ proposedBy: "agent-a" });
    const breakdown = computeIncentives(idea, {
      allIdeas: [idea],
      socialViabilityScore: 1.5, // out of range
      weights: {
        diversity: 0.2,
        building: 0.1,
        surprise: 0.1,
        accuracyPenalty: 0.5,
        socialViability: 0.1,
      },
      agentCredibilityScores: { "agent-a": 0.9 },
    });

    expect(breakdown.socialViability).toBe(1);
    expect(breakdown.signalCredibility).toBe(0.9);
    // Single idea → diversity/surprise default to neutral 0.5.
    expect(breakdown.diversityBonus).toBe(0.5);
    expect(breakdown.surpriseBonus).toBe(0.5);
  });
});

// ── computeAutoBalancing ───────────────────────────────────────────────────

describe("computeAutoBalancing", () => {
  test("boosts diversity and surprise when diversity index is low", () => {
    const result = computeAutoBalancing({
      diversityIndex: 0.2,
      socialExpertDivergence: 0,
    });
    expect(result.diversity).toBe(0.25);
    expect(result.surprise).toBe(0.15);
  });

  test("boosts social viability on high divergence", () => {
    const result = computeAutoBalancing({
      diversityIndex: 0.9,
      socialExpertDivergence: 0.5,
    });
    expect(result.socialViability).toBe(0.1);
  });

  test("boosts building when a dominant agent role is present", () => {
    const result = computeAutoBalancing({
      diversityIndex: 0.9,
      socialExpertDivergence: 0,
      dominantAgentRole: "founder",
    });
    expect(result.building).toBe(0.05);
  });

  test("returns an empty partial when no conditions trigger", () => {
    const result = computeAutoBalancing({
      diversityIndex: 0.9,
      socialExpertDivergence: 0,
    });
    expect(result).toEqual({});
  });

  test("composes multiple adjustments together", () => {
    const result = computeAutoBalancing({
      diversityIndex: 0.1,
      socialExpertDivergence: 0.6,
      dominantAgentRole: "explorer",
    });
    expect(result).toEqual({
      diversity: 0.25,
      surprise: 0.15,
      socialViability: 0.1,
      building: 0.05,
    });
  });
});
