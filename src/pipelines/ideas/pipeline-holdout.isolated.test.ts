/**
 * Isolated test for the Phase-4 A/B holdout wiring that runIdeasPipeline performs.
 *
 * The pipeline's holdout decision is: (1) deterministically pick an arm from the
 * run id, (2) on BLIND skip the outcome-memory + graph reads and blank guidance,
 * (3) on GUIDED run the reads and capture the structured lessons, then record the
 * arm + lessons. That logic is extracted into the dependency-injected
 * {@link resolveHoldoutGuidance} (+ {@link assignHoldoutArm}) so it can be tested
 * here WITHOUT driving the whole orchestrator — driving runIdeasPipeline in the
 * shared isolated lane is unsafe because sibling route tests mock.module the
 * `pipelines/ideas/pipeline` module itself.
 *
 * Filed as *.isolated.test.ts per the lane convention for this seam; it imports
 * only ./holdout (no mock.module of shared modules), so it can neither leak into
 * nor be leaked into by other isolated files.
 */

import { test, expect, describe } from "bun:test";
import {
  assignHoldoutArm,
  resolveHoldoutGuidance,
  type ResolvedLesson,
} from "./holdout";

const reinforce: ResolvedLesson = { kind: "reinforce", text: "winning pattern", sourceIdeaId: "idea-1" };
const avoid: ResolvedLesson = { kind: "avoid", text: "losing pattern", sourceIdeaId: null };
const graphLesson: ResolvedLesson = { kind: "graph_path", text: "seed —REL→ node", sourceIdeaId: null };

function guidedFetchers() {
  let outcomeCalls = 0;
  let graphCalls = 0;
  return {
    counters: () => ({ outcomeCalls, graphCalls }),
    fetchOutcome: async () => {
      outcomeCalls += 1;
      return {
        block: "GUIDED-BLOCK",
        segmentDirective: "GUIDED-SEGMENT",
        lessons: { reinforce: [reinforce], avoid: [avoid] },
      };
    },
    fetchGraph: async () => {
      graphCalls += 1;
      return { directive: "GUIDED-GRAPH", graphLessons: [graphLesson] };
    },
  };
}

describe("runIdeasPipeline holdout wiring — resolveHoldoutGuidance", () => {
  test("BLIND arm (enabled + ratio=1) → reads SKIPPED, guidance blank, no lessons", async () => {
    // The pipeline computes the arm exactly this way.
    expect(assignHoldoutArm("run-blind-1", 1)).toBe("blind");

    const f = guidedFetchers();
    const { guidance, lessons } = await resolveHoldoutGuidance({
      blind: true,
      doOutcomeRead: true,
      doGraphRead: true,
      capture: false, // a blind run never captures
      fetchOutcome: f.fetchOutcome,
      fetchGraph: f.fetchGraph,
    });

    // Both reads were skipped (blind short-circuits).
    expect(f.counters()).toEqual({ outcomeCalls: 0, graphCalls: 0 });
    // Synthesizer would receive EMPTY guidance on all three surfaces.
    expect(guidance).toEqual({ block: "", segmentDirective: "", graphDirective: "" });
    // A blind run injects no lessons (so the pipeline never calls recordInjectedLessons).
    expect(lessons).toEqual([]);
  });

  test("GUIDED + capture → reads run, guidance forwarded, lessons captured", async () => {
    expect(assignHoldoutArm("run-guided-1", 0)).toBe("guided"); // ratio 0 → always guided

    const f = guidedFetchers();
    const { guidance, lessons } = await resolveHoldoutGuidance({
      blind: false,
      doOutcomeRead: true,
      doGraphRead: true,
      capture: true,
      fetchOutcome: f.fetchOutcome,
      fetchGraph: f.fetchGraph,
    });

    expect(f.counters()).toEqual({ outcomeCalls: 1, graphCalls: 1 });
    expect(guidance).toEqual({
      block: "GUIDED-BLOCK",
      segmentDirective: "GUIDED-SEGMENT",
      graphDirective: "GUIDED-GRAPH",
    });
    // The structured reinforce/avoid + graph-path lessons are captured for the
    // lift attribution → recordInjectedLessons receives exactly these.
    expect(lessons).toEqual([reinforce, avoid, graphLesson]);
  });

  test("GUIDED but NOT capturing (abHoldout disabled) → guidance forwarded, no lessons", async () => {
    const f = guidedFetchers();
    const { guidance, lessons } = await resolveHoldoutGuidance({
      blind: false,
      doOutcomeRead: true,
      doGraphRead: true,
      capture: false,
      fetchOutcome: f.fetchOutcome,
      fetchGraph: f.fetchGraph,
    });

    // Reads still run (legacy guidance path) and reach the synthesizer unchanged.
    expect(f.counters()).toEqual({ outcomeCalls: 1, graphCalls: 1 });
    expect(guidance.block).toBe("GUIDED-BLOCK");
    expect(guidance.graphDirective).toBe("GUIDED-GRAPH");
    // But NO lessons are recorded when not in a holdout capture.
    expect(lessons).toEqual([]);
  });

  test("reads gated OFF → blank surface even when guided", async () => {
    const f = guidedFetchers();
    const { guidance, lessons } = await resolveHoldoutGuidance({
      blind: false,
      doOutcomeRead: false, // e.g. readAtSynthesis off / no mem0 client
      doGraphRead: false, // e.g. graphReasoning off / no neo4j client
      capture: true,
      fetchOutcome: f.fetchOutcome,
      fetchGraph: f.fetchGraph,
    });

    expect(f.counters()).toEqual({ outcomeCalls: 0, graphCalls: 0 });
    expect(guidance).toEqual({ block: "", segmentDirective: "", graphDirective: "" });
    expect(lessons).toEqual([]);
  });
});
