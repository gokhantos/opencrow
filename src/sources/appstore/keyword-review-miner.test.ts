import { describe, expect, it } from "bun:test";
import { MIN_CROSS_APP_REPEAT, extractComplaintCandidates } from "./keyword-review-miner";
import type { ReviewMinerInput } from "./keyword-review-miner";

function review(appId: string, title: string, content: string): ReviewMinerInput {
  return { appId, title, content };
}

describe("extractComplaintCandidates", () => {
  it("keeps a NEED-shaped bigram from a single review (no cross-app repetition required)", () => {
    // "it" is dropped by the shared MIN_TOKEN_LENGTH=3 junk-token filter
    // (keyword-miner.ts's filterJunkTokens) — "they" (4 chars) survives, so
    // the anchor-bearing bigram "wish they" is what should surface here.
    const candidates = extractComplaintCandidates([
      review("app-1", "Missing feature", "I really wish they added dark mode support"),
    ]);
    const keywords = candidates.map((c) => c.keyword);
    expect(keywords).toContain("wish they");
  });

  it("drops a non-anchor n-gram that appears in only one review", () => {
    const candidates = extractComplaintCandidates([
      review("app-1", "Great app", "The interface design feels quite modern overall"),
    ]);
    // "interface design" carries no anchor token and appears in only 1 app —
    // must not qualify.
    expect(candidates.map((c) => c.keyword)).not.toContain("interface design");
  });

  it(`keeps a non-anchor n-gram that repeats across >= ${MIN_CROSS_APP_REPEAT} distinct apps (cross-app market-need signal)`, () => {
    const candidates = extractComplaintCandidates([
      review("app-1", "no title", "please add dark mode soon"),
      review("app-2", "no title", "still waiting for dark mode"),
      review("app-3", "no title", "when is dark mode coming"),
    ]);
    expect(candidates.map((c) => c.keyword)).toContain("dark mode");
  });

  it("does NOT keep a non-anchor n-gram repeated across only 2 distinct apps (below the cross-app threshold)", () => {
    const candidates = extractComplaintCandidates([
      review("app-1", "no title", "please add dark mode soon"),
      review("app-2", "no title", "still waiting for dark mode"),
    ]);
    expect(candidates.map((c) => c.keyword)).not.toContain("dark mode");
  });

  it("does not double-count a repeated phrase WITHIN a single review toward the cross-app tally", () => {
    // Same review repeats "dark mode" three times — this is still only ONE
    // distinct app, so it must not fake cross-app repetition on its own.
    const candidates = extractComplaintCandidates([
      review("app-1", "dark mode", "dark mode dark mode dark mode please"),
      review("app-2", "no title", "would love dark mode too"),
    ]);
    expect(candidates.map((c) => c.keyword)).not.toContain("dark mode");
  });

  it("builds both 2-token and 3-token n-grams, never 1-token", () => {
    const candidates = extractComplaintCandidates([
      review("app-1", "no title", "i wish it supported offline sync mode"),
    ]);
    const keywords = candidates.map((c) => c.keyword);
    // At least one 2-word and one 3-word anchor-bearing n-gram should surface.
    expect(keywords.some((k) => k.split(" ").length === 2)).toBe(true);
    expect(keywords.some((k) => k.split(" ").length === 3)).toBe(true);
    // Never a bare single-token candidate.
    expect(keywords.every((k) => k.split(" ").length >= 2)).toBe(true);
  });

  it("assigns the FIRST review's appId to a candidate (first-app-seen wins, mirrors keyword-miner.ts convention)", () => {
    const candidates = extractComplaintCandidates([
      review("app-first", "no title", "wish they had offline mode"),
      review("app-second", "no title", "wish they had offline mode too"),
    ]);
    const hit = candidates.find((c) => c.keyword === "wish they");
    expect(hit?.appId).toBe("app-first");
  });

  it("filters out junk n-grams via isJunkKeyword (e.g. purely generic/short tokens)", () => {
    const candidates = extractComplaintCandidates([
      review("app-1", "no title", "no no no"),
    ]);
    // "no no" / "no no no" are short, low-signal, and should be screened out
    // by the junk filter even though "no" is a NEED anchor token.
    expect(candidates.every((c) => c.keyword.length >= 3)).toBe(true);
  });

  it("returns an empty array for no reviews", () => {
    expect(extractComplaintCandidates([])).toEqual([]);
  });

  it("skips a review whose title+content normalize to nothing (e.g. pure punctuation/emoji)", () => {
    const candidates = extractComplaintCandidates([review("app-1", "!!!", "😀😀😀")]);
    expect(candidates).toEqual([]);
  });

  it("is case-insensitive and punctuation-tolerant when matching anchor tokens", () => {
    const candidates = extractComplaintCandidates([
      review("app-1", "Feature Request", "I WISH they supported widgets!!"),
    ]);
    expect(candidates.map((c) => c.keyword)).toContain("wish they");
  });

  it("drops an over-long single token (e.g. a 4000-char no-space run) instead of keeping it in a gram", () => {
    const hostileToken = "x".repeat(4000);
    const candidates = extractComplaintCandidates([
      review("app-1", "Feature request", `I wish they added ${hostileToken} support for dark mode`),
    ]);
    const keywords = candidates.map((c) => c.keyword);
    // The hostile token must not survive into any output n-gram...
    expect(keywords.some((k) => k.includes(hostileToken))).toBe(false);
    // ...nor any oversized token in general.
    expect(keywords.every((k) => k.split(" ").every((t) => t.length <= 30))).toBe(true);
    // The rest of the review's normal anchor-bearing bigram still surfaces —
    // dropping the hostile token doesn't take the whole review down with it.
    expect(keywords).toContain("wish they");
  });

  it("caps n-gram generation to the first MAX_REVIEW_TOKENS_PER_REVIEW cleaned tokens of a review", () => {
    // Build 500 unique filler tokens, with an anchor+marker pair near the
    // start (well within the per-review cap) and another anchor+marker pair
    // well past it, so only the first pair can produce a qualifying n-gram.
    const tokens = Array.from({ length: 500 }, (_, i) => `filler${i}`);
    tokens[2] = "want";
    tokens[3] = "kwstart";
    tokens[300] = "want";
    tokens[301] = "kwend";
    const candidates = extractComplaintCandidates([review("app-1", "no title", tokens.join(" "))]);
    const keywords = candidates.map((c) => c.keyword);
    expect(keywords.some((k) => k.includes("kwstart"))).toBe(true);
    expect(keywords.some((k) => k.includes("kwend"))).toBe(false);
  });
});
