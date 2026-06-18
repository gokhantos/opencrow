/**
 * Unit tests for theater/transforms.ts pure data helpers.
 *
 * Lane: *.test.ts → bun run test:unit (happy-dom not required — no DOM deps)
 *
 * NOTE: transforms.ts imports from src/sige/types (backend types). This test
 * also imports from the same source so the shapes align.
 */
import { describe, test, expect } from "bun:test";
import {
  expertResultToFrames,
  socialResultToGrid,
  fusedScoresToChart,
  graphViewToFlow,
} from "./transforms";
import type {
  ExpertGameResult,
  SocialSimResult,
  FusedScore,
  IncentiveBreakdown,
} from "../../../../../sige/types";
import type { GraphView } from "../../../../../sige/knowledge/graph-query";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const EMPTY_BREAKDOWN: IncentiveBreakdown = {
  diversityBonus: 0,
  buildingBonus: 0,
  surpriseBonus: 0,
  accuracyPenalty: 0,
  memoryReward: 0,
  coalitionStability: 0,
  signalCredibility: 0,
  socialViability: 0,
};

const EMPTY_STRATEGIC_METADATA = {
  paretoOptimal: false,
  dominantStrategy: false,
  evolutionarilyStable: false,
  nashEquilibrium: false,
};

function makeIdea(id: string, expertScore = 0.5) {
  return {
    id,
    title: `Idea ${id}`,
    description: "",
    proposedBy: "agent-1",
    round: 1,
    expertScore,
    socialScore: 0,
    fusedScore: 0,
    incentiveBreakdown: EMPTY_BREAKDOWN,
    strategicMetadata: EMPTY_STRATEGIC_METADATA,
  };
}

const AGENT_BALANCE_SCORES: Readonly<Record<string, number>> = {
  rational_player: 0.8,
  mechanism_designer: 0.7,
  explorer: 0.9,
  adversarial: 0.6,
  founder: 0.75,
  user_researcher: 0.7,
  contrarian_investor: 0.65,
  technical_architect: 0.8,
  designer: 0.7,
  domain_expert: 0.85,
};

// RoundNumber is a branded literal type 1|2|3|4 in backend types.
// We cast to satisfy the constraint while keeping the fixture readable.
function makeRoundNumber(n: number): 1 | 2 | 3 | 4 {
  if (n === 1 || n === 2 || n === 3 || n === 4) return n;
  return 1;
}

function makeExpertResult(
  roundNumbers: number[] = [1, 2, 3, 4],
): ExpertGameResult {
  return {
    rounds: roundNumbers.map((n) => ({
      roundNumber: makeRoundNumber(n),
      roundType: "strategic_interaction" as const,
      agentActions: [],
      outcomes: {
        selectedIdeas: [makeIdea(`sel-${n}`, 0.8)],
        eliminatedIdeas: [`elim-${n}`],
        coalitions: [],
        equilibria: [],
      },
    })),
    equilibria: [
      {
        type: "nash",
        ideas: ["sel-1"],
        stability: 0.9,
        description: "Nash equilibrium",
      },
    ],
    rankedIdeas: [],
    metaGameHealth: {
      diversityIndex: 0.7,
      convergenceRate: 0.6,
      noveltyScore: 0.5,
      agentBalanceScores: AGENT_BALANCE_SCORES as Readonly<Record<import("../../../../../sige/types").StrategicAgentRole, number>>,
    },
  };
}

// ─── expertResultToFrames ─────────────────────────────────────────────────────

describe("expertResultToFrames", () => {
  test("returns empty array for null input", () => {
    expect(expertResultToFrames(null)).toEqual([]);
  });

  test("returns empty array for undefined input", () => {
    expect(expertResultToFrames(undefined)).toEqual([]);
  });

  test("returns empty array when rounds is empty", () => {
    const result: ExpertGameResult = {
      rounds: [],
      equilibria: [],
      rankedIdeas: [],
      metaGameHealth: {
        diversityIndex: 0,
        convergenceRate: 0,
        noveltyScore: 0,
        agentBalanceScores: AGENT_BALANCE_SCORES as Readonly<Record<import("../../../../../sige/types").StrategicAgentRole, number>>,
      },
    };
    expect(expertResultToFrames(result)).toEqual([]);
  });

  test("orders frames by roundNumber ascending (input out of order)", () => {
    const result = makeExpertResult([3, 1, 4, 2]);
    const frames = expertResultToFrames(result);
    expect(frames.length).toBe(4);
    const nums = frames.map((f) => f.roundNumber);
    expect(nums).toEqual([1, 2, 3, 4]);
  });

  test("marks selectedIdeaIds correctly", () => {
    const result = makeExpertResult([1]);
    const frames = expertResultToFrames(result);
    const frame = frames[0];
    expect(frame).toBeDefined();
    if (!frame) return;
    expect(frame.selectedIdeaIds.has("sel-1")).toBe(true);
    expect(frame.selectedIdeaIds.has("elim-1")).toBe(false);
  });

  test("marks eliminatedIdeaIds correctly", () => {
    const result = makeExpertResult([1]);
    const frames = expertResultToFrames(result);
    const frame = frames[0];
    expect(frame).toBeDefined();
    if (!frame) return;
    expect(frame.eliminatedIdeaIds.has("elim-1")).toBe(true);
    expect(frame.eliminatedIdeaIds.has("sel-1")).toBe(false);
  });

  test("preserves roundType", () => {
    const result = makeExpertResult([2]);
    const frames = expertResultToFrames(result);
    const frame = frames[0];
    expect(frame).toBeDefined();
    if (!frame) return;
    expect(frame.roundType).toBe("strategic_interaction");
  });

  test("handles missing optional outcomes fields gracefully", () => {
    const result: ExpertGameResult = {
      rounds: [
        {
          roundNumber: 1 as 1 | 2 | 3 | 4,
          roundType: "divergent_generation" as const,
          agentActions: [],
          outcomes: {
            selectedIdeas: [],
            eliminatedIdeas: [],
            // coalitions and equilibria are optional in RoundOutcome
          },
        },
      ],
      equilibria: [],
      rankedIdeas: [],
      metaGameHealth: {
        diversityIndex: 0,
        convergenceRate: 0,
        noveltyScore: 0,
        agentBalanceScores: AGENT_BALANCE_SCORES as Readonly<Record<import("../../../../../sige/types").StrategicAgentRole, number>>,
      },
    };
    const frames = expertResultToFrames(result);
    expect(frames.length).toBe(1);
    const frame = frames[0];
    expect(frame).toBeDefined();
    if (!frame) return;
    expect(frame.coalitions).toEqual([]);
    expect(frame.equilibria).toEqual([]);
  });
});

// ─── socialResultToGrid ───────────────────────────────────────────────────────

function makeSocialResult(
  partial: Partial<SocialSimResult> = {},
): SocialSimResult {
  return {
    citizenActions: [],
    adoptionRates: {},
    sentimentDistribution: {},
    remixVariants: [],
    emergentOpposition: [],
    ...partial,
  };
}

describe("socialResultToGrid", () => {
  test("returns empty grid for null input", () => {
    const grid = socialResultToGrid(null);
    expect(grid.cells).toEqual([]);
    expect(grid.adoptionSeries).toEqual([]);
    expect(grid.sentimentSeries).toEqual([]);
  });

  test("returns empty grid for undefined input", () => {
    const grid = socialResultToGrid(undefined);
    expect(grid.cells).toEqual([]);
  });

  test("buckets cells by actionType", () => {
    const result = makeSocialResult({
      citizenActions: [
        { citizenId: "c1", actionType: "adopt", targetIdeaId: "i1", sentiment: 0.9 },
        { citizenId: "c2", actionType: "resist", targetIdeaId: "i2", sentiment: 0.1 },
        { citizenId: "c3", actionType: "adopt", targetIdeaId: "i3", sentiment: 0.8 },
      ],
    });
    const grid = socialResultToGrid(result);
    expect(grid.cells.length).toBe(3);
    const adoptBucket = grid.byActionType["adopt"];
    expect(adoptBucket).toBeDefined();
    expect(adoptBucket?.length).toBe(2);
    const resistBucket = grid.byActionType["resist"];
    expect(resistBucket?.length).toBe(1);
  });

  test("sorts adoptionSeries descending by rate", () => {
    const result = makeSocialResult({
      adoptionRates: { "idea-a": 0.3, "idea-b": 0.9, "idea-c": 0.5 },
    });
    const grid = socialResultToGrid(result);
    const rates = grid.adoptionSeries.map((s) => s.rate);
    expect(rates[0]).toBe(0.9);
    expect(rates[1]).toBe(0.5);
    expect(rates[2]).toBe(0.3);
  });

  test("shapes sentimentSeries from distribution", () => {
    const result = makeSocialResult({
      sentimentDistribution: { positive: 60, neutral: 30, negative: 10 },
    });
    const grid = socialResultToGrid(result);
    expect(grid.sentimentSeries.length).toBe(3);
    const labels = grid.sentimentSeries.map((s) => s.label);
    expect(labels).toContain("positive");
    expect(labels).toContain("neutral");
    expect(labels).toContain("negative");
  });

  test("all known actionType buckets are present even if empty", () => {
    const result = makeSocialResult({
      citizenActions: [
        { citizenId: "c1", actionType: "adopt", targetIdeaId: "i1", sentiment: 1 },
      ],
    });
    const grid = socialResultToGrid(result);
    for (const type of ["adopt", "resist", "remix", "combine", "oppose", "ignore"]) {
      expect(grid.byActionType[type]).toBeDefined();
    }
  });
});

// ─── fusedScoresToChart ───────────────────────────────────────────────────────

describe("fusedScoresToChart", () => {
  test("returns empty data for null input", () => {
    const data = fusedScoresToChart(null);
    expect(data.ideas).toEqual([]);
    expect(data.expertSeries).toEqual([]);
    expect(data.socialSeries).toEqual([]);
    expect(data.fusedSeries).toEqual([]);
    expect(data.labels).toEqual([]);
  });

  test("returns empty data for empty array", () => {
    const data = fusedScoresToChart([]);
    expect(data.ideas).toEqual([]);
  });

  test("sorts ideas by fusedScore descending", () => {
    const scores: readonly FusedScore[] = [
      { ideaId: "a", expertScore: 0.5, socialScore: 0.5, fusedScore: 0.5, alpha: 0.5, breakdown: EMPTY_BREAKDOWN },
      { ideaId: "b", expertScore: 0.9, socialScore: 0.9, fusedScore: 0.9, alpha: 0.5, breakdown: EMPTY_BREAKDOWN },
      { ideaId: "c", expertScore: 0.1, socialScore: 0.1, fusedScore: 0.1, alpha: 0.5, breakdown: EMPTY_BREAKDOWN },
    ];
    const data = fusedScoresToChart(scores);
    expect(data.ideas[0]?.ideaId).toBe("b");
    expect(data.ideas[1]?.ideaId).toBe("a");
    expect(data.ideas[2]?.ideaId).toBe("c");
  });

  test("shapes expert and social series correctly", () => {
    const scores: readonly FusedScore[] = [
      { ideaId: "x", expertScore: 0.7, socialScore: 0.3, fusedScore: 0.5, alpha: 0.5, breakdown: EMPTY_BREAKDOWN },
    ];
    const data = fusedScoresToChart(scores);
    expect(data.expertSeries[0]).toBe(0.7);
    expect(data.socialSeries[0]).toBe(0.3);
    expect(data.fusedSeries[0]).toBe(0.5);
  });

  test("caps at TOP_N (20) items", () => {
    const scores: readonly FusedScore[] = Array.from({ length: 25 }, (_, i) => ({
      ideaId: `idea-${i}`,
      expertScore: i / 25,
      socialScore: i / 25,
      fusedScore: i / 25,
      alpha: 0.5,
      breakdown: EMPTY_BREAKDOWN,
    }));
    const data = fusedScoresToChart(scores);
    expect(data.ideas.length).toBe(20);
  });

  test("labels array matches ideas length", () => {
    const scores: readonly FusedScore[] = [
      { ideaId: "abc12345def", expertScore: 0.5, socialScore: 0.5, fusedScore: 0.5, alpha: 0.5, breakdown: EMPTY_BREAKDOWN },
    ];
    const data = fusedScoresToChart(scores);
    expect(data.labels.length).toBe(data.ideas.length);
  });
});

// ─── graphViewToFlow ──────────────────────────────────────────────────────────

describe("graphViewToFlow", () => {
  test("returns empty for null input", () => {
    const result = graphViewToFlow(null);
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });

  test("returns empty for undefined input", () => {
    const result = graphViewToFlow(undefined);
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });

  test("returns empty for empty GraphView", () => {
    const view: GraphView = { nodes: [], edges: [], summary: "" };
    const result = graphViewToFlow(view);
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });

  test("maps GraphNode to React Flow Node with correct id and data", () => {
    const view: GraphView = {
      nodes: [
        { uuid: "node-1", name: "AI Safety", entityType: "Concept", summary: "A concept" },
      ],
      edges: [],
      summary: "",
    };
    const result = graphViewToFlow(view);
    expect(result.nodes.length).toBe(1);
    const node = result.nodes[0];
    expect(node).toBeDefined();
    if (!node) return;
    expect(node.id).toBe("node-1");
    expect(node.data.label).toBe("AI Safety");
    expect(node.data.entityType).toBe("Concept");
    expect(node.data.summary).toBe("A concept");
  });

  test("maps GraphEdge to React Flow Edge with correct source/target", () => {
    const view: GraphView = {
      nodes: [
        { uuid: "n1", name: "A", entityType: "Fact" },
        { uuid: "n2", name: "B", entityType: "Fact" },
      ],
      edges: [
        {
          uuid: "e1",
          sourceNodeUuid: "n1",
          targetNodeUuid: "n2",
          relationType: "related_to",
          fact: "A is related to B",
        },
      ],
      summary: "",
    };
    const result = graphViewToFlow(view);
    expect(result.edges.length).toBe(1);
    const edge = result.edges[0];
    expect(edge).toBeDefined();
    if (!edge) return;
    expect(edge.id).toBe("e1");
    expect(edge.source).toBe("n1");
    expect(edge.target).toBe("n2");
    expect(edge.data?.fact).toBe("A is related to B");
  });

  test("filters edges whose source or target node is not in the node set", () => {
    const view: GraphView = {
      nodes: [{ uuid: "n1", name: "A", entityType: "Fact" }],
      edges: [
        {
          uuid: "e1",
          sourceNodeUuid: "n1",
          targetNodeUuid: "missing-node",
          relationType: "causes",
          fact: "orphaned edge",
        },
      ],
      summary: "",
    };
    const result = graphViewToFlow(view);
    expect(result.edges.length).toBe(0);
  });

  test("assigns grid positions so nodes have distinct x/y coordinates", () => {
    const view: GraphView = {
      nodes: [
        { uuid: "n1", name: "A", entityType: "Fact" },
        { uuid: "n2", name: "B", entityType: "Fact" },
        { uuid: "n3", name: "C", entityType: "Fact" },
      ],
      edges: [],
      summary: "",
    };
    const result = graphViewToFlow(view);
    expect(result.nodes.length).toBe(3);
    const positions = result.nodes.map((n) => `${n.position.x},${n.position.y}`);
    // All positions must be distinct
    const unique = new Set(positions);
    expect(unique.size).toBe(3);
  });
});
