import { test, expect, describe } from "bun:test";
import { getTemporalHalfLife } from "./temporal-profiles";
import type { MemorySourceKind } from "./types";

describe("getTemporalHalfLife", () => {
  test("tweets have short half-life (7 days)", () => {
    expect(getTemporalHalfLife("tweet")).toBe(7);
  });

  test("conversations have 14-day half-life", () => {
    expect(getTemporalHalfLife("conversation")).toBe(14);
  });

  test("articles have 60-day half-life", () => {
    expect(getTemporalHalfLife("article")).toBe(60);
  });

  test("documents have long half-life (180 days)", () => {
    expect(getTemporalHalfLife("document")).toBe(180);
  });

  test("notes have long half-life (180 days)", () => {
    expect(getTemporalHalfLife("note")).toBe(180);
  });

  test("ideas have 120-day half-life", () => {
    expect(getTemporalHalfLife("idea")).toBe(120);
  });

  test("all memory source kinds have profiles", () => {
    const kinds: MemorySourceKind[] = [
      "conversation", "note", "document", "tweet", "article",
      "product", "story", "reddit_post", "hf_model", "github_repo",
      "arxiv_paper", "observation", "idea",
    ];
    for (const kind of kinds) {
      const hl = getTemporalHalfLife(kind);
      expect(hl).toBeGreaterThan(0);
    }
  });

  test("ephemeral content decays faster than reference content", () => {
    expect(getTemporalHalfLife("tweet")).toBeLessThan(
      getTemporalHalfLife("document"),
    );
    expect(getTemporalHalfLife("reddit_post")).toBeLessThan(
      getTemporalHalfLife("arxiv_paper"),
    );
  });
});
