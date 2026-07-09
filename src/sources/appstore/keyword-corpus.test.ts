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
});
