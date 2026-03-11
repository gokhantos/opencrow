import { test, expect, describe } from "bun:test";
import { getTemporalHalfLife } from "./temporal-profiles";
import { MEMORY_SOURCE_KINDS } from "./types";

describe("getTemporalHalfLife", () => {
  test("x_post has short half-life (7 days)", () => {
    expect(getTemporalHalfLife("x_post")).toBe(7);
  });

  test("conversations have 14-day half-life", () => {
    expect(getTemporalHalfLife("conversation")).toBe(14);
  });

  test("news has 60-day half-life", () => {
    expect(getTemporalHalfLife("reuters_news")).toBe(60);
    expect(getTemporalHalfLife("cointelegraph_news")).toBe(60);
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
    for (const kind of MEMORY_SOURCE_KINDS) {
      const hl = getTemporalHalfLife(kind);
      expect(hl).toBeGreaterThan(0);
    }
  });

  test("ephemeral content decays faster than reference content", () => {
    expect(getTemporalHalfLife("x_post")).toBeLessThan(
      getTemporalHalfLife("document"),
    );
    expect(getTemporalHalfLife("reddit_post")).toBeLessThan(
      getTemporalHalfLife("idea"),
    );
  });
});
