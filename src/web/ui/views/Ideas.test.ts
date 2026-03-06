import { test, expect } from "bun:test";

// Re-implemented from Ideas.tsx (module-private pure functions)

interface GeneratedIdea {
  readonly id: string;
  readonly agent_id: string;
  readonly title: string;
  readonly summary: string;
  readonly reasoning: string;
  readonly sources_used: string;
  readonly category: string;
  readonly rating: number | null;
  readonly pipeline_stage: string;
  readonly model_references: string;
  readonly created_at: number;
}

function computeRatingCounts(ideas: readonly GeneratedIdea[]) {
  let rated = 0;
  let unrated = 0;
  let sum = 0;
  for (const idea of ideas) {
    if (idea.rating != null) {
      rated++;
      sum += idea.rating;
    } else {
      unrated++;
    }
  }
  return {
    total: ideas.length,
    rated,
    unrated,
    average: rated > 0 ? sum / rated : null,
  };
}

type SortMode = "newest" | "top_rated" | "lowest_rated";

function sortIdeas(
  ideas: readonly GeneratedIdea[],
  mode: SortMode,
): readonly GeneratedIdea[] {
  const sorted = [...ideas];
  switch (mode) {
    case "newest":
      return sorted.sort((a, b) => b.created_at - a.created_at);
    case "top_rated":
      return sorted.sort((a, b) => {
        const scoreA = a.rating ?? -1;
        const scoreB = b.rating ?? -1;
        return scoreB - scoreA || b.created_at - a.created_at;
      });
    case "lowest_rated":
      return sorted.sort((a, b) => {
        const scoreA = a.rating ?? 6;
        const scoreB = b.rating ?? 6;
        return scoreA - scoreB || b.created_at - a.created_at;
      });
    default:
      return sorted;
  }
}

const mkIdea = (
  overrides: Partial<GeneratedIdea> = {},
): GeneratedIdea => ({
  id: "1",
  agent_id: "ai-idea-gen",
  title: "Test Idea",
  summary: "A test idea",
  reasoning: "Because testing",
  sources_used: "",
  category: "ai_app",
  rating: null,
  pipeline_stage: "idea",
  model_references: "",
  created_at: 1000,
  ...overrides,
});

/* ---------- computeRatingCounts ---------- */

test("computeRatingCounts counts rated and unrated correctly", () => {
  const ideas = [
    mkIdea({ rating: 5 }),
    mkIdea({ rating: 4 }),
    mkIdea({ rating: 1 }),
    mkIdea({ rating: null }),
    mkIdea({ rating: null }),
    mkIdea({ rating: null }),
  ];
  const counts = computeRatingCounts(ideas);
  expect(counts.total).toBe(6);
  expect(counts.rated).toBe(3);
  expect(counts.unrated).toBe(3);
});

test("computeRatingCounts computes average correctly", () => {
  const ideas = [
    mkIdea({ rating: 5 }),
    mkIdea({ rating: 3 }),
    mkIdea({ rating: 2 }),
    mkIdea({ rating: null }),
  ];
  const counts = computeRatingCounts(ideas);
  expect(counts.average).toBeCloseTo(10 / 3);
});

test("computeRatingCounts handles empty array", () => {
  const counts = computeRatingCounts([]);
  expect(counts).toEqual({ total: 0, rated: 0, unrated: 0, average: null });
});

test("computeRatingCounts average is null when all unrated", () => {
  const ideas = [mkIdea({ rating: null }), mkIdea({ rating: null })];
  const counts = computeRatingCounts(ideas);
  expect(counts.average).toBeNull();
});

test("computeRatingCounts handles zero rating", () => {
  const ideas = [mkIdea({ rating: 0 }), mkIdea({ rating: 4 })];
  const counts = computeRatingCounts(ideas);
  expect(counts.rated).toBe(2);
  expect(counts.average).toBe(2);
});

/* ---------- sortIdeas ---------- */

test("sortIdeas newest puts most recent first", () => {
  const ideas = [
    mkIdea({ id: "old", created_at: 100 }),
    mkIdea({ id: "new", created_at: 300 }),
    mkIdea({ id: "mid", created_at: 200 }),
  ];
  const sorted = sortIdeas(ideas, "newest");
  expect(sorted[0]!.id).toBe("new");
  expect(sorted[1]!.id).toBe("mid");
  expect(sorted[2]!.id).toBe("old");
});

test("sortIdeas top_rated puts highest rating first, null last", () => {
  const ideas = [
    mkIdea({ id: "low", rating: 1, created_at: 300 }),
    mkIdea({ id: "unrated", rating: null, created_at: 200 }),
    mkIdea({ id: "high", rating: 5, created_at: 100 }),
  ];
  const sorted = sortIdeas(ideas, "top_rated");
  expect(sorted[0]!.id).toBe("high");
  expect(sorted[1]!.id).toBe("low");
  expect(sorted[2]!.id).toBe("unrated");
});

test("sortIdeas lowest_rated puts lowest rating first, null last", () => {
  const ideas = [
    mkIdea({ id: "high", rating: 5, created_at: 300 }),
    mkIdea({ id: "unrated", rating: null, created_at: 200 }),
    mkIdea({ id: "low", rating: 1, created_at: 100 }),
  ];
  const sorted = sortIdeas(ideas, "lowest_rated");
  expect(sorted[0]!.id).toBe("low");
  expect(sorted[1]!.id).toBe("high");
  expect(sorted[2]!.id).toBe("unrated");
});

test("sortIdeas uses created_at as tiebreaker", () => {
  const ideas = [
    mkIdea({ id: "older", rating: 4, created_at: 100 }),
    mkIdea({ id: "newer", rating: 4, created_at: 300 }),
  ];
  const sorted = sortIdeas(ideas, "top_rated");
  expect(sorted[0]!.id).toBe("newer");
  expect(sorted[1]!.id).toBe("older");
});

test("sortIdeas handles empty array", () => {
  expect(sortIdeas([], "newest")).toEqual([]);
});

test("sortIdeas does not mutate original", () => {
  const ideas = [
    mkIdea({ id: "b", created_at: 100 }),
    mkIdea({ id: "a", created_at: 200 }),
  ];
  sortIdeas(ideas, "newest");
  expect(ideas[0]!.id).toBe("b");
});
