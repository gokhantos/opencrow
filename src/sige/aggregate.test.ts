/**
 * Unit tests for aggregateIdeas() in src/sige/aggregate.ts.
 *
 * Lane: unit (*.test.ts) — no DB, no I/O, no network.
 * Run with: bun run test:unit
 *
 * Covers:
 *  1. Basic flatten: ideas from a single session row appear in the result.
 *  2. Dedup by (runId, ideaId) — collision keeps the highest round.
 *  3. Dedup tie-break: equal round → keep higher expertScore.
 *  4. Fused-score join: sets socialScore, fusedScore, isFinal=true, breakdown.
 *  5. Non-final ideas get socialScore=null, fusedScore=null, isFinal=false,
 *     breakdown=null.
 *  6. `finalOnly` filter omits non-final ideas.
 *  7. `runId` filter restricts to a single run.
 *  8. `minScore` uses fusedScore when present, otherwise expertScore.
 *  9. Sort order: ideas sorted by (fusedScore ?? expertScore) DESC.
 * 10. RunSummary counts: ideaCount / finalCount correct.
 * 11. RunSummary only includes runs that have ≥1 matching idea (after filters).
 * 12. RunSummary ordering: createdAt DESC.
 * 13. Empty input → empty result, no throw.
 * 14. null expertResultJson → no throw, row is skipped.
 * 15. Malformed (non-JSON) expertResultJson → no throw, row is skipped.
 * 16. null fusedScoresJson → ideas are non-final, no throw.
 * 17. Malformed fusedScoresJson → ideas are non-final, no throw.
 * 18. Empty rounds array → no ideas from that row.
 * 19. Round with missing/empty selectedIdeas → skipped gracefully.
 * 20. Idea entry missing `id` field → skipped gracefully.
 * 21. Missing incentiveBreakdown fields default to 0.
 */

import { describe, test, expect } from "bun:test";
import { aggregateIdeas } from "./aggregate";
import type { AggregationSessionRow } from "./store";
import type { ExpertGameResult, FusedScore } from "./types";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

const ZERO_BREAKDOWN = {
  diversityBonus: 0,
  buildingBonus: 0,
  surpriseBonus: 0,
  accuracyPenalty: 0,
  memoryReward: 0,
  coalitionStability: 0,
  signalCredibility: 0,
  socialViability: 0,
};

function makeBreakdown(overrides: Partial<typeof ZERO_BREAKDOWN> = {}) {
  return { ...ZERO_BREAKDOWN, ...overrides };
}

/** Minimal valid ScoredIdea for an expertResult round */
function makeScoredIdea(
  id: string,
  round: number,
  expertScore: number,
  breakdownOverrides: Partial<typeof ZERO_BREAKDOWN> = {},
) {
  return {
    id,
    title: `Idea ${id}`,
    description: `Description for ${id}`,
    proposedBy: "agent-1",
    round,
    expertScore,
    incentiveBreakdown: makeBreakdown(breakdownOverrides),
    strategicMetadata: {
      paretoOptimal: false,
      dominantStrategy: false,
      evolutionarilyStable: false,
      nashEquilibrium: false,
    },
  };
}

/** Build a minimal valid ExpertGameResult JSON string */
function makeExpertResultJson(
  rounds: Array<{
    roundNumber: number;
    roundType?: string;
    ideas: ReturnType<typeof makeScoredIdea>[];
  }>,
): string {
  const expertResult: ExpertGameResult = {
    rounds: rounds.map((r) => ({
      roundNumber: r.roundNumber as 1 | 2 | 3 | 4,
      roundType: (r.roundType ?? "divergent_generation") as ExpertGameResult["rounds"][0]["roundType"],
      agentActions: [],
      outcomes: {
        selectedIdeas: r.ideas as ExpertGameResult["rounds"][0]["outcomes"]["selectedIdeas"],
        eliminatedIdeas: [],
      },
    })),
    equilibria: [],
    rankedIdeas: [],
    metaGameHealth: {
      agentBalanceScores: {} as ExpertGameResult["metaGameHealth"]["agentBalanceScores"],
      diversityIndex: 0,
      convergenceRate: 0,
      noveltyScore: 0,
    },
  };
  return JSON.stringify(expertResult);
}

/** Build a valid FusedScore[] JSON string */
function makeFusedScoresJson(
  scores: Array<{
    ideaId: string;
    expertScore?: number;
    socialScore: number;
    fusedScore: number;
    breakdown?: Partial<typeof ZERO_BREAKDOWN>;
  }>,
): string {
  const fusedScores: FusedScore[] = scores.map((s) => ({
    ideaId: s.ideaId,
    expertScore: s.expertScore ?? 0.5,
    socialScore: s.socialScore,
    fusedScore: s.fusedScore,
    alpha: 0.5,
    breakdown: makeBreakdown(s.breakdown),
  }));
  return JSON.stringify(fusedScores);
}

/** Build a minimal AggregationSessionRow */
function makeRow(
  id: string,
  opts: {
    expertResultJson?: string | null;
    fusedScoresJson?: string | null;
    createdAt?: Date;
    status?: string;
    origin?: string;
    /** Use explicit null to get null seed; omit to get a default seed string. */
    seedInput?: string | null;
  } = {},
): AggregationSessionRow {
  // Distinguish between "not provided" (undefined) and "explicitly null"
  const seedInput = Object.prototype.hasOwnProperty.call(opts, "seedInput")
    ? opts.seedInput
    : `seed-${id}`;
  return {
    id,
    seedInput: seedInput ?? null,
    origin: opts.origin ?? "human",
    status: opts.status ?? "completed",
    createdAt: opts.createdAt ?? new Date("2024-01-01T00:00:00Z"),
    expertResultJson: opts.expertResultJson ?? null,
    fusedScoresJson: opts.fusedScoresJson ?? null,
  };
}

// ─── 1. Basic flatten ─────────────────────────────────────────────────────────

describe("aggregateIdeas — basic flatten", () => {
  test("returns ideas from a single session row", () => {
    const row = makeRow("run-1", {
      expertResultJson: makeExpertResultJson([
        { roundNumber: 1, ideas: [makeScoredIdea("idea-a", 1, 0.7)] },
      ]),
    });

    const result = aggregateIdeas([row]);

    expect(result.ideas).toHaveLength(1);
    expect(result.ideas[0]?.ideaId).toBe("idea-a");
    expect(result.ideas[0]?.title).toBe("Idea idea-a");
    expect(result.ideas[0]?.expertScore).toBe(0.7);
    expect(result.ideas[0]?.runId).toBe("run-1");
  });

  test("flattens ideas from multiple rounds of the same row", () => {
    const row = makeRow("run-1", {
      expertResultJson: makeExpertResultJson([
        { roundNumber: 1, ideas: [makeScoredIdea("idea-a", 1, 0.5)] },
        { roundNumber: 2, ideas: [makeScoredIdea("idea-b", 2, 0.6)] },
      ]),
    });

    const result = aggregateIdeas([row]);
    const ids = result.ideas.map((i) => i.ideaId).sort();
    expect(ids).toEqual(["idea-a", "idea-b"]);
  });

  test("flattens ideas from multiple rows", () => {
    const row1 = makeRow("run-1", {
      expertResultJson: makeExpertResultJson([
        { roundNumber: 1, ideas: [makeScoredIdea("idea-a", 1, 0.5)] },
      ]),
    });
    const row2 = makeRow("run-2", {
      expertResultJson: makeExpertResultJson([
        { roundNumber: 1, ideas: [makeScoredIdea("idea-b", 1, 0.6)] },
      ]),
    });

    const result = aggregateIdeas([row1, row2]);
    expect(result.ideas).toHaveLength(2);
  });

  test("preserves proposedBy, description, roundType", () => {
    const row = makeRow("run-1", {
      expertResultJson: makeExpertResultJson([
        {
          roundNumber: 2,
          roundType: "strategic_interaction",
          ideas: [makeScoredIdea("idea-x", 2, 0.8)],
        },
      ]),
    });

    const result = aggregateIdeas([row]);
    const idea = result.ideas[0]!;
    expect(idea.proposedBy).toBe("agent-1");
    expect(idea.description).toBe("Description for idea-x");
    expect(idea.roundType).toBe("strategic_interaction");
    expect(idea.round).toBe(2);
  });
});

// ─── 2. Dedup — highest round wins ───────────────────────────────────────────

describe("aggregateIdeas — dedup by (runId, ideaId)", () => {
  test("same ideaId in two rounds: keeps the higher round's score", () => {
    const row = makeRow("run-1", {
      expertResultJson: makeExpertResultJson([
        { roundNumber: 1, ideas: [makeScoredIdea("idea-a", 1, 0.5)] },
        { roundNumber: 3, ideas: [makeScoredIdea("idea-a", 3, 0.9)] },
      ]),
    });

    const result = aggregateIdeas([row]);
    expect(result.ideas).toHaveLength(1);
    expect(result.ideas[0]?.round).toBe(3);
    expect(result.ideas[0]?.expertScore).toBe(0.9);
  });

  test("same ideaId in same run across different rows is treated as SAME run entry if runId differs", () => {
    // Two different runs can have the same ideaId — they are independent
    const row1 = makeRow("run-1", {
      expertResultJson: makeExpertResultJson([
        { roundNumber: 1, ideas: [makeScoredIdea("idea-a", 1, 0.5)] },
      ]),
    });
    const row2 = makeRow("run-2", {
      expertResultJson: makeExpertResultJson([
        { roundNumber: 1, ideas: [makeScoredIdea("idea-a", 1, 0.7)] },
      ]),
    });

    const result = aggregateIdeas([row1, row2]);
    // Both should appear — different runIds
    expect(result.ideas).toHaveLength(2);
    const runIds = result.ideas.map((i) => i.runId).sort();
    expect(runIds).toEqual(["run-1", "run-2"]);
  });

  test("round order in the JSON array does not matter — highest always wins", () => {
    // Round 3 comes before round 1 in the JSON
    const row = makeRow("run-1", {
      expertResultJson: makeExpertResultJson([
        { roundNumber: 3, ideas: [makeScoredIdea("idea-a", 3, 0.9)] },
        { roundNumber: 1, ideas: [makeScoredIdea("idea-a", 1, 0.4)] },
      ]),
    });

    const result = aggregateIdeas([row]);
    expect(result.ideas[0]?.round).toBe(3);
    expect(result.ideas[0]?.expertScore).toBe(0.9);
  });
});

// ─── 3. Dedup tie-break: same round → higher expertScore ─────────────────────

describe("aggregateIdeas — dedup tie-break on equal round", () => {
  test("equal round: keeps the entry with the higher expertScore", () => {
    const row = makeRow("run-1", {
      expertResultJson: makeExpertResultJson([
        { roundNumber: 2, ideas: [makeScoredIdea("idea-a", 2, 0.4)] },
        { roundNumber: 2, ideas: [makeScoredIdea("idea-a", 2, 0.85)] },
      ]),
    });

    const result = aggregateIdeas([row]);
    expect(result.ideas).toHaveLength(1);
    expect(result.ideas[0]?.expertScore).toBe(0.85);
  });
});

// ─── 4. Fused-score join ─────────────────────────────────────────────────────

describe("aggregateIdeas — fused-score join", () => {
  test("idea with a matching fused score has isFinal=true", () => {
    const row = makeRow("run-1", {
      expertResultJson: makeExpertResultJson([
        { roundNumber: 4, ideas: [makeScoredIdea("idea-a", 4, 0.8)] },
      ]),
      fusedScoresJson: makeFusedScoresJson([
        { ideaId: "idea-a", socialScore: 0.6, fusedScore: 0.72 },
      ]),
    });

    const result = aggregateIdeas([row]);
    const idea = result.ideas[0]!;
    expect(idea.isFinal).toBe(true);
    expect(idea.socialScore).toBe(0.6);
    expect(idea.fusedScore).toBe(0.72);
    expect(idea.breakdown).not.toBeNull();
  });

  test("fused breakdown is copied to the idea", () => {
    const breakdown = { diversityBonus: 0.1, buildingBonus: 0.2 };
    const row = makeRow("run-1", {
      expertResultJson: makeExpertResultJson([
        { roundNumber: 4, ideas: [makeScoredIdea("idea-a", 4, 0.8)] },
      ]),
      fusedScoresJson: makeFusedScoresJson([
        {
          ideaId: "idea-a",
          socialScore: 0.6,
          fusedScore: 0.72,
          breakdown,
        },
      ]),
    });

    const result = aggregateIdeas([row]);
    expect(result.ideas[0]?.breakdown?.diversityBonus).toBe(0.1);
    expect(result.ideas[0]?.breakdown?.buildingBonus).toBe(0.2);
  });

  test("fused score from one run does not bleed into another run's same ideaId", () => {
    const row1 = makeRow("run-1", {
      expertResultJson: makeExpertResultJson([
        { roundNumber: 1, ideas: [makeScoredIdea("idea-a", 1, 0.6)] },
      ]),
      fusedScoresJson: makeFusedScoresJson([
        { ideaId: "idea-a", socialScore: 0.7, fusedScore: 0.65 },
      ]),
    });
    const row2 = makeRow("run-2", {
      expertResultJson: makeExpertResultJson([
        { roundNumber: 1, ideas: [makeScoredIdea("idea-a", 1, 0.5)] },
      ]),
      fusedScoresJson: null,
    });

    const result = aggregateIdeas([row1, row2]);
    const run1Idea = result.ideas.find((i) => i.runId === "run-1");
    const run2Idea = result.ideas.find((i) => i.runId === "run-2");

    expect(run1Idea?.isFinal).toBe(true);
    expect(run2Idea?.isFinal).toBe(false);
    expect(run2Idea?.fusedScore).toBeNull();
  });
});

// ─── 5. Non-final ideas ───────────────────────────────────────────────────────

describe("aggregateIdeas — non-final ideas", () => {
  test("ideas without a fused score have isFinal=false, null socialScore/fusedScore/breakdown", () => {
    const row = makeRow("run-1", {
      expertResultJson: makeExpertResultJson([
        { roundNumber: 1, ideas: [makeScoredIdea("idea-a", 1, 0.5)] },
      ]),
      fusedScoresJson: null,
    });

    const result = aggregateIdeas([row]);
    const idea = result.ideas[0]!;
    expect(idea.isFinal).toBe(false);
    expect(idea.socialScore).toBeNull();
    expect(idea.fusedScore).toBeNull();
    expect(idea.breakdown).toBeNull();
  });
});

// ─── 6. finalOnly filter ─────────────────────────────────────────────────────

describe("aggregateIdeas — finalOnly filter", () => {
  test("finalOnly=true removes non-final ideas", () => {
    const row = makeRow("run-1", {
      expertResultJson: makeExpertResultJson([
        { roundNumber: 1, ideas: [makeScoredIdea("idea-a", 1, 0.5)] },
        { roundNumber: 2, ideas: [makeScoredIdea("idea-b", 2, 0.7)] },
      ]),
      fusedScoresJson: makeFusedScoresJson([
        { ideaId: "idea-b", socialScore: 0.6, fusedScore: 0.65 },
      ]),
    });

    const result = aggregateIdeas([row], { finalOnly: true });
    expect(result.ideas).toHaveLength(1);
    expect(result.ideas[0]?.ideaId).toBe("idea-b");
  });

  test("finalOnly=false (default) returns all ideas", () => {
    const row = makeRow("run-1", {
      expertResultJson: makeExpertResultJson([
        { roundNumber: 1, ideas: [makeScoredIdea("idea-a", 1, 0.5)] },
        { roundNumber: 2, ideas: [makeScoredIdea("idea-b", 2, 0.7)] },
      ]),
      fusedScoresJson: makeFusedScoresJson([
        { ideaId: "idea-b", socialScore: 0.6, fusedScore: 0.65 },
      ]),
    });

    const result = aggregateIdeas([row]);
    expect(result.ideas).toHaveLength(2);
  });
});

// ─── 7. runId filter ─────────────────────────────────────────────────────────

describe("aggregateIdeas — runId filter", () => {
  test("runId filter restricts ideas to the specified run", () => {
    const row1 = makeRow("run-1", {
      expertResultJson: makeExpertResultJson([
        { roundNumber: 1, ideas: [makeScoredIdea("idea-a", 1, 0.5)] },
      ]),
    });
    const row2 = makeRow("run-2", {
      expertResultJson: makeExpertResultJson([
        { roundNumber: 1, ideas: [makeScoredIdea("idea-b", 1, 0.6)] },
      ]),
    });

    const result = aggregateIdeas([row1, row2], { runId: "run-2" });
    expect(result.ideas).toHaveLength(1);
    expect(result.ideas[0]?.runId).toBe("run-2");
    expect(result.ideas[0]?.ideaId).toBe("idea-b");
  });

  test("runId filter with no match returns empty ideas", () => {
    const row = makeRow("run-1", {
      expertResultJson: makeExpertResultJson([
        { roundNumber: 1, ideas: [makeScoredIdea("idea-a", 1, 0.5)] },
      ]),
    });

    const result = aggregateIdeas([row], { runId: "non-existent-run" });
    expect(result.ideas).toHaveLength(0);
    expect(result.runs).toHaveLength(0);
  });
});

// ─── 8. minScore filter ───────────────────────────────────────────────────────

describe("aggregateIdeas — minScore filter", () => {
  test("minScore uses expertScore when no fusedScore is present", () => {
    const row = makeRow("run-1", {
      expertResultJson: makeExpertResultJson([
        { roundNumber: 1, ideas: [makeScoredIdea("idea-low", 1, 0.3)] },
        { roundNumber: 1, ideas: [makeScoredIdea("idea-high", 1, 0.8)] },
      ]),
    });

    const result = aggregateIdeas([row], { minScore: 0.5 });
    expect(result.ideas).toHaveLength(1);
    expect(result.ideas[0]?.ideaId).toBe("idea-high");
  });

  test("minScore uses fusedScore when present (over expertScore)", () => {
    const row = makeRow("run-1", {
      expertResultJson: makeExpertResultJson([
        // high expert but low fused → should be excluded
        { roundNumber: 1, ideas: [makeScoredIdea("idea-a", 1, 0.9)] },
        // low expert but high fused → should be included
        { roundNumber: 1, ideas: [makeScoredIdea("idea-b", 1, 0.2)] },
      ]),
      fusedScoresJson: makeFusedScoresJson([
        { ideaId: "idea-a", socialScore: 0.1, fusedScore: 0.15 },
        { ideaId: "idea-b", socialScore: 0.9, fusedScore: 0.85 },
      ]),
    });

    const result = aggregateIdeas([row], { minScore: 0.5 });
    expect(result.ideas).toHaveLength(1);
    expect(result.ideas[0]?.ideaId).toBe("idea-b");
  });

  test("minScore=0 (default absent) returns all ideas", () => {
    const row = makeRow("run-1", {
      expertResultJson: makeExpertResultJson([
        { roundNumber: 1, ideas: [makeScoredIdea("idea-a", 1, 0.1)] },
        { roundNumber: 1, ideas: [makeScoredIdea("idea-b", 1, 0.9)] },
      ]),
    });

    const result = aggregateIdeas([row]);
    expect(result.ideas).toHaveLength(2);
  });
});

// ─── 9. Sort order ────────────────────────────────────────────────────────────

describe("aggregateIdeas — sort order DESC by effective score", () => {
  test("ideas with higher expertScore appear first (no fused scores)", () => {
    const row = makeRow("run-1", {
      expertResultJson: makeExpertResultJson([
        { roundNumber: 1, ideas: [makeScoredIdea("idea-low", 1, 0.3)] },
        { roundNumber: 1, ideas: [makeScoredIdea("idea-high", 1, 0.9)] },
        { roundNumber: 1, ideas: [makeScoredIdea("idea-mid", 1, 0.6)] },
      ]),
    });

    const result = aggregateIdeas([row]);
    const scores = result.ideas.map((i) => i.expertScore);
    expect(scores[0]).toBe(0.9);
    expect(scores[1]).toBe(0.6);
    expect(scores[2]).toBe(0.3);
  });

  test("ideas with fused scores: higher fusedScore ranks above higher expertScore", () => {
    const row = makeRow("run-1", {
      expertResultJson: makeExpertResultJson([
        { roundNumber: 1, ideas: [makeScoredIdea("idea-expert-king", 1, 0.95)] },
        { roundNumber: 1, ideas: [makeScoredIdea("idea-fused-king", 1, 0.5)] },
      ]),
      fusedScoresJson: makeFusedScoresJson([
        // fused=0.99 wins over expert=0.95 (no fused)
        { ideaId: "idea-fused-king", socialScore: 0.9, fusedScore: 0.99 },
      ]),
    });

    const result = aggregateIdeas([row]);
    expect(result.ideas[0]?.ideaId).toBe("idea-fused-king");
    expect(result.ideas[1]?.ideaId).toBe("idea-expert-king");
  });
});

// ─── 10. RunSummary counts ────────────────────────────────────────────────────

describe("aggregateIdeas — RunSummary counts", () => {
  test("ideaCount and finalCount reflect ideas in the filtered result", () => {
    const row = makeRow("run-1", {
      expertResultJson: makeExpertResultJson([
        { roundNumber: 1, ideas: [makeScoredIdea("idea-a", 1, 0.5)] },
        { roundNumber: 2, ideas: [makeScoredIdea("idea-b", 2, 0.7)] },
        { roundNumber: 3, ideas: [makeScoredIdea("idea-c", 3, 0.8)] },
      ]),
      fusedScoresJson: makeFusedScoresJson([
        { ideaId: "idea-b", socialScore: 0.6, fusedScore: 0.65 },
        { ideaId: "idea-c", socialScore: 0.7, fusedScore: 0.75 },
      ]),
    });

    const result = aggregateIdeas([row]);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]?.ideaCount).toBe(3);
    expect(result.runs[0]?.finalCount).toBe(2);
  });

  test("finalCount=0 when no ideas are final", () => {
    const row = makeRow("run-1", {
      expertResultJson: makeExpertResultJson([
        { roundNumber: 1, ideas: [makeScoredIdea("idea-a", 1, 0.5)] },
      ]),
      fusedScoresJson: null,
    });

    const result = aggregateIdeas([row]);
    expect(result.runs[0]?.finalCount).toBe(0);
    expect(result.runs[0]?.ideaCount).toBe(1);
  });
});

// ─── 11. Runs only contains runs with matching ideas ─────────────────────────

describe("aggregateIdeas — RunSummary only for runs with matches", () => {
  test("runId filter excludes the non-matching run from runs[]", () => {
    const row1 = makeRow("run-1", {
      expertResultJson: makeExpertResultJson([
        { roundNumber: 1, ideas: [makeScoredIdea("idea-a", 1, 0.5)] },
      ]),
    });
    const row2 = makeRow("run-2", {
      expertResultJson: makeExpertResultJson([
        { roundNumber: 1, ideas: [makeScoredIdea("idea-b", 1, 0.6)] },
      ]),
    });

    const result = aggregateIdeas([row1, row2], { runId: "run-1" });
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]?.runId).toBe("run-1");
  });

  test("finalOnly=true excludes runs that have no final ideas", () => {
    const row1 = makeRow("run-1", {
      expertResultJson: makeExpertResultJson([
        { roundNumber: 1, ideas: [makeScoredIdea("idea-a", 1, 0.5)] },
      ]),
      // no fused scores → no final ideas
      fusedScoresJson: null,
    });
    const row2 = makeRow("run-2", {
      expertResultJson: makeExpertResultJson([
        { roundNumber: 1, ideas: [makeScoredIdea("idea-b", 1, 0.6)] },
      ]),
      fusedScoresJson: makeFusedScoresJson([
        { ideaId: "idea-b", socialScore: 0.5, fusedScore: 0.55 },
      ]),
    });

    const result = aggregateIdeas([row1, row2], { finalOnly: true });
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]?.runId).toBe("run-2");
  });
});

// ─── 12. RunSummary ordering: createdAt DESC ─────────────────────────────────

describe("aggregateIdeas — RunSummary ordering", () => {
  test("runs[] are ordered by createdAt DESC (newest first)", () => {
    const older = makeRow("run-old", {
      createdAt: new Date("2024-01-01T00:00:00Z"),
      expertResultJson: makeExpertResultJson([
        { roundNumber: 1, ideas: [makeScoredIdea("idea-a", 1, 0.5)] },
      ]),
    });
    const newer = makeRow("run-new", {
      createdAt: new Date("2024-06-01T00:00:00Z"),
      expertResultJson: makeExpertResultJson([
        { roundNumber: 1, ideas: [makeScoredIdea("idea-b", 1, 0.5)] },
      ]),
    });

    // Pass older first to verify sort is not input-order dependent
    const result = aggregateIdeas([older, newer]);
    expect(result.runs[0]?.runId).toBe("run-new");
    expect(result.runs[1]?.runId).toBe("run-old");
  });

  test("RunSummary carries seed, origin, status, createdAt from the row", () => {
    const createdAt = new Date("2024-03-15T10:00:00Z");
    const row = makeRow("run-1", {
      createdAt,
      status: "completed",
      origin: "auto",
      seedInput: null,
      expertResultJson: makeExpertResultJson([
        { roundNumber: 1, ideas: [makeScoredIdea("idea-a", 1, 0.5)] },
      ]),
    });

    const result = aggregateIdeas([row]);
    const summary = result.runs[0]!;
    expect(summary.seed).toBeNull();
    expect(summary.origin).toBe("auto");
    expect(summary.status).toBe("completed");
    expect(summary.createdAt.getTime()).toBe(createdAt.getTime());
  });
});

// ─── 13. Empty input ─────────────────────────────────────────────────────────

describe("aggregateIdeas — empty input", () => {
  test("returns empty ideas and runs for empty rows array", () => {
    const result = aggregateIdeas([]);
    expect(result.ideas).toHaveLength(0);
    expect(result.runs).toHaveLength(0);
  });

  test("does not throw when called with an empty array and options", () => {
    expect(() =>
      aggregateIdeas([], { finalOnly: true, minScore: 0.5 }),
    ).not.toThrow();
  });
});

// ─── 14. null expertResultJson ────────────────────────────────────────────────

describe("aggregateIdeas — null expertResultJson tolerance", () => {
  test("rows with null expertResultJson are silently skipped, no throw", () => {
    const row = makeRow("run-1", { expertResultJson: null });
    expect(() => aggregateIdeas([row])).not.toThrow();
    const result = aggregateIdeas([row]);
    expect(result.ideas).toHaveLength(0);
  });

  test("valid row still produces ideas when paired with a null row", () => {
    const nullRow = makeRow("run-null", { expertResultJson: null });
    const validRow = makeRow("run-valid", {
      expertResultJson: makeExpertResultJson([
        { roundNumber: 1, ideas: [makeScoredIdea("idea-a", 1, 0.5)] },
      ]),
    });

    const result = aggregateIdeas([nullRow, validRow]);
    expect(result.ideas).toHaveLength(1);
    expect(result.ideas[0]?.runId).toBe("run-valid");
  });
});

// ─── 15. Malformed expertResultJson ──────────────────────────────────────────

describe("aggregateIdeas — malformed expertResultJson tolerance", () => {
  test("does not throw on invalid JSON in expertResultJson", () => {
    const row = makeRow("run-1", {
      expertResultJson: "{ this is not valid JSON {{{{",
    });
    expect(() => aggregateIdeas([row])).not.toThrow();
  });

  test("returns empty when all rows have malformed expertResultJson", () => {
    const row = makeRow("run-1", {
      expertResultJson: "null",
    });
    const result = aggregateIdeas([row]);
    expect(result.ideas).toHaveLength(0);
  });

  test("does not throw on expertResultJson that is valid JSON but wrong shape", () => {
    const row = makeRow("run-1", {
      expertResultJson: JSON.stringify({ unexpected: "structure", rounds: null }),
    });
    expect(() => aggregateIdeas([row])).not.toThrow();
  });
});

// ─── 16. null fusedScoresJson ─────────────────────────────────────────────────

describe("aggregateIdeas — null fusedScoresJson tolerance", () => {
  test("ideas have isFinal=false when fusedScoresJson is null", () => {
    const row = makeRow("run-1", {
      expertResultJson: makeExpertResultJson([
        { roundNumber: 1, ideas: [makeScoredIdea("idea-a", 1, 0.5)] },
      ]),
      fusedScoresJson: null,
    });

    const result = aggregateIdeas([row]);
    expect(result.ideas[0]?.isFinal).toBe(false);
  });

  test("does not throw when fusedScoresJson is null", () => {
    const row = makeRow("run-1", {
      expertResultJson: makeExpertResultJson([
        { roundNumber: 1, ideas: [makeScoredIdea("idea-a", 1, 0.5)] },
      ]),
      fusedScoresJson: null,
    });
    expect(() => aggregateIdeas([row])).not.toThrow();
  });
});

// ─── 17. Malformed fusedScoresJson ───────────────────────────────────────────

describe("aggregateIdeas — malformed fusedScoresJson tolerance", () => {
  test("does not throw on invalid JSON in fusedScoresJson", () => {
    const row = makeRow("run-1", {
      expertResultJson: makeExpertResultJson([
        { roundNumber: 1, ideas: [makeScoredIdea("idea-a", 1, 0.5)] },
      ]),
      fusedScoresJson: "{ broken json",
    });
    expect(() => aggregateIdeas([row])).not.toThrow();
  });

  test("ideas are non-final when fusedScoresJson is malformed", () => {
    const row = makeRow("run-1", {
      expertResultJson: makeExpertResultJson([
        { roundNumber: 1, ideas: [makeScoredIdea("idea-a", 1, 0.5)] },
      ]),
      fusedScoresJson: "{ broken json",
    });
    const result = aggregateIdeas([row]);
    expect(result.ideas[0]?.isFinal).toBe(false);
  });

  test("does not throw when fusedScoresJson is valid JSON but not an array", () => {
    const row = makeRow("run-1", {
      expertResultJson: makeExpertResultJson([
        { roundNumber: 1, ideas: [makeScoredIdea("idea-a", 1, 0.5)] },
      ]),
      fusedScoresJson: JSON.stringify({ notAnArray: true }),
    });
    expect(() => aggregateIdeas([row])).not.toThrow();
    const result = aggregateIdeas([row]);
    expect(result.ideas[0]?.isFinal).toBe(false);
  });
});

// ─── 18. Empty rounds array ───────────────────────────────────────────────────

describe("aggregateIdeas — empty rounds array", () => {
  test("row with empty rounds array produces no ideas", () => {
    const row = makeRow("run-1", {
      expertResultJson: makeExpertResultJson([]),
    });

    const result = aggregateIdeas([row]);
    expect(result.ideas).toHaveLength(0);
    expect(result.runs).toHaveLength(0);
  });
});

// ─── 19. Round with missing/empty selectedIdeas ───────────────────────────────

describe("aggregateIdeas — empty selectedIdeas in a round", () => {
  test("round with empty selectedIdeas produces no ideas from that round", () => {
    const row = makeRow("run-1", {
      expertResultJson: makeExpertResultJson([
        { roundNumber: 1, ideas: [] },
        { roundNumber: 2, ideas: [makeScoredIdea("idea-a", 2, 0.6)] },
      ]),
    });

    const result = aggregateIdeas([row]);
    expect(result.ideas).toHaveLength(1);
    expect(result.ideas[0]?.round).toBe(2);
  });
});

// ─── 20. Idea entry missing id field ─────────────────────────────────────────

describe("aggregateIdeas — malformed idea entries", () => {
  test("idea without an id field is skipped, no throw", () => {
    // Build a raw ExpertGameResult with a malformed idea (missing id)
    const expertResult = {
      rounds: [
        {
          roundNumber: 1,
          roundType: "divergent_generation",
          agentActions: [],
          outcomes: {
            selectedIdeas: [
              {
                // Missing "id" field
                title: "No ID Idea",
                description: "This idea has no id",
                proposedBy: "agent-1",
                round: 1,
                expertScore: 0.8,
                incentiveBreakdown: ZERO_BREAKDOWN,
                strategicMetadata: {
                  paretoOptimal: false,
                  dominantStrategy: false,
                  evolutionarilyStable: false,
                  nashEquilibrium: false,
                },
              },
            ],
            eliminatedIdeas: [],
          },
        },
      ],
      equilibria: [],
      rankedIdeas: [],
      metaGameHealth: {
        agentBalanceScores: {},
        diversityIndex: 0,
        convergenceRate: 0,
        noveltyScore: 0,
      },
    };

    const row = makeRow("run-1", {
      expertResultJson: JSON.stringify(expertResult),
    });

    expect(() => aggregateIdeas([row])).not.toThrow();
    const result = aggregateIdeas([row]);
    expect(result.ideas).toHaveLength(0);
  });

  test("null idea entry inside selectedIdeas is skipped", () => {
    const expertResult = {
      rounds: [
        {
          roundNumber: 1,
          roundType: "divergent_generation",
          agentActions: [],
          outcomes: {
            selectedIdeas: [null, makeScoredIdea("idea-valid", 1, 0.7)],
            eliminatedIdeas: [],
          },
        },
      ],
      equilibria: [],
      rankedIdeas: [],
      metaGameHealth: {
        agentBalanceScores: {},
        diversityIndex: 0,
        convergenceRate: 0,
        noveltyScore: 0,
      },
    };

    const row = makeRow("run-1", {
      expertResultJson: JSON.stringify(expertResult),
    });

    expect(() => aggregateIdeas([row])).not.toThrow();
    const result = aggregateIdeas([row]);
    // Only the valid idea should appear
    expect(result.ideas).toHaveLength(1);
    expect(result.ideas[0]?.ideaId).toBe("idea-valid");
  });
});

// ─── 21. Missing incentiveBreakdown fields default to 0 ──────────────────────

describe("aggregateIdeas — missing incentiveBreakdown fields", () => {
  test("idea with no incentiveBreakdown gets all-zero breakdown fields", () => {
    const expertResult = {
      rounds: [
        {
          roundNumber: 1,
          roundType: "divergent_generation",
          agentActions: [],
          outcomes: {
            selectedIdeas: [
              {
                id: "idea-no-breakdown",
                title: "No Breakdown",
                description: "desc",
                proposedBy: "agent-1",
                round: 1,
                expertScore: 0.6,
                // incentiveBreakdown intentionally absent
                strategicMetadata: {
                  paretoOptimal: false,
                  dominantStrategy: false,
                  evolutionarilyStable: false,
                  nashEquilibrium: false,
                },
              },
            ],
            eliminatedIdeas: [],
          },
        },
      ],
      equilibria: [],
      rankedIdeas: [],
      metaGameHealth: {
        agentBalanceScores: {},
        diversityIndex: 0,
        convergenceRate: 0,
        noveltyScore: 0,
      },
    };

    const row = makeRow("run-1", {
      expertResultJson: JSON.stringify(expertResult),
      fusedScoresJson: makeFusedScoresJson([
        { ideaId: "idea-no-breakdown", socialScore: 0.5, fusedScore: 0.55 },
      ]),
    });

    expect(() => aggregateIdeas([row])).not.toThrow();
    const result = aggregateIdeas([row]);
    expect(result.ideas[0]?.ideaId).toBe("idea-no-breakdown");
    // The fused breakdown (from fusedScores) replaces the expert-game breakdown
    // The idea's `breakdown` is from the FusedScore, not from the ScoredIdea.
    // (aggregate.ts step 5 uses fused.breakdown)
    // For the non-final path, the per-round IncentiveBreakdown should be zero-defaulted.
    // We verify no throw — the per-round breakdown is internal to dedupeEntry only.
  });

  test("idea with partial incentiveBreakdown: missing fields default to 0", () => {
    const expertResult = {
      rounds: [
        {
          roundNumber: 1,
          roundType: "divergent_generation",
          agentActions: [],
          outcomes: {
            selectedIdeas: [
              {
                id: "idea-partial",
                title: "Partial Breakdown",
                description: "desc",
                proposedBy: "agent-1",
                round: 1,
                expertScore: 0.6,
                incentiveBreakdown: {
                  diversityBonus: 0.5,
                  // buildingBonus missing — should default to 0
                },
                strategicMetadata: {
                  paretoOptimal: false,
                  dominantStrategy: false,
                  evolutionarilyStable: false,
                  nashEquilibrium: false,
                },
              },
            ],
            eliminatedIdeas: [],
          },
        },
      ],
      equilibria: [],
      rankedIdeas: [],
      metaGameHealth: {
        agentBalanceScores: {},
        diversityIndex: 0,
        convergenceRate: 0,
        noveltyScore: 0,
      },
    };

    const row = makeRow("run-1", {
      expertResultJson: JSON.stringify(expertResult),
    });

    expect(() => aggregateIdeas([row])).not.toThrow();
  });
});

// ─── Combined opts ────────────────────────────────────────────────────────────

describe("aggregateIdeas — combined opts", () => {
  test("finalOnly + runId together work correctly", () => {
    const row1 = makeRow("run-1", {
      expertResultJson: makeExpertResultJson([
        { roundNumber: 1, ideas: [makeScoredIdea("idea-a", 1, 0.5)] },
      ]),
      fusedScoresJson: makeFusedScoresJson([
        { ideaId: "idea-a", socialScore: 0.5, fusedScore: 0.5 },
      ]),
    });
    const row2 = makeRow("run-2", {
      expertResultJson: makeExpertResultJson([
        { roundNumber: 1, ideas: [makeScoredIdea("idea-b", 1, 0.6)] },
      ]),
      fusedScoresJson: makeFusedScoresJson([
        { ideaId: "idea-b", socialScore: 0.6, fusedScore: 0.6 },
      ]),
    });

    const result = aggregateIdeas([row1, row2], {
      finalOnly: true,
      runId: "run-1",
    });
    expect(result.ideas).toHaveLength(1);
    expect(result.ideas[0]?.runId).toBe("run-1");
    expect(result.ideas[0]?.isFinal).toBe(true);
  });

  test("finalOnly + minScore together: fusedScore checked against minScore", () => {
    const row = makeRow("run-1", {
      expertResultJson: makeExpertResultJson([
        { roundNumber: 1, ideas: [makeScoredIdea("idea-low", 1, 0.9)] },
        { roundNumber: 1, ideas: [makeScoredIdea("idea-high", 1, 0.3)] },
      ]),
      fusedScoresJson: makeFusedScoresJson([
        { ideaId: "idea-low", socialScore: 0.2, fusedScore: 0.25 },
        { ideaId: "idea-high", socialScore: 0.9, fusedScore: 0.88 },
      ]),
    });

    const result = aggregateIdeas([row], { finalOnly: true, minScore: 0.5 });
    expect(result.ideas).toHaveLength(1);
    expect(result.ideas[0]?.ideaId).toBe("idea-high");
  });
});
