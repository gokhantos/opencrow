/**
 * Regression tests: `runIdeasPipeline` is completely independent of
 * `smart.sigeAuto.enabled`. The "demotion guard" that previously skipped
 * synthesis when `sigeAuto.enabled=true` has been removed.
 *
 * These tests verify two things:
 *   1. STRUCTURAL: the pipeline source no longer references `sigeAuto` in any
 *      synthesis-skipping context (static assertion via source file inspection).
 *   2. BEHAVIORAL: the exported pure `synthesizeEnrichedSeed` function (which
 *      sits downstream of where the demotion guard used to be) works correctly
 *      and is not gated on a sigeAuto flag — confirming the synthesis path is
 *      always exercisable regardless of config state.
 *
 * Full end-to-end coverage of `runIdeasPipeline` with mocked dependencies is in
 * the pipeline integration test (`pipeline.integration.test.ts`). This file
 * focuses purely on the removed coupling invariant.
 *
 * Placed as `*.test.ts` (unit lane) since it imports only pure pipeline exports
 * and the Bun.file source read — no DB, no LLM, no network.
 */

import { describe, test, expect } from "bun:test";
import {
  synthesizeEnrichedSeed,
  enforceSegmentSpread,
  type SigeSignals,
  paretoSelect,
} from "./pipeline";
import type { GeneratedIdeaCandidate } from "./types";

// ── Helpers ───────────────────────────────────────────────────────────────────

function candidate(overrides: Partial<GeneratedIdeaCandidate> = {}): GeneratedIdeaCandidate {
  return {
    title: "Stub Idea",
    summary: "Stub summary",
    reasoning: "Stub reasoning",
    designDescription: "Design",
    monetizationDetail: "Monetization",
    sourceLinks: [],
    sourcesUsed: "stub",
    category: "productivity",
    qualityScore: 4,
    targetAudience: "Everyone",
    keyFeatures: ["feature"],
    revenueModel: "subscription",
    trendIntersection: "intersection",
    ...overrides,
  };
}

// ── STRUCTURAL: sigeAuto demotion guard is absent from pipeline.ts ────────────
//
// After the fix, `smart.sigeAuto` must not appear in `runIdeasPipeline`'s body
// (nor anywhere else in pipeline.ts — it was only in the removed block).
// This test reads the source file and asserts the demotion guard pattern is gone.
// Fail-fast if the guard ever comes back.

describe("pipeline.ts — sigeAuto demotion guard removed (structural)", () => {
  test("pipeline.ts does not contain a sigeAuto synthesis-skip block", async () => {
    const file = Bun.file(
      new URL("./pipeline.ts", import.meta.url).pathname,
    );
    const source = await file.text();

    // The demotion guard contained this exact log message — assert it's gone.
    expect(source).not.toContain(
      "Pipeline demoted to signal collector (smart.sigeAuto.enabled=true)",
    );

    // Assert the sigeAuto property is not accessed anywhere in pipeline.ts.
    // Previously it appeared only in the demotion guard; removing the guard
    // should remove all sigeAuto references from this file.
    expect(source).not.toContain("smart.sigeAuto");
    expect(source).not.toContain("sigeAuto.enabled");
  });

  test("pipeline.ts still exports runIdeasPipeline (synthesis path is not removed)", async () => {
    const file = Bun.file(
      new URL("./pipeline.ts", import.meta.url).pathname,
    );
    const source = await file.text();

    // The function must still exist and export the synthesis step.
    expect(source).toContain("export async function runIdeasPipeline(");
    expect(source).toContain("synthesizeFromTrends(");
    expect(source).toContain("markConsumed(");
  });
});

// ── BEHAVIORAL: synthesis helpers work independently of sigeAuto config ───────
//
// These pure functions (downstream of where the demotion guard used to sit)
// remain exercisable without any config flag gating. This proves the synthesis
// path is always open.

describe("synthesizeEnrichedSeed — synthesis helper is always reachable", () => {
  test("returns a non-empty seed from a non-empty candidate pool", () => {
    const seed = synthesizeEnrichedSeed([
      candidate({ title: "Task manager", summary: "Helps with tasks" }),
      candidate({ title: "Habit tracker", summary: "Tracks daily habits" }),
    ]);
    expect(seed.length).toBeGreaterThan(0);
    expect(seed).toContain("Task manager");
    expect(seed).toContain("Habit tracker");
  });

  test("returns a non-empty placeholder even for an empty pool", () => {
    // Proves the synthesis path never hard-errors, even in degenerate cases.
    const seed = synthesizeEnrichedSeed([]);
    expect(seed.length).toBeGreaterThan(0);
  });
});

describe("enforceSegmentSpread — post-synthesis selection helper is reachable", () => {
  test("returns candidates unchanged when pool size is at or below limit", () => {
    const pool = [candidate({ title: "A" }), candidate({ title: "B" })];
    const result = enforceSegmentSpread(pool, 5);
    expect(result).toHaveLength(2);
  });

  test("caps oversized pools at the given limit", () => {
    const pool = Array.from({ length: 10 }, (_, i) =>
      candidate({ title: `Idea ${i}`, segment: "consumer" }),
    );
    const result = enforceSegmentSpread(pool, 5);
    expect(result.length).toBeLessThanOrEqual(5);
  });
});

describe("paretoSelect — final ranking helper is reachable post-synthesis", () => {
  test("selects top-K candidates by quality when no SIGE signals are present", () => {
    const pool = [
      candidate({ title: "hi", qualityScore: 5, originality: 0.8 }),
      candidate({ title: "mid", qualityScore: 3, originality: 0.5 }),
      candidate({ title: "lo", qualityScore: 1, originality: 0.2 }),
    ];
    // No sigeAuto gating in paretoSelect — always runnable
    const result = paretoSelect(pool, new Map<string, SigeSignals>(), 2, 0.3);
    expect(result.length).toBeLessThanOrEqual(2);
    expect(result[0]!.title).toBe("hi");
  });
});
