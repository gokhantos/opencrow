/**
 * Unit tests for the PURE parts of Stage 2 (broad-shallow ideation):
 *   - extractSaturatedPhrases: parse the saturatedThemes block into phrases
 *   - noveltyScore: 1 - overlap of a sketch against saturated phrases
 *   - scoreSketch: the documented weighted blend (signal + novelty + market-gap)
 *   - parseSketchBatch: Zod-validated parse of a cheap-model batch response
 *   - rankScored: deterministic descending sort by composite score
 *
 * No I/O here — the orchestrator (which calls a cheap-model client) is covered in
 * shallow-ideation.isolated.test.ts so a mocked client never leaks across files.
 */

import { describe, expect, it } from "bun:test";
import {
  type IdeaSketch,
  type ScoredSketch,
  type ThemeCandidate,
  DEFAULT_SHALLOW_WEIGHTS,
  extractSaturatedPhrases,
  noveltyScore,
  parseSketchBatch,
  rankScored,
  scoreSketch,
} from "./shallow-ideation";

const candidate = (over: Partial<ThemeCandidate> = {}): ThemeCandidate => ({
  id: "c1",
  title: "AI email triage",
  signalCategory: "productivity",
  kind: "capability",
  source: "producthunt",
  signalStrength: 0.6,
  context: "Email overload pain meets cheap LLM classification.",
  ...over,
});

const sketch = (over: Partial<IdeaSketch> = {}): IdeaSketch => ({
  candidateId: "c1",
  line: "An inbox copilot that auto-files low-priority email so founders never triage.",
  marketGap: 0.7,
  ...over,
});

describe("extractSaturatedPhrases", () => {
  it("pulls the quoted theme phrases out of the saturatedThemes block", () => {
    const block = [
      '- "ai email" theme (5 ideas) — e.g. "AI Email Sorter" (...)',
      '- "habit tracker" theme (3 ideas) — e.g. ...',
    ].join("\n");
    expect(extractSaturatedPhrases(block)).toEqual(["ai email", "habit tracker"]);
  });

  it("returns [] for an empty / phrase-less block", () => {
    expect(extractSaturatedPhrases("")).toEqual([]);
    expect(extractSaturatedPhrases("no quoted phrases here")).toEqual([]);
  });
});

describe("noveltyScore", () => {
  it("is 1 when the sketch shares no token with any saturated phrase", () => {
    expect(noveltyScore("a calendar for dog groomers", ["ai email", "habit tracker"])).toBe(1);
  });

  it("is 1 when there are no saturated phrases (nothing to be saturated against)", () => {
    expect(noveltyScore("ai email assistant", [])).toBe(1);
  });

  it("drops below 1 when the sketch overlaps a saturated phrase", () => {
    const score = noveltyScore("an ai email triage copilot", ["ai email"]);
    expect(score).toBeLessThan(1);
    expect(score).toBeGreaterThanOrEqual(0);
  });

  it("is more saturated (lower) when overlapping multiple phrases", () => {
    const one = noveltyScore("ai email helper", ["ai email", "habit tracker"]);
    const two = noveltyScore("ai email habit tracker helper", ["ai email", "habit tracker"]);
    expect(two).toBeLessThan(one);
  });
});

describe("scoreSketch", () => {
  it("blends signal + novelty + market-gap with the documented weights", () => {
    const scored = scoreSketch(sketch(), {
      candidate: candidate(),
      saturatedPhrases: [],
      weights: DEFAULT_SHALLOW_WEIGHTS,
    });
    const w = DEFAULT_SHALLOW_WEIGHTS;
    const expected = w.signal * 0.6 + w.novelty * 1 + w.marketGap * 0.7;
    expect(scored.score).toBeCloseTo(expected, 6);
    expect(scored.components).toEqual({ signal: 0.6, novelty: 1, marketGap: 0.7 });
    expect(scored.candidate).toEqual(candidate());
    expect(scored.sketch).toEqual(sketch());
  });

  it("penalizes a saturated sketch via the novelty term", () => {
    const fresh = scoreSketch(sketch({ line: "a calendar for dog groomers" }), {
      candidate: candidate(),
      saturatedPhrases: ["ai email"],
      weights: DEFAULT_SHALLOW_WEIGHTS,
    });
    const stale = scoreSketch(sketch({ line: "an ai email triage tool" }), {
      candidate: candidate(),
      saturatedPhrases: ["ai email"],
      weights: DEFAULT_SHALLOW_WEIGHTS,
    });
    expect(stale.score).toBeLessThan(fresh.score);
  });

  it("clamps out-of-range signalStrength / marketGap into [0,1]", () => {
    const scored = scoreSketch(sketch({ marketGap: 5 }), {
      candidate: candidate({ signalStrength: -3 }),
      saturatedPhrases: [],
      weights: DEFAULT_SHALLOW_WEIGHTS,
    });
    expect(scored.components.signal).toBe(0);
    expect(scored.components.marketGap).toBe(1);
    expect(scored.score).toBeGreaterThanOrEqual(0);
    expect(scored.score).toBeLessThanOrEqual(1);
  });
});

describe("parseSketchBatch", () => {
  it("parses a fenced JSON array and binds each sketch to a candidate id", () => {
    const candidates = [candidate({ id: "c1" }), candidate({ id: "c2", title: "B" })];
    const text = [
      "```json",
      JSON.stringify([
        { candidateId: "c1", line: "first sketch line that is descriptive", marketGap: 0.4 },
        { candidateId: "c2", line: "second sketch line that is descriptive", marketGap: 0.9 },
      ]),
      "```",
    ].join("\n");
    const parsed = parseSketchBatch(text, candidates);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.candidateId).toBe("c1");
    expect(parsed[1]?.marketGap).toBe(0.9);
  });

  it("drops sketches whose candidateId is not in the batch (hallucinated ids)", () => {
    const candidates = [candidate({ id: "c1" })];
    const text = JSON.stringify([
      { candidateId: "c1", line: "valid descriptive sketch line", marketGap: 0.3 },
      { candidateId: "ghost", line: "hallucinated descriptive sketch line", marketGap: 0.8 },
    ]);
    const parsed = parseSketchBatch(text, candidates);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.candidateId).toBe("c1");
  });

  it("returns [] on malformed JSON instead of throwing", () => {
    expect(parseSketchBatch("not json at all", [candidate()])).toEqual([]);
  });

  it("skips entries missing required fields", () => {
    const candidates = [candidate({ id: "c1" })];
    const text = JSON.stringify([
      { candidateId: "c1" },
      { candidateId: "c1", line: "ok descriptive line", marketGap: 0.5 },
    ]);
    expect(parseSketchBatch(text, candidates)).toHaveLength(1);
  });
});

describe("rankScored", () => {
  it("sorts descending by composite score, stable on ties", () => {
    const mk = (id: string, score: number): ScoredSketch => ({
      candidate: candidate({ id }),
      sketch: sketch({ candidateId: id }),
      score,
      components: { signal: 0, novelty: 0, marketGap: 0 },
    });
    const ranked = rankScored([mk("a", 0.2), mk("b", 0.9), mk("c", 0.5)]);
    expect(ranked.map((r) => r.candidate.id)).toEqual(["b", "c", "a"]);
  });
});
