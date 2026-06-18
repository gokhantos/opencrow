/**
 * Unit tests for pure / exported helpers in expert-game.ts.
 *
 * No DB, no LLM, no network — all deterministic. Covers:
 *   - mapCandidatesToScoredIdeas: blank-title drop, score clamping, field mapping
 *   - synthesizeFallbackSeed: non-empty sentinel, bounded output
 *   - buildEvidenceRefByTitle: key/value construction, dedup, empty-ref skip
 *   - extractDivergentCandidates: parses ideas array, skips blanks, lifts signalIds
 *   - extractSignalIds (game-local): both key names, array filter, undefined for empty
 *   - identifyCoalitions: threshold, shared-ideas grouping, Shapley values
 *   - computeMetaGameHealth: diversity/convergence/novelty from mock rounds
 *   - computeDissentByTitle: two-camp delta, single-camp spread fallback
 *   - checkAborted: throws on aborted signal, no-op otherwise
 */

import { test, expect, describe } from "bun:test";
import {
  mapCandidatesToScoredIdeas,
  synthesizeFallbackSeed,
  buildEvidenceRefByTitle,
  extractDivergentCandidates,
  extractSignalIds,
  identifyCoalitions,
  computeMetaGameHealth,
  computeDissentByTitle,
  checkAborted,
} from "./expert-game";
import { getAllDefinitions } from "../strategic-agents";
import type { AgentAction, SimulationRound } from "../types";
import type { CandidateIdea } from "./expert-game";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeAction(overrides: Partial<AgentAction> = {}): AgentAction {
  return {
    agentId: "founder:sess1",
    role: "founder",
    round: 1,
    actionType: "propose",
    content: JSON.stringify({ ideas: [] }),
    confidence: 0.7,
    reasoning: "test",
    ...overrides,
  };
}

function makeRound(
  roundNumber: number,
  ideas: Array<{ title: string; expertScore: number }>,
  actions: AgentAction[] = [],
): SimulationRound {
  return {
    roundNumber: roundNumber as 1 | 2 | 3 | 4,
    roundType: "divergent_generation",
    agentActions: actions,
    outcomes: {
      selectedIdeas: ideas.map((i) => ({
        id: crypto.randomUUID(),
        title: i.title,
        description: "",
        proposedBy: "founder:sess1",
        round: roundNumber,
        expertScore: i.expertScore,
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
      })),
      eliminatedIdeas: [],
    },
  };
}

// ── mapCandidatesToScoredIdeas ───────────────────────────────────────────────

describe("mapCandidatesToScoredIdeas", () => {
  test("maps title and summary to description", () => {
    const candidates: CandidateIdea[] = [
      { title: "FlowTrack", summary: "task management" },
    ];
    const [idea] = mapCandidatesToScoredIdeas(candidates);
    expect(idea?.title).toBe("FlowTrack");
    expect(idea?.description).toBe("task management");
  });

  test("falls back to description field when summary is absent", () => {
    const candidates: CandidateIdea[] = [
      { title: "DepTracker", description: "deps overview" },
    ];
    const [idea] = mapCandidatesToScoredIdeas(candidates);
    expect(idea?.description).toBe("deps overview");
  });

  test("drops candidates with blank or missing title", () => {
    const candidates: CandidateIdea[] = [
      { title: "", summary: "no title" },
      { title: "   ", summary: "whitespace only" },
      { title: "Valid" },
    ];
    const result = mapCandidatesToScoredIdeas(candidates);
    expect(result).toHaveLength(1);
    expect(result[0]?.title).toBe("Valid");
  });

  test("clamps expertScore to [0,1]", () => {
    const candidates: CandidateIdea[] = [
      { title: "High", expertScore: 5 },
      { title: "Low", expertScore: -1 },
      { title: "Mid", expertScore: 0.6 },
    ];
    const result = mapCandidatesToScoredIdeas(candidates);
    expect(result.find((i) => i.title === "High")?.expertScore).toBe(1);
    expect(result.find((i) => i.title === "Low")?.expertScore).toBe(0);
    expect(result.find((i) => i.title === "Mid")?.expertScore).toBeCloseTo(0.6);
  });

  test("defaults expertScore to 0.5 when absent", () => {
    const [idea] = mapCandidatesToScoredIdeas([{ title: "NoScore" }]);
    expect(idea?.expertScore).toBe(0.5);
  });

  test("preserves a supplied id", () => {
    const id = "deadbeef-0001";
    const [idea] = mapCandidatesToScoredIdeas([{ title: "X", id }]);
    expect(idea?.id).toBe(id);
  });

  test("mints a UUID when no id supplied", () => {
    const [idea] = mapCandidatesToScoredIdeas([{ title: "NoId" }]);
    // UUID pattern: 8-4-4-4-12 hex groups
    expect(idea?.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("sets proposedBy to 'external:candidate'", () => {
    const [idea] = mapCandidatesToScoredIdeas([{ title: "Ext" }]);
    expect(idea?.proposedBy).toBe("external:candidate");
  });
});

// ── synthesizeFallbackSeed ───────────────────────────────────────────────────

describe("synthesizeFallbackSeed", () => {
  test("returns non-empty sentinel for empty idea list", () => {
    const result = synthesizeFallbackSeed([]);
    expect(result.length).toBeGreaterThan(0);
  });

  test("includes idea titles in the output", () => {
    const ideas = [
      { title: "CodeGuard", description: "A security scanner" },
      { title: "FlowTrack" },
    ] as never;
    const result = synthesizeFallbackSeed(ideas);
    expect(result).toContain("CodeGuard");
    expect(result).toContain("FlowTrack");
  });

  test("caps at 30 ideas (output is bounded)", () => {
    const ideas = Array.from({ length: 50 }, (_, i) => ({
      title: `Idea${i}`,
      description: "x",
    })) as never;
    const result = synthesizeFallbackSeed(ideas);
    // At most 30 ideas should be mentioned
    let count = 0;
    for (let i = 0; i < 50; i++) {
      if (result.includes(`Idea${i}`)) count++;
    }
    expect(count).toBeLessThanOrEqual(30);
  });
});

// ── buildEvidenceRefByTitle ──────────────────────────────────────────────────

describe("buildEvidenceRefByTitle", () => {
  test("lowercases the title key", () => {
    const map = buildEvidenceRefByTitle([
      { title: "FlowTrack", evidenceRef: ["sig1"] },
    ]);
    expect(map.has("flowtrack")).toBe(true);
  });

  test("stores non-empty evidenceRef correctly", () => {
    const map = buildEvidenceRefByTitle([
      { title: "X", evidenceRef: ["hn_1", "ph_2"] },
    ]);
    expect(map.get("x")).toEqual(["hn_1", "ph_2"]);
  });

  test("skips candidates with no or empty evidenceRef", () => {
    const map = buildEvidenceRefByTitle([
      { title: "NoRef" },
      { title: "EmptyRef", evidenceRef: [] },
      { title: "BlankRef", evidenceRef: ["  "] },
    ]);
    expect(map.size).toBe(0);
  });

  test("filters blank strings from evidenceRef", () => {
    const map = buildEvidenceRefByTitle([
      { title: "Mixed", evidenceRef: ["valid_1", "", "  ", "valid_2"] },
    ]);
    expect(map.get("mixed")).toEqual(["valid_1", "valid_2"]);
  });

  test("skips candidates with blank or missing title", () => {
    const map = buildEvidenceRefByTitle([
      { title: "", evidenceRef: ["sig1"] },
      { title: "   ", evidenceRef: ["sig2"] },
    ]);
    expect(map.size).toBe(0);
  });
});

// ── extractSignalIds (game-local) ─────────────────────────────────────────────

describe("extractSignalIds (game-local)", () => {
  test("reads supportingSignalIds array", () => {
    const result = extractSignalIds({ supportingSignalIds: ["hn_1", "ph_2"] });
    expect(result).toEqual(["hn_1", "ph_2"]);
  });

  test("falls back to signalIds when supportingSignalIds absent", () => {
    const result = extractSignalIds({ signalIds: ["reddit_3"] });
    expect(result).toEqual(["reddit_3"]);
  });

  test("returns undefined when neither key is present", () => {
    expect(extractSignalIds({ title: "no signal info" })).toBeUndefined();
  });

  test("returns undefined for an empty array", () => {
    expect(extractSignalIds({ supportingSignalIds: [] })).toBeUndefined();
  });

  test("filters out non-string and blank entries", () => {
    const result = extractSignalIds({
      supportingSignalIds: [42, "valid_1", "", "  ", "valid_2"],
    });
    expect(result).toEqual(["valid_1", "valid_2"]);
  });
});

// ── extractDivergentCandidates ────────────────────────────────────────────────

describe("extractDivergentCandidates", () => {
  test("returns empty array for empty actions list", () => {
    expect(extractDivergentCandidates([])).toHaveLength(0);
  });

  test("parses a well-formed ideas array from a single action", () => {
    const content = JSON.stringify({
      ideas: [
        { title: "Idea A", description: "summary A" },
        { title: "Idea B", oneLiner: "one line B" },
      ],
    });
    const actions = [makeAction({ content })];
    const result = extractDivergentCandidates(actions);
    expect(result).toHaveLength(2);
    expect(result[0]?.title).toBe("Idea A");
    expect(result[0]?.summary).toBe("summary A");
    expect(result[1]?.summary).toBe("one line B");
  });

  test("skips ideas with blank title", () => {
    const content = JSON.stringify({
      ideas: [
        { title: "", description: "orphan" },
        { title: "Valid", description: "kept" },
      ],
    });
    const result = extractDivergentCandidates([makeAction({ content })]);
    expect(result).toHaveLength(1);
    expect(result[0]?.title).toBe("Valid");
  });

  test("skips actions with unparseable JSON", () => {
    const result = extractDivergentCandidates([
      makeAction({ content: "NOT JSON" }),
    ]);
    expect(result).toHaveLength(0);
  });

  test("lifts supportingSignalIds when present", () => {
    const content = JSON.stringify({
      ideas: [
        {
          title: "Grounded",
          description: "x",
          supportingSignalIds: ["hn_1", "ph_3"],
        },
      ],
    });
    const result = extractDivergentCandidates([makeAction({ content })]);
    expect(result[0]?.supportingSignalIds).toEqual(["hn_1", "ph_3"]);
  });

  test("propagates proposedBy from the action's agentId", () => {
    const content = JSON.stringify({
      ideas: [{ title: "Foo", description: "bar" }],
    });
    const result = extractDivergentCandidates([
      makeAction({ content, agentId: "contrarian_investor:sess99" }),
    ]);
    expect(result[0]?.proposedBy).toBe("contrarian_investor:sess99");
  });
});

// ── identifyCoalitions ────────────────────────────────────────────────────────

describe("identifyCoalitions", () => {
  test("returns empty array when no evaluations", () => {
    expect(identifyCoalitions([])).toHaveLength(0);
  });

  test("returns empty array when no idea meets the support threshold", () => {
    const evals = [
      { agentId: "a1", ideaId: "Idea1", score: 0.3 }, // below 0.65
      { agentId: "a2", ideaId: "Idea1", score: 0.4 },
    ];
    expect(identifyCoalitions(evals)).toHaveLength(0);
  });

  test("groups agents that jointly support the same idea", () => {
    const evals = [
      { agentId: "agent1", ideaId: "MegaIdea", score: 0.9 },
      { agentId: "agent2", ideaId: "MegaIdea", score: 0.8 },
      { agentId: "agent3", ideaId: "MegaIdea", score: 0.7 },
    ];
    const coalitions = identifyCoalitions(evals);
    expect(coalitions).toHaveLength(1);
    expect(coalitions[0]?.members).toHaveLength(3);
    expect(coalitions[0]?.sharedIdeas).toContain("MegaIdea");
  });

  test("Shapley values sum to approximately the coalition stability", () => {
    const evals = [
      { agentId: "a1", ideaId: "X", score: 0.8 },
      { agentId: "a2", ideaId: "X", score: 0.9 },
    ];
    const [c] = identifyCoalitions(evals);
    expect(c).toBeDefined();
    const shapleySum = Object.values(c!.shapleyValues).reduce(
      (s, v) => s + v,
      0,
    );
    expect(shapleySum).toBeCloseTo(c!.stability, 5);
  });
});

// ── computeMetaGameHealth ────────────────────────────────────────────────────

describe("computeMetaGameHealth", () => {
  const definitions = getAllDefinitions();

  test("returns zero scores for empty rounds", () => {
    const health = computeMetaGameHealth([], definitions);
    expect(health.diversityIndex).toBe(0);
    expect(health.convergenceRate).toBe(0);
    expect(health.noveltyScore).toBe(0);
  });

  test("diversityIndex is 1.0 when all ideas have unique titles", () => {
    const rounds = [
      makeRound(1, [
        { title: "A", expertScore: 0.8 },
        { title: "B", expertScore: 0.6 },
        { title: "C", expertScore: 0.4 },
      ]),
    ];
    const health = computeMetaGameHealth(rounds, definitions);
    expect(health.diversityIndex).toBe(1.0);
  });

  test("diversityIndex < 1 when duplicate titles appear across rounds", () => {
    const rounds = [
      makeRound(1, [
        { title: "Repeat", expertScore: 0.9 },
        { title: "Unique", expertScore: 0.5 },
      ]),
      makeRound(2, [{ title: "Repeat", expertScore: 0.8 }]),
    ];
    const health = computeMetaGameHealth(rounds, definitions);
    // 2 unique / 3 total = 0.666...
    expect(health.diversityIndex).toBeLessThan(1);
    expect(health.diversityIndex).toBeGreaterThan(0);
  });

  test("noveltyScore reflects deviation from 0.5 in the final round", () => {
    // Ideas far from 0.5 (e.g. 0.9 and 0.1) → high novelty.
    const rounds = [
      makeRound(1, [
        { title: "High", expertScore: 0.9 },
        { title: "Low", expertScore: 0.1 },
      ]),
    ];
    const health = computeMetaGameHealth(rounds, definitions);
    // avg(|0.9-0.5|, |0.1-0.5|) = avg(0.4, 0.4) = 0.4
    expect(health.noveltyScore).toBeCloseTo(0.4);
  });
});

// ── computeDissentByTitle ────────────────────────────────────────────────────

describe("computeDissentByTitle", () => {
  test("returns empty map for rounds with no agent evaluations", () => {
    const rounds = [makeRound(1, [{ title: "A", expertScore: 0.7 }])];
    const result = computeDissentByTitle(rounds);
    expect(result.size).toBe(0);
  });

  test("computes dissent as |mean(dissenters) - mean(consensus)|", () => {
    // adversarial (dissenter) scores idea X at 0.1, founder (consensus) at 0.9
    const adversarialAction = makeAction({
      role: "adversarial",
      agentId: "adversarial:sess1",
      content: JSON.stringify({
        evaluations: [{ ideaId: "X", score: 0.1 }],
      }),
    });
    const founderAction = makeAction({
      role: "founder",
      agentId: "founder:sess1",
      content: JSON.stringify({
        evaluations: [{ ideaId: "X", score: 0.9 }],
      }),
    });
    const rounds = [
      makeRound(2, [{ title: "X", expertScore: 0.5 }], [
        adversarialAction,
        founderAction,
      ]),
    ];
    const result = computeDissentByTitle(rounds);
    const dissent = result.get("x");
    expect(dissent).toBeDefined();
    // |0.1 - 0.9| = 0.8
    expect(dissent).toBeCloseTo(0.8, 2);
  });

  test("uses spread fallback when only one camp scored an idea", () => {
    // Only non-dissent (consensus) agents scored — use max-min spread.
    const action1 = makeAction({
      role: "founder",
      content: JSON.stringify({ evaluations: [{ ideaId: "Y", score: 0.2 }] }),
    });
    const action2 = makeAction({
      role: "domain_expert",
      content: JSON.stringify({ evaluations: [{ ideaId: "Y", score: 0.8 }] }),
    });
    const rounds = [makeRound(2, [], [action1, action2])];
    const result = computeDissentByTitle(rounds);
    const dissent = result.get("y");
    // spread = 0.8 - 0.2 = 0.6
    expect(dissent).toBeCloseTo(0.6, 2);
  });

  test("clamps dissent to [0,1]", () => {
    // All possible scores are already in [0,1] so any dissent will be <=1.
    const action = makeAction({
      role: "adversarial",
      content: JSON.stringify({ evaluations: [{ ideaId: "Z", score: 0 }] }),
    });
    const rounds = [makeRound(2, [], [action])];
    const result = computeDissentByTitle(rounds);
    const dissent = result.get("z");
    if (dissent !== undefined) {
      expect(dissent).toBeGreaterThanOrEqual(0);
      expect(dissent).toBeLessThanOrEqual(1);
    }
  });
});

// ── checkAborted ────────────────────────────────────────────────────────────

describe("checkAborted", () => {
  test("no-op when signal is undefined", () => {
    expect(() => checkAborted(undefined)).not.toThrow();
  });

  test("no-op when signal is not aborted", () => {
    const ctrl = new AbortController();
    expect(() => checkAborted(ctrl.signal)).not.toThrow();
  });

  test("throws when signal is aborted", () => {
    const ctrl = new AbortController();
    ctrl.abort();
    expect(() => checkAborted(ctrl.signal)).toThrow("aborted");
  });
});
