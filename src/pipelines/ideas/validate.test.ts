import { test, expect, describe } from "bun:test";
import {
  normalizeTitle,
  buildValidSignalTokens,
  verifyCandidateEvidence,
  verifyEvidence,
} from "./validate";
import type { Capability, GeneratedIdeaCandidate } from "./types";

// ── Test fixtures ───────────────────────────────────────────────────────────

function cap(source: string, title: string): Capability {
  return {
    title,
    source,
    url: `https://example.com/${title}`,
    description: title,
    type: "new_tech",
  };
}

function candidate(
  title: string,
  supportingSignalIds?: readonly string[],
): GeneratedIdeaCandidate {
  return {
    title,
    summary: `${title} summary`,
    reasoning: "r",
    designDescription: "d",
    monetizationDetail: "m",
    sourceLinks: [],
    sourcesUsed: "s",
    category: "mobile_app",
    qualityScore: 4,
    targetAudience: "a",
    keyFeatures: ["f"],
    revenueModel: "rm",
    trendIntersection: "ti",
    ...(supportingSignalIds ? { supportingSignalIds } : {}),
  };
}

// ── normalizeTitle ──────────────────────────────────────────────────────────

describe("normalizeTitle", () => {
  test("lowercases, strips punctuation, collapses whitespace", () => {
    expect(normalizeTitle("  Quiet-Hours!!  App  ")).toBe("quiethours app");
  });

  test("is idempotent", () => {
    const once = normalizeTitle("Foo: Bar");
    expect(normalizeTitle(once)).toBe(once);
  });
});

// ── buildValidSignalTokens ──────────────────────────────────────────────────

describe("buildValidSignalTokens", () => {
  test("builds <source>_<index> tokens over capability ordering", () => {
    const tokens = buildValidSignalTokens([
      cap("hackernews", "A"),
      cap("producthunt", "B"),
      cap("github", "C"),
    ]);
    expect(tokens.has("hackernews_0")).toBe(true);
    expect(tokens.has("producthunt_1")).toBe(true);
    expect(tokens.has("github_2")).toBe(true);
    expect(tokens.has("hackernews_1")).toBe(false);
  });

  test("slugifies non-alphanumeric source names", () => {
    const tokens = buildValidSignalTokens([cap("Hacker News!", "A")]);
    expect(tokens.has("hacker_news_0")).toBe(true);
  });

  test("empty capabilities yields empty token set", () => {
    expect(buildValidSignalTokens([]).size).toBe(0);
  });
});

// ── verifyCandidateEvidence ─────────────────────────────────────────────────

describe("verifyCandidateEvidence", () => {
  const valid = new Set(["hackernews_0", "producthunt_1"]);

  test("no citations → neutral grounding, unchanged candidate", () => {
    const c = candidate("NoCite");
    const r = verifyCandidateEvidence(c, valid);
    expect(r.signalGrounding).toBe(1);
    expect(r.fabricated).toEqual([]);
    expect(r.candidate).toBe(c);
  });

  test("all citations real → grounding 1, none dropped", () => {
    const c = candidate("AllReal", ["hackernews_0", "producthunt_1"]);
    const r = verifyCandidateEvidence(c, valid);
    expect(r.signalGrounding).toBe(1);
    expect(r.fabricated).toEqual([]);
    expect(r.candidate.supportingSignalIds).toEqual(["hackernews_0", "producthunt_1"]);
  });

  test("partial fabrication → fractional grounding, fabricated stripped", () => {
    const c = candidate("Partial", ["hackernews_0", "ghost_9"]);
    const r = verifyCandidateEvidence(c, valid);
    expect(r.signalGrounding).toBe(0.5);
    expect(r.fabricated).toEqual(["ghost_9"]);
    expect(r.candidate.supportingSignalIds).toEqual(["hackernews_0"]);
  });

  test("fully fabricated → grounding 0", () => {
    const c = candidate("Fake", ["ghost_9", "fake_3"]);
    const r = verifyCandidateEvidence(c, valid);
    expect(r.signalGrounding).toBe(0);
    expect(r.fabricated).toEqual(["ghost_9", "fake_3"]);
  });

  test("token matching is case-insensitive", () => {
    const r = verifyCandidateEvidence(candidate("CaseTest", ["HACKERNEWS_0"]), valid);
    expect(r.signalGrounding).toBe(1);
  });

  test("does not mutate the input candidate", () => {
    const c = candidate("NoMutate", ["hackernews_0", "ghost_9"]);
    const snapshot = [...(c.supportingSignalIds ?? [])];
    verifyCandidateEvidence(c, valid);
    expect(c.supportingSignalIds).toEqual(snapshot);
  });
});

// ── verifyEvidence (batch) ──────────────────────────────────────────────────

describe("verifyEvidence", () => {
  const capabilities = [cap("hackernews", "A"), cap("producthunt", "B")];

  test("keeps all candidates (annotate-don't-drop); penalizes unverified grounding", () => {
    const result = verifyEvidence(
      [
        candidate("Grounded", ["hackernews_0"]),
        candidate("Unverified", ["ghost_9"]),
        candidate("NoCite"),
      ],
      capabilities,
    );

    const titles = result.kept.map((c) => c.title);
    // No candidate is dropped — even fully-unverified citations are kept.
    expect(titles).toContain("Grounded");
    expect(titles).toContain("NoCite");
    expect(titles).toContain("Unverified");
    // The unverified one is penalized to grounding 0 and noted.
    expect(result.groundingByTitle.get("Unverified")).toBe(0);
    expect(result.notes.some((n) => n.includes("UNVERIFIED"))).toBe(true);
  });

  test("empty token set (no capabilities) → keep all, neutral grounding", () => {
    const result = verifyEvidence(
      [candidate("LandscapeOnly", ["starbucks_ios_rating"])],
      [],
    );
    expect(result.kept.map((c) => c.title)).toContain("LandscapeOnly");
    expect(result.groundingByTitle.get("LandscapeOnly")).toBe(0.5);
  });

  test("records grounding scores by title for kept candidates", () => {
    const result = verifyEvidence(
      [candidate("Half", ["hackernews_0", "ghost_1"])],
      capabilities,
    );
    expect(result.groundingByTitle.get("Half")).toBe(0.5);
  });

  test("empty input yields empty output", () => {
    const result = verifyEvidence([], capabilities);
    expect(result.kept).toEqual([]);
    expect(result.notes).toEqual([]);
    expect(result.groundingByTitle.size).toBe(0);
  });
});
