import { test, expect, describe } from "bun:test";
import { getChunkProfile } from "./chunk-profiles";
import type { MemorySourceKind } from "./types";

describe("getChunkProfile", () => {
  test("returns profile for tweet", () => {
    const p = getChunkProfile("tweet");
    expect(p.maxTokens).toBe(150);
    expect(p.overlap).toBe(0);
  });

  test("returns profile for article", () => {
    const p = getChunkProfile("article");
    expect(p.maxTokens).toBe(500);
    expect(p.overlap).toBe(100);
  });

  test("returns profile for conversation", () => {
    const p = getChunkProfile("conversation");
    expect(p.maxTokens).toBe(400);
    expect(p.overlap).toBe(80);
  });

  test("returns profile for observation", () => {
    const p = getChunkProfile("observation");
    expect(p.maxTokens).toBe(300);
    expect(p.overlap).toBe(50);
  });

  test("returns profile for idea", () => {
    const p = getChunkProfile("idea");
    expect(p.maxTokens).toBe(400);
    expect(p.overlap).toBe(80);
  });

  test("all memory source kinds have profiles", () => {
    const kinds: MemorySourceKind[] = [
      "conversation",
      "note",
      "document",
      "tweet",
      "article",
      "product",
      "story",
      "reddit_post",
      "github_repo",
      "observation",
      "idea",
    ];
    for (const kind of kinds) {
      const p = getChunkProfile(kind);
      expect(p).toBeDefined();
      expect(p.maxTokens).toBeGreaterThan(0);
      expect(p.overlap).toBeGreaterThanOrEqual(0);
    }
  });

  test("short-content types have no overlap", () => {
    expect(getChunkProfile("tweet").overlap).toBe(0);
    expect(getChunkProfile("product").overlap).toBe(0);
    expect(getChunkProfile("github_repo").overlap).toBe(0);
  });

  test("long-content types have overlap", () => {
    expect(getChunkProfile("article").overlap).toBeGreaterThan(0);
    expect(getChunkProfile("document").overlap).toBeGreaterThan(0);
  });
});
