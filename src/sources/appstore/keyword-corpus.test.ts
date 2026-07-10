import { describe, expect, it } from "bun:test";
import { buildSeedCorpus, GENRE_ZONES } from "./keyword-corpus";

describe("keyword-corpus", () => {
  it("is deterministic and covers every genre zone", () => {
    const a = buildSeedCorpus();
    const b = buildSeedCorpus();
    expect(a).toEqual(b);
    for (const zone of GENRE_ZONES) expect(a.some((r) => r.genreZone === zone)).toBe(true);
  });
  it("normalizes keywords to lowercase and dedupes", () => {
    const corpus = buildSeedCorpus();
    const keys = corpus.map((r) => r.keyword);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((k) => k === k.toLowerCase())).toBe(true);
  });
  it("includes a known health gap seed", () => {
    expect(buildSeedCorpus().some((r) => r.keyword === "fatty liver diet")).toBe(true);
  });
  it("never generates nonsense noun/modifier combinations", () => {
    const keys = new Set(buildSeedCorpus().map((r) => r.keyword));
    // Each of these pairs a noun with a modifier that doesn't fit it — the
    // blanket noun × all-MODIFIERS cross used to produce all of them.
    expect(keys.has("vpn planner")).toBe(false);
    expect(keys.has("flashlight for beginners")).toBe(false);
    expect(keys.has("crypto widget")).toBe(false);
    expect(keys.has("password manager tracker")).toBe(false);
    expect(keys.has("dating tracker")).toBe(false);
    expect(keys.has("chat planner")).toBe(false);
  });
  it("still generates sensible noun/modifier combinations", () => {
    const keys = new Set(buildSeedCorpus().map((r) => r.keyword));
    expect(keys.has("workout tracker")).toBe(true);
    expect(keys.has("budget planner")).toBe(true);
    expect(keys.has("calorie widget")).toBe(true);
    expect(keys.has("yoga for beginners")).toBe(true);
    expect(keys.has("vpn free")).toBe(true);
    expect(keys.has("vpn pro")).toBe(true);
    expect(keys.has("vpn app")).toBe(true);
  });
});
