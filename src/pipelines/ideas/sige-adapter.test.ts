/**
 * Unit tests for the SIGE pipeline adapter functions.
 *
 * Tests: mapDeepGameRankedToCandidate, mapDivergentToCandidate (backward compat +
 * sourceTag opt), mergeSigeCandidates (deep-first, title-dedup, immutability, cap).
 *
 * All pure functions — no DB, no LLM, no Mem0.
 */
import { describe, test, expect } from "bun:test";
import {
  mapDeepGameRankedToCandidate,
  mapDivergentToCandidate,
  mergeSigeCandidates,
} from "./pipeline";
import type { GeneratedIdeaCandidate } from "./types";
import type { ScoredIdea } from "../../sige/types";
import type { DivergentCandidate } from "../../sige/run";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeScoredIdea(overrides: Partial<ScoredIdea> = {}): ScoredIdea {
  return {
    id: "idea-1",
    title: "Smart Task Automator",
    description: "Automates repetitive tasks using AI to save 3h/week.",
    proposedBy: "rational_player",
    round: 2,
    expertScore: 0.85,
    incentiveBreakdown: {
      diversityBonus: 0.1,
      buildingBonus: 0.2,
      surpriseBonus: 0.15,
      accuracyPenalty: 0.05,
      memoryReward: 0.1,
      coalitionStability: 0.2,
      signalCredibility: 0.9,
      socialViability: 0.75,
    },
    strategicMetadata: {
      equilibriumType: "nash",
      dominantStrategy: true,
      paretoOptimal: false,
      evolutionarilyStable: false,
      nashEquilibrium: true,
      supportingCoalition: [],
    },
    ...overrides,
  };
}

function makeDivergent(overrides: Partial<DivergentCandidate> = {}): DivergentCandidate {
  return {
    title: "AI Notes Organizer",
    summary: "Organizes notes automatically using semantic clustering.",
    proposedBy: "boundary_breaker",
    ...overrides,
  };
}

function makeCandidate(
  title: string,
  opts: Partial<GeneratedIdeaCandidate> = {},
): GeneratedIdeaCandidate {
  return {
    title,
    summary: `Summary for ${title}`,
    reasoning: "",
    designDescription: "",
    monetizationDetail: "",
    sourceLinks: [],
    sourcesUsed: "sige-deep (session)",
    category: "",
    qualityScore: 0,
    targetAudience: "",
    keyFeatures: [],
    revenueModel: "",
    trendIntersection: "",
    ...opts,
  };
}

// ── mapDeepGameRankedToCandidate ──────────────────────────────────────────────

describe("mapDeepGameRankedToCandidate", () => {
  test("maps title from ScoredIdea.title", () => {
    const idea = makeScoredIdea({ title: "Productivity Booster" });
    const candidate = mapDeepGameRankedToCandidate(idea);
    expect(candidate.title).toBe("Productivity Booster");
  });

  test("maps summary from ScoredIdea.description", () => {
    const idea = makeScoredIdea({ description: "This is the description text." });
    const candidate = mapDeepGameRankedToCandidate(idea);
    expect(candidate.summary).toBe("This is the description text.");
  });

  test("qualityScore is exactly 0 (unscored sentinel)", () => {
    const idea = makeScoredIdea({ expertScore: 0.99 });
    const candidate = mapDeepGameRankedToCandidate(idea);
    expect(candidate.qualityScore).toBe(0);
  });

  test("category is empty string (unscored sentinel)", () => {
    const candidate = mapDeepGameRankedToCandidate(makeScoredIdea());
    expect(candidate.category).toBe("");
  });

  test("giant field is NOT set (must not pre-score before GIANT jury)", () => {
    const candidate = mapDeepGameRankedToCandidate(makeScoredIdea());
    expect((candidate as unknown as Record<string, unknown>)["giant"]).toBeUndefined();
  });

  test("giantComposite field is NOT set", () => {
    const candidate = mapDeepGameRankedToCandidate(makeScoredIdea());
    expect((candidate as unknown as Record<string, unknown>)["giantComposite"]).toBeUndefined();
  });

  test("supportingSignalIds is NOT set (ScoredIdea carries no signal-id array)", () => {
    const candidate = mapDeepGameRankedToCandidate(makeScoredIdea());
    expect(candidate.supportingSignalIds).toBeUndefined();
  });

  test("sourcesUsed includes 'sige-deep' tag and 'session' default when no sessionId", () => {
    const candidate = mapDeepGameRankedToCandidate(makeScoredIdea());
    expect(candidate.sourcesUsed).toBe("sige-deep (session)");
  });

  test("sourcesUsed uses opts.sessionId when provided", () => {
    const candidate = mapDeepGameRankedToCandidate(makeScoredIdea(), { sessionId: "abc-123" });
    expect(candidate.sourcesUsed).toBe("sige-deep (abc-123)");
  });

  test("sourceLinks is an empty array", () => {
    const candidate = mapDeepGameRankedToCandidate(makeScoredIdea());
    expect(candidate.sourceLinks).toEqual([]);
  });

  test("is PURE — same input yields same output", () => {
    const idea = makeScoredIdea();
    const c1 = mapDeepGameRankedToCandidate(idea);
    const c2 = mapDeepGameRankedToCandidate(idea);
    expect(c1.title).toBe(c2.title);
    expect(c1.qualityScore).toBe(c2.qualityScore);
    expect(c1.sourcesUsed).toBe(c2.sourcesUsed);
  });

  test("reasoning is the same as description (ScoredIdea has no separate problem statement)", () => {
    const idea = makeScoredIdea({ description: "Full description here." });
    const candidate = mapDeepGameRankedToCandidate(idea);
    expect(candidate.reasoning).toBe("Full description here.");
  });
});

// ── mapDivergentToCandidate ───────────────────────────────────────────────────

describe("mapDivergentToCandidate", () => {
  test("backward compat: no opts => sourcesUsed is 'sige-divergent (proposedBy)'", () => {
    const divergent = makeDivergent({ proposedBy: "contrarian" });
    const candidate = mapDivergentToCandidate(divergent);
    expect(candidate.sourcesUsed).toBe("sige-divergent (contrarian)");
  });

  test("sourceTag opt overrides the 'sige-divergent' prefix", () => {
    const divergent = makeDivergent({ proposedBy: "rational_player" });
    const candidate = mapDivergentToCandidate(divergent, { sourceTag: "sige-discovery" });
    expect(candidate.sourcesUsed).toBe("sige-discovery (rational_player)");
  });

  test("title and summary are mapped from DivergentCandidate", () => {
    const divergent = makeDivergent({ title: "AI Code Review", summary: "Reviews code faster." });
    const candidate = mapDivergentToCandidate(divergent);
    expect(candidate.title).toBe("AI Code Review");
    expect(candidate.summary).toBe("Reviews code faster.");
  });

  test("qualityScore is 0 (unscored sentinel)", () => {
    const candidate = mapDivergentToCandidate(makeDivergent());
    expect(candidate.qualityScore).toBe(0);
  });

  test("category is empty string", () => {
    const candidate = mapDivergentToCandidate(makeDivergent());
    expect(candidate.category).toBe("");
  });

  test("supportingSignalIds is set when DivergentCandidate provides it", () => {
    const divergent = makeDivergent({ supportingSignalIds: ["hn_1", "gh_2"] });
    const candidate = mapDivergentToCandidate(divergent);
    expect(candidate.supportingSignalIds).toEqual(["hn_1", "gh_2"]);
  });

  test("supportingSignalIds is absent when DivergentCandidate omits it", () => {
    const divergent = makeDivergent(); // no supportingSignalIds
    const candidate = mapDivergentToCandidate(divergent);
    expect(candidate.supportingSignalIds).toBeUndefined();
  });
});

// ── mergeSigeCandidates ───────────────────────────────────────────────────────

describe("mergeSigeCandidates", () => {
  test("deep candidates come first in the merged output", () => {
    const deep = [makeCandidate("Deep Idea A"), makeCandidate("Deep Idea B")];
    const broad = [makeCandidate("Broad Idea X"), makeCandidate("Broad Idea Y")];
    const merged = mergeSigeCandidates(broad, deep);
    expect(merged[0]!.title).toBe("Deep Idea A");
    expect(merged[1]!.title).toBe("Deep Idea B");
    expect(merged[2]!.title).toBe("Broad Idea X");
    expect(merged[3]!.title).toBe("Broad Idea Y");
  });

  test("deduplicates by title (case-insensitive)", () => {
    const deep = [makeCandidate("Smart Task Automator")];
    const broad = [makeCandidate("smart task automator"), makeCandidate("Other Idea")];
    const merged = mergeSigeCandidates(broad, deep);
    // Dedup: "smart task automator" appears twice (different case) — only once in merged
    const titles = merged.map((c) => c.title.toLowerCase());
    const smartCount = titles.filter((t) => t === "smart task automator").length;
    expect(smartCount).toBe(1);
    // "Other Idea" makes it through
    expect(merged.map((c) => c.title)).toContain("Other Idea");
  });

  test("deduplication is whitespace-insensitive (trims keys)", () => {
    const deep = [makeCandidate("  AI Notes  ")];
    const broad = [makeCandidate("ai notes")];
    const merged = mergeSigeCandidates(broad, deep);
    // The broad item with matching trimmed+lowercased title should be deduped
    expect(merged.length).toBe(1);
  });

  test("respects opts.maxPool cap", () => {
    const deep = Array.from({ length: 5 }, (_, i) => makeCandidate(`Deep ${i}`));
    const broad = Array.from({ length: 10 }, (_, i) => makeCandidate(`Broad ${i}`));
    const merged = mergeSigeCandidates(broad, deep, { maxPool: 8 });
    expect(merged.length).toBe(8);
  });

  test("default cap is 40", () => {
    const deep = Array.from({ length: 30 }, (_, i) => makeCandidate(`Deep ${i}`));
    const broad = Array.from({ length: 20 }, (_, i) => makeCandidate(`Broad ${i}`));
    const merged = mergeSigeCandidates(broad, deep);
    expect(merged.length).toBe(40); // default maxPool
  });

  test("returns empty array when maxPool=0", () => {
    const deep = [makeCandidate("Deep A")];
    const broad = [makeCandidate("Broad A")];
    const merged = mergeSigeCandidates(broad, deep, { maxPool: 0 });
    expect(merged).toEqual([]);
  });

  test("does NOT mutate the deep input array", () => {
    const deep = [makeCandidate("D1"), makeCandidate("D2")];
    const broad = [makeCandidate("B1")];
    const originalLength = deep.length;
    mergeSigeCandidates(broad, deep);
    expect(deep.length).toBe(originalLength);
    expect(deep[0]!.title).toBe("D1");
  });

  test("does NOT mutate the broad input array", () => {
    const deep = [makeCandidate("D1")];
    const broad = [makeCandidate("B1"), makeCandidate("B2")];
    const originalLength = broad.length;
    mergeSigeCandidates(broad, deep);
    expect(broad.length).toBe(originalLength);
    expect(broad[0]!.title).toBe("B1");
  });

  test("returns a new array (not the same reference as deep or broad)", () => {
    const deep = [makeCandidate("D1")];
    const broad = [makeCandidate("B1")];
    const merged = mergeSigeCandidates(broad, deep);
    expect(merged).not.toBe(deep);
    expect(merged).not.toBe(broad);
  });

  test("handles empty deep array (broad-only result)", () => {
    const broad = [makeCandidate("B1"), makeCandidate("B2")];
    const merged = mergeSigeCandidates(broad, []);
    expect(merged.length).toBe(2);
    expect(merged[0]!.title).toBe("B1");
    expect(merged[1]!.title).toBe("B2");
  });

  test("handles empty broad array (deep-only result)", () => {
    const deep = [makeCandidate("D1"), makeCandidate("D2")];
    const merged = mergeSigeCandidates([], deep);
    expect(merged.length).toBe(2);
    expect(merged[0]!.title).toBe("D1");
  });

  test("handles empty empty arrays", () => {
    const merged = mergeSigeCandidates([], []);
    expect(merged).toEqual([]);
  });

  test("candidates with empty titles are skipped", () => {
    const deep = [makeCandidate(""), makeCandidate("Valid Deep")];
    const broad = [makeCandidate("  "), makeCandidate("Valid Broad")];
    const merged = mergeSigeCandidates(broad, deep);
    const titles = merged.map((c) => c.title.trim()).filter((t) => t.length > 0);
    expect(titles).toEqual(["Valid Deep", "Valid Broad"]);
  });
});
