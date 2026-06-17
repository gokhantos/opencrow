import { test, expect, describe } from "bun:test";
import { scoredIdeaToCandidate } from "./cross-write";
import type { ScoredIdea, StrategicMetadata } from "./types";

const META: StrategicMetadata = {
  paretoOptimal: true,
  dominantStrategy: false,
  evolutionarilyStable: false,
  nashEquilibrium: true,
};

function makeIdea(partial: Partial<ScoredIdea>): ScoredIdea {
  return {
    id: "idea-1",
    title: "Test Idea",
    description: "A test description.",
    proposedBy: "rational_player",
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
    strategicMetadata: META,
    ...partial,
  };
}

describe("scoredIdeaToCandidate", () => {
  test("maps title → title and description → summary", () => {
    const candidate = scoredIdeaToCandidate(
      makeIdea({ title: "Foo", description: "Bar baz." }),
    );
    expect(candidate.title).toBe("Foo");
    expect(candidate.summary).toBe("Bar baz.");
  });

  test("maps fusedScore in [0,1] onto the 1–5 quality scale", () => {
    // 0 → 1, 1 → 5, 0.5 → 3
    expect(scoredIdeaToCandidate(makeIdea({ fusedScore: 0 })).qualityScore).toBe(1);
    expect(scoredIdeaToCandidate(makeIdea({ fusedScore: 1 })).qualityScore).toBe(5);
    expect(scoredIdeaToCandidate(makeIdea({ fusedScore: 0.5 })).qualityScore).toBe(3);
  });

  test("falls back to expertScore when fusedScore is absent", () => {
    const candidate = scoredIdeaToCandidate(
      makeIdea({ fusedScore: undefined, expertScore: 1 }),
    );
    expect(candidate.qualityScore).toBe(5);
  });

  test("clamps quality score into [1,5] for out-of-range scores", () => {
    // A score >1 should still clamp to 5; a negative score clamps to 1.
    expect(
      scoredIdeaToCandidate(makeIdea({ fusedScore: 2 })).qualityScore,
    ).toBe(5);
    expect(
      scoredIdeaToCandidate(makeIdea({ fusedScore: -1 })).qualityScore,
    ).toBe(1);
  });

  test("produces a valid, neutral candidate with no source links and sige provenance hints", () => {
    const candidate = scoredIdeaToCandidate(makeIdea({}));
    expect(candidate.sourceLinks).toEqual([]);
    expect(candidate.sourcesUsed).toBe("sige");
    expect(candidate.category).toBe("sige");
    expect(candidate.keyFeatures).toEqual([]);
  });

  test("does not mutate the input idea (immutability)", () => {
    const idea = makeIdea({ title: "Immutable" });
    const snapshot = JSON.stringify(idea);
    scoredIdeaToCandidate(idea);
    expect(JSON.stringify(idea)).toBe(snapshot);
  });
});
