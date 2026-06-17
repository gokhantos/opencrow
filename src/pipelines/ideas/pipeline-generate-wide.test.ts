import { test, expect, describe } from "bun:test";
import {
  enforceSegmentSpread,
  summarizeSegmentSpread,
  mapDivergentToCandidate,
  buildSignalsContext,
} from "./pipeline";
import { SEGMENT_IDS, type SegmentId } from "./segments";
import type { GeneratedIdeaCandidate } from "./types";
import type { DivergentCandidate } from "../../sige/run";

// ── PHASE 1 "generate-wide" pipeline helpers ────────────────────────────────
//
// Pure tests for the pipeline-boundary widening logic: segment-spread
// enforcement on the final set, segment-spread instrumentation, the SIGE
// divergent → candidate mapping, and the grounded signals-context assembly. No
// DB / network — all deterministic pure functions.

function candidate(
  overrides: Partial<GeneratedIdeaCandidate> = {},
): GeneratedIdeaCandidate {
  return {
    title: "Test idea",
    summary: "summary",
    reasoning: "reasoning",
    designDescription: "design",
    monetizationDetail: "monetization",
    sourceLinks: [],
    sourcesUsed: "sources",
    category: "productivity",
    qualityScore: 3,
    targetAudience: "audience",
    keyFeatures: ["a", "b"],
    revenueModel: "subscription",
    trendIntersection: "intersection",
    ...overrides,
  };
}

/** Build N candidates all tagged into one segment (forces the worst case). */
function segmentRun(
  segment: SegmentId,
  n: number,
  startScore = 5,
): GeneratedIdeaCandidate[] {
  return Array.from({ length: n }, (_, i) =>
    candidate({
      title: `${segment}-${i}`,
      segment,
      qualityScore: startScore - i * 0.01,
    }),
  );
}

describe("enforceSegmentSpread", () => {
  test("returns the input unchanged when pool <= limit", () => {
    const pool = segmentRun("consumer", 3);
    const out = enforceSegmentSpread(pool, 5);
    expect(out).toHaveLength(3);
    expect(out).toEqual(pool);
  });

  test("returns [] for a non-positive limit", () => {
    expect(enforceSegmentSpread(segmentRun("consumer", 4), 0)).toEqual([]);
    expect(enforceSegmentSpread(segmentRun("consumer", 4), -2)).toEqual([]);
  });

  test("caps a single dominant segment at ceil(limit * maxFraction)", () => {
    // 10 all-consumer candidates, limit 8, fraction 0.5 → cap = 4 consumer.
    // Remaining 4 slots back-fill with deferred consumer (no other segments).
    const pool = segmentRun("consumer", 10);
    const out = enforceSegmentSpread(pool, 8, 0.5);
    expect(out).toHaveLength(8);
  });

  test("admits diverse segments ahead of an over-capped one", () => {
    // 6 consumer + 2 fintech + 2 devtools, limit 6, fraction 0.5 → consumer cap 3.
    const pool = [
      ...segmentRun("consumer", 6, 5),
      ...segmentRun("fintech", 2, 4),
      ...segmentRun("devtools", 2, 4),
    ];
    const out = enforceSegmentSpread(pool, 6, 0.5);
    expect(out).toHaveLength(6);
    const segments = out.map((c) => c.segment);
    const consumerCount = segments.filter((s) => s === "consumer").length;
    // Consumer must be capped at 3; fintech + devtools must appear.
    expect(consumerCount).toBeLessThanOrEqual(3);
    expect(segments).toContain("fintech");
    expect(segments).toContain("devtools");
  });

  test("never returns fewer than the limit when the pool is large enough", () => {
    // Tight cap but enough deferred to back-fill: output must hit the limit.
    const pool = segmentRun("b2b_saas", 12);
    const out = enforceSegmentSpread(pool, 7, 0.34);
    expect(out).toHaveLength(7);
  });

  test("preserves incoming (quality) order within the admitted set", () => {
    const pool = [
      ...segmentRun("consumer", 2, 5),
      ...segmentRun("fintech", 2, 4),
    ];
    const out = enforceSegmentSpread(pool, 3, 0.5);
    // First admitted is the top consumer (highest quality, first in input).
    expect(out[0]!.title).toBe("consumer-0");
  });

  test("falls back to identity-preserving refs (no cloning)", () => {
    const pool = segmentRun("consumer", 10);
    const out = enforceSegmentSpread(pool, 6);
    for (const c of out) {
      expect(pool).toContain(c);
    }
  });

  test("clamps maxFraction below 1/|segments| up to the floor", () => {
    // fraction 0 clamps to 1/9 → cap = ceil(9 * 1/9) = 1 per segment.
    const pool = [
      ...segmentRun("consumer", 5, 5),
      ...segmentRun("fintech", 5, 4),
    ];
    const out = enforceSegmentSpread(pool, 9, 0);
    expect(out).toHaveLength(9); // back-fills past the cap to fill slots
  });
});

describe("summarizeSegmentSpread", () => {
  test("zero-fills all segment ids and reports the dominant share", () => {
    const pool = [
      ...segmentRun("consumer", 3),
      ...segmentRun("fintech", 1),
    ];
    const stats = summarizeSegmentSpread(pool);
    expect(stats.total).toBe(4);
    expect(stats.counts.consumer).toBe(3);
    expect(stats.counts.fintech).toBe(1);
    // Every taxonomy id present (zero-filled).
    for (const id of SEGMENT_IDS) {
      expect(typeof stats.counts[id]).toBe("number");
    }
    expect(stats.dominantSegment).toBe("consumer");
    expect(stats.dominantShare).toBeCloseTo(0.75, 5);
  });

  test("empty pool → zero totals and a neutral dominant share", () => {
    const stats = summarizeSegmentSpread([]);
    expect(stats.total).toBe(0);
    expect(stats.dominantShare).toBe(0);
  });

  test("counts explicit tags AND real keyword inferences as signalled", () => {
    const pool = [
      candidate({ segment: "fintech", title: "tagged" }),
      candidate({ title: "Crypto wallet payments", category: "fintech" }),
      candidate({ title: "Generic thing", category: "", summary: "" }),
    ];
    const stats = summarizeSegmentSpread(pool);
    // Two carry a real signal (one explicit, one keyword); one is a fallback.
    expect(stats.signalled).toBe(2);
  });

  test("untagged candidates fall back to inferred segment counts", () => {
    const pool = [
      candidate({ title: "AI agent copilot", category: "ai", summary: "llm" }),
    ];
    const stats = summarizeSegmentSpread(pool);
    expect(stats.counts.ai_native).toBe(1);
  });
});

describe("mapDivergentToCandidate", () => {
  const base: DivergentCandidate = {
    title: "Divergent idea",
    summary: "a wild but grounded idea",
    proposedBy: "contrarian:session-123",
  };

  test("marks the candidate unscored (qualityScore 0, empty category)", () => {
    const c = mapDivergentToCandidate(base);
    expect(c.qualityScore).toBe(0);
    expect(c.category).toBe("");
  });

  test("tags provenance into sourcesUsed", () => {
    const c = mapDivergentToCandidate(base);
    expect(c.sourcesUsed).toContain("sige-divergent");
    expect(c.sourcesUsed).toContain("contrarian:session-123");
  });

  test("carries supportingSignalIds through when present", () => {
    const c = mapDivergentToCandidate({
      ...base,
      supportingSignalIds: ["hn_12", "producthunt_3"],
    });
    expect(c.supportingSignalIds).toEqual(["hn_12", "producthunt_3"]);
  });

  test("omits supportingSignalIds when absent (optional field undefined)", () => {
    const c = mapDivergentToCandidate(base);
    expect(c.supportingSignalIds).toBeUndefined();
  });

  test("preserves title and summary verbatim", () => {
    const c = mapDivergentToCandidate(base);
    expect(c.title).toBe("Divergent idea");
    expect(c.summary).toBe("a wild but grounded idea");
  });
});

describe("buildSignalsContext", () => {
  test("joins only the non-empty sections with headers", () => {
    const ctx = buildSignalsContext({
      trendsSummary: "trend lines",
      painsSummary: "",
      capabilitiesSummary: "new capability",
      deepSearchContext: "   ",
    });
    expect(ctx).toContain("=== TRENDS ===");
    expect(ctx).toContain("trend lines");
    expect(ctx).toContain("=== CAPABILITIES ===");
    expect(ctx).toContain("new capability");
    // Empty / whitespace-only sections are dropped.
    expect(ctx).not.toContain("PAIN POINTS");
    expect(ctx).not.toContain("DEEP-SEARCH EVIDENCE");
  });

  test("returns an empty string when all sections are empty", () => {
    expect(
      buildSignalsContext({
        trendsSummary: "",
        painsSummary: "",
        capabilitiesSummary: "",
        deepSearchContext: "",
      }),
    ).toBe("");
  });

  test("bounds each section to keep the prompt size sane", () => {
    const huge = "x".repeat(50_000);
    const ctx = buildSignalsContext({
      trendsSummary: huge,
      painsSummary: "",
      capabilitiesSummary: "",
      deepSearchContext: "",
    });
    // Header + at most 8000 chars of body (well under the raw 50k input).
    expect(ctx.length).toBeLessThan(9000);
  });
});
