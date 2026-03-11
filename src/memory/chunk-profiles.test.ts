import { test, expect, describe } from "bun:test";
import { getChunkProfile } from "./chunk-profiles";
import { MEMORY_SOURCE_KINDS } from "./types";

describe("getChunkProfile", () => {
  test("returns profile for x_post", () => {
    const p = getChunkProfile("x_post");
    expect(p.maxTokens).toBe(150);
    expect(p.overlap).toBe(0);
  });

  test("returns profile for reuters_news", () => {
    const p = getChunkProfile("reuters_news");
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
    for (const kind of MEMORY_SOURCE_KINDS) {
      const p = getChunkProfile(kind);
      expect(p).toBeDefined();
      expect(p.maxTokens).toBeGreaterThan(0);
      expect(p.overlap).toBeGreaterThanOrEqual(0);
    }
  });

  test("short-content types have no overlap", () => {
    expect(getChunkProfile("x_post").overlap).toBe(0);
    expect(getChunkProfile("producthunt_product").overlap).toBe(0);
    expect(getChunkProfile("github_repo").overlap).toBe(0);
  });

  test("long-content types have overlap", () => {
    expect(getChunkProfile("reuters_news").overlap).toBeGreaterThan(0);
    expect(getChunkProfile("document").overlap).toBeGreaterThan(0);
  });
});
