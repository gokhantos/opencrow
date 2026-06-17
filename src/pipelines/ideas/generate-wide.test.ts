import { test, expect, describe } from "bun:test";
import {
  parseVerbalizedProb,
  parseVerbalizedSeeds,
  planSegmentDirectives,
  renderSegmentSpread,
  noveltyScore,
  selectWithNoveltyReserve,
} from "./generate-wide";
import type { GeneratedIdeaCandidate } from "./types";
import { SEGMENT_IDS } from "./segments";

// ── Test helpers ───────────────────────────────────────────────────────────

function candidate(
  overrides: Partial<GeneratedIdeaCandidate> & { title: string },
): GeneratedIdeaCandidate {
  return {
    summary: overrides.summary ?? "",
    reasoning: "",
    designDescription: "",
    monetizationDetail: "",
    sourceLinks: [],
    sourcesUsed: "",
    category: "ai_app",
    qualityScore: overrides.qualityScore ?? 0,
    targetAudience: "",
    keyFeatures: [],
    revenueModel: "",
    trendIntersection: "",
    ...overrides,
  };
}

// ── parseVerbalizedProb ──────────────────────────────────────────────────────

describe("parseVerbalizedProb", () => {
  test("passes through a clean [0,1] number", () => {
    expect(parseVerbalizedProb(0.3)).toBe(0.3);
    expect(parseVerbalizedProb(0)).toBe(0);
    expect(parseVerbalizedProb(1)).toBe(1);
  });

  test("treats a number in (1,100] as a percentage point", () => {
    expect(parseVerbalizedProb(30)).toBeCloseTo(0.3, 10);
    expect(parseVerbalizedProb(100)).toBe(1);
  });

  test("parses a percent string", () => {
    expect(parseVerbalizedProb("30%")).toBeCloseTo(0.3, 10);
    expect(parseVerbalizedProb("  7.5% ")).toBeCloseTo(0.075, 10);
  });

  test("parses a plain numeric string", () => {
    expect(parseVerbalizedProb("0.42")).toBeCloseTo(0.42, 10);
    expect(parseVerbalizedProb("25")).toBeCloseTo(0.25, 10);
  });

  test("clamps out-of-range and falls back on garbage", () => {
    expect(parseVerbalizedProb(-3)).toBe(0);
    expect(parseVerbalizedProb(Number.NaN)).toBe(0);
    expect(parseVerbalizedProb("not a number")).toBe(0);
    expect(parseVerbalizedProb(undefined, 0.5)).toBe(0.5);
    expect(parseVerbalizedProb(null)).toBe(0);
  });
});

// ── parseVerbalizedSeeds ─────────────────────────────────────────────────────

describe("parseVerbalizedSeeds", () => {
  test("parses {idea, probability} pairs", () => {
    const seeds = parseVerbalizedSeeds([
      { probability: 0.4, idea: { title: "A" } },
      { probability: "20%", idea: { title: "B" } },
    ]);
    expect(seeds).toHaveLength(2);
    expect(seeds[0]?.idea.title).toBe("A");
    expect(seeds[0]?.probability).toBeCloseTo(0.4, 10);
    expect(seeds[1]?.probability).toBeCloseTo(0.2, 10);
  });

  test("accepts {candidate, prob} alias keys", () => {
    const seeds = parseVerbalizedSeeds([
      { prob: 0.9, candidate: { title: "C" } },
    ]);
    expect(seeds[0]?.idea.title).toBe("C");
    expect(seeds[0]?.probability).toBeCloseTo(0.9, 10);
  });

  test("accepts a bare idea object (no probability wrapper)", () => {
    const seeds = parseVerbalizedSeeds([{ title: "Bare", summary: "x" }]);
    expect(seeds).toHaveLength(1);
    expect(seeds[0]?.idea.title).toBe("Bare");
    expect(seeds[0]?.probability).toBe(0);
  });

  test("skips non-objects and bare rows without a title", () => {
    const seeds = parseVerbalizedSeeds([
      null,
      42,
      "str",
      { probability: 0.5 }, // bare row, no title -> noise
      { idea: { title: "Keep" }, probability: 0.1 },
    ]);
    expect(seeds).toHaveLength(1);
    expect(seeds[0]?.idea.title).toBe("Keep");
  });

  test("returns [] for non-array input and never throws", () => {
    expect(parseVerbalizedSeeds(null)).toEqual([]);
    expect(parseVerbalizedSeeds({})).toEqual([]);
    expect(parseVerbalizedSeeds(undefined)).toEqual([]);
  });

  test("applies the limit after parsing in order", () => {
    const seeds = parseVerbalizedSeeds(
      [
        { idea: { title: "1" } },
        { idea: { title: "2" } },
        { idea: { title: "3" } },
      ],
      2,
    );
    expect(seeds.map((s) => s.idea.title)).toEqual(["1", "2"]);
  });
});

// ── planSegmentDirectives / renderSegmentSpread ──────────────────────────────

describe("planSegmentDirectives", () => {
  test("counts sum to the target and drop zero-count segments", () => {
    const directives = planSegmentDirectives(9);
    expect(directives).toHaveLength(SEGMENT_IDS.length);
    expect(directives.reduce((s, d) => s + d.count, 0)).toBe(9);
    expect(directives.every((d) => d.count > 0)).toBe(true);
  });

  test("front-loads leftover and omits zero-count segments for small targets", () => {
    const directives = planSegmentDirectives(2);
    // Only 2 of 9 segments get a seed; the rest are dropped.
    expect(directives).toHaveLength(2);
    expect(directives.reduce((s, d) => s + d.count, 0)).toBe(2);
    // Front-loaded in taxonomy order.
    expect(directives[0]?.segmentId).toBe("consumer");
    expect(directives[1]?.segmentId).toBe("b2b_saas");
  });

  test("carries the segment descriptor fields", () => {
    const [first] = planSegmentDirectives(9);
    expect(first?.label).toBeDefined();
    expect(first?.buyer).toBeDefined();
    expect(first?.description).toBeDefined();
  });

  test("honors a segment subset", () => {
    const directives = planSegmentDirectives(4, ["fintech", "healthcare"]);
    expect(directives.map((d) => d.segmentId).sort()).toEqual([
      "fintech",
      "healthcare",
    ]);
    expect(directives.reduce((s, d) => s + d.count, 0)).toBe(4);
  });
});

describe("renderSegmentSpread", () => {
  test("returns empty string for an empty plan", () => {
    expect(renderSegmentSpread([])).toBe("");
  });

  test("renders each directive with its segment id + count", () => {
    const block = renderSegmentSpread(planSegmentDirectives(9));
    expect(block).toContain("SEGMENT SPREAD");
    expect(block).toContain("[consumer]");
    expect(block).toContain("[ai_native]");
  });
});

// ── noveltyScore ─────────────────────────────────────────────────────────────

describe("noveltyScore", () => {
  test("prefers originality when present (clamped)", () => {
    expect(noveltyScore(candidate({ title: "x", originality: 0.8 }))).toBe(0.8);
    expect(noveltyScore(candidate({ title: "x", originality: 2 }))).toBe(1);
  });

  test("falls back to inverted verbalized probability", () => {
    // Low self-reported prob -> rarer -> more surprising.
    expect(
      noveltyScore(candidate({ title: "x", verbalizedProb: 0.1 })),
    ).toBeCloseTo(0.9, 10);
  });

  test("originality wins over verbalizedProb when both present", () => {
    expect(
      noveltyScore(
        candidate({ title: "x", originality: 0.2, verbalizedProb: 0.1 }),
      ),
    ).toBe(0.2);
  });

  test("neutral 0 when neither signal is present", () => {
    expect(noveltyScore(candidate({ title: "x" }))).toBe(0);
  });
});

// ── selectWithNoveltyReserve ─────────────────────────────────────────────────

describe("selectWithNoveltyReserve", () => {
  test("returns all candidates when limit >= pool size", () => {
    const pool = [candidate({ title: "a" }), candidate({ title: "b" })];
    expect(selectWithNoveltyReserve(pool, 5)).toHaveLength(2);
  });

  test("returns [] for a non-positive limit", () => {
    expect(selectWithNoveltyReserve([candidate({ title: "a" })], 0)).toEqual([]);
  });

  test("reserves a slot for a high-novelty low-quality candidate", () => {
    // Four high-quality lookalikes + one surprising low-quality idea.
    const pool = [
      candidate({ title: "q1", qualityScore: 5, originality: 0.1 }),
      candidate({ title: "q2", qualityScore: 4.8, originality: 0.1 }),
      candidate({ title: "q3", qualityScore: 4.6, originality: 0.1 }),
      candidate({ title: "q4", qualityScore: 4.4, originality: 0.1 }),
      candidate({ title: "surprise", qualityScore: 1, originality: 0.99 }),
    ];
    // limit 4, reserveFraction 0.25 -> 1 reserved slot.
    const picked = selectWithNoveltyReserve(pool, 4);
    expect(picked).toHaveLength(4);
    expect(picked.map((c) => c.title)).toContain("surprise");
    // The lowest-quality lookalike (q4) is displaced by the reserve.
    expect(picked.map((c) => c.title)).not.toContain("q4");
  });

  test("degrades to a pure quality slice when reserve rounds to 0", () => {
    const pool = [
      candidate({ title: "q1", qualityScore: 5, originality: 0.1 }),
      candidate({ title: "q2", qualityScore: 4, originality: 0.1 }),
      candidate({ title: "surprise", qualityScore: 1, originality: 0.99 }),
    ];
    // limit 2, floor(2 * 0.25) = 0 reserved slots -> pure quality top-2.
    const picked = selectWithNoveltyReserve(pool, 2);
    expect(picked.map((c) => c.title)).toEqual(["q1", "q2"]);
  });

  test("is deterministic / stable on ties", () => {
    const pool = [
      candidate({ title: "a", qualityScore: 3 }),
      candidate({ title: "b", qualityScore: 3 }),
      candidate({ title: "c", qualityScore: 3 }),
      candidate({ title: "d", qualityScore: 3 }),
      candidate({ title: "e", qualityScore: 3 }),
    ];
    const first = selectWithNoveltyReserve(pool, 3).map((c) => c.title);
    const second = selectWithNoveltyReserve(pool, 3).map((c) => c.title);
    expect(first).toEqual(second);
  });

  test("respects an explicit reserveFraction", () => {
    const pool = [
      candidate({ title: "q1", qualityScore: 5, originality: 0 }),
      candidate({ title: "q2", qualityScore: 4.5, originality: 0 }),
      candidate({ title: "q3", qualityScore: 4, originality: 0 }),
      candidate({ title: "n1", qualityScore: 1, originality: 0.99 }),
      candidate({ title: "n2", qualityScore: 0.5, originality: 0.95 }),
    ];
    // limit 4, reserveFraction 0.5 -> 2 reserved slots.
    const picked = selectWithNoveltyReserve(pool, 4, { reserveFraction: 0.5 });
    expect(picked.map((c) => c.title)).toContain("n1");
    expect(picked.map((c) => c.title)).toContain("n2");
  });
});
