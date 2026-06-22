/**
 * holdout.ts — deterministic per-RUN A/B holdout for the idea-funnel learning
 * loop (Phase 4 observability).
 *
 * The learning signal (outcome-memory REINFORCE/AVOID + graph OPPORTUNITY-PATHS)
 * is injected ONCE per run at synthesis, so the holdout split is per-RUN, not
 * per-idea. A configurable fraction of runs are assigned the "blind" arm: they
 * SKIP the memory/graph reads entirely (guidance blanked to ""), generating as if
 * the learning loop did not exist. Comparing guided vs blind validated/kept rates
 * is the honest lift measurement.
 *
 * PURE — no RNG, no clock. The arm is derived deterministically from the run id
 * via the SAME {@link rotationSeedFromRunId} hash the taste-loop rotation uses, so
 * a run's arm is stable across retries/resumes and reproducible in tests.
 *
 * Default behavior is neutral: ratio <= 0 → always "guided" (byte-identical to the
 * pre-feature pipeline); ratio >= 1 → always "blind".
 */

import { rotationSeedFromRunId } from "./pipeline-stamps";

/** Which arm a run was assigned to. */
export type HoldoutArm = "guided" | "blind";

/**
 * Deterministically assign a run to the "guided" or "blind" arm from its run id.
 *
 * The run-id-derived seed (same hash as the taste-loop rotation) is reduced to a
 * bucket in [0, 100); the run is "blind" when that bucket falls under the rounded
 * holdout ratio. So a holdoutRatio of 0.3 sends ~30% of runs blind, deterministically.
 *
 * Edge cases (so callers never have to special-case): ratio <= 0 → always "guided"
 * (no holdout); ratio >= 1 → always "blind". PURE.
 */
export function assignHoldoutArm(runId: string, ratio: number): HoldoutArm {
  if (!(ratio > 0)) return "guided";
  if (ratio >= 1) return "blind";
  const seed = rotationSeedFromRunId(runId);
  const bucket = seed % 100;
  const threshold = Math.round(ratio * 100);
  return bucket < threshold ? "blind" : "guided";
}

/** The synthesis-guidance surfaces an arm can blank. Mirrors the shapes the
 *  pipeline already threads into the synthesizer: the outcome-memory guidance
 *  ({ block, segmentDirective }) and the graph-reasoning directive (string). */
export interface HoldoutGuidance {
  /** Pass-2 REINFORCE/AVOID block. */
  readonly block: string;
  /** Pass-1 SEED segment-diversity directive. */
  readonly segmentDirective: string;
  /** Pass-1 OPPORTUNITY-PATHS graph directive. */
  readonly graphDirective: string;
}

/**
 * Blank ALL learned guidance for the blind arm, returning the exact ""-degraded
 * shape the synthesizer already handles when the feature is OFF — so a blind run
 * is byte-identical to the pre-feature path with zero synthesizer change. PURE.
 */
export function blankGuidanceForBlindArm(): HoldoutGuidance {
  return { block: "", segmentDirective: "", graphDirective: "" };
}

/**
 * One captured lesson injected into a GUIDED run, for lift attribution. Kept
 * structurally minimal here (kind + text + optional source idea) so this seam has
 * no dependency on the lift-attribution store types. Mirrors that module's
 * InjectedLesson shape.
 */
export interface ResolvedLesson {
  readonly kind: "reinforce" | "avoid" | "graph_path";
  readonly text: string;
  readonly sourceIdeaId: string | null;
}

/**
 * Resolve the synthesis guidance for a run given its holdout arm, plus the
 * structured lessons to record. This is the dependency-injected core of the
 * pipeline's holdout wiring, extracted so it can be tested WITHOUT driving the
 * whole orchestrator (and without mock.module-ing shared modules in the isolated
 * lane).
 *
 * - BLIND arm (or reads disabled): SKIP both reads entirely and return blank
 *   guidance ("" on all three surfaces) with no lessons — byte-identical to the
 *   pre-feature path.
 * - GUIDED arm: run the injected reads, return their guidance, and (when
 *   `capture` is true) collect the structured reinforce/avoid + graph-path lessons.
 *
 * The fetchers are injected so the real ones (mem0 / Neo4j) are only wired in by
 * the pipeline; never throws here (the injected fetchers are the best-effort ones).
 */
export async function resolveHoldoutGuidance(params: {
  readonly blind: boolean;
  readonly doOutcomeRead: boolean;
  readonly doGraphRead: boolean;
  readonly capture: boolean;
  readonly fetchOutcome: () => Promise<{
    readonly block: string;
    readonly segmentDirective: string;
    readonly lessons?: {
      readonly reinforce: readonly ResolvedLesson[];
      readonly avoid: readonly ResolvedLesson[];
    };
  }>;
  readonly fetchGraph: () => Promise<{
    readonly directive: string;
    readonly graphLessons: readonly ResolvedLesson[];
  }>;
}): Promise<{
  readonly guidance: HoldoutGuidance;
  readonly lessons: readonly ResolvedLesson[];
}> {
  if (params.blind) {
    return { guidance: blankGuidanceForBlindArm(), lessons: [] };
  }

  const lessons: ResolvedLesson[] = [];

  const outcome = params.doOutcomeRead
    ? await params.fetchOutcome()
    : { block: "", segmentDirective: "" as string };
  if (params.capture && "lessons" in outcome && outcome.lessons !== undefined) {
    lessons.push(...outcome.lessons.reinforce, ...outcome.lessons.avoid);
  }

  const graph = params.doGraphRead
    ? await params.fetchGraph()
    : { directive: "", graphLessons: [] as readonly ResolvedLesson[] };
  if (params.capture && graph.graphLessons.length > 0) {
    lessons.push(...graph.graphLessons);
  }

  return {
    guidance: {
      block: outcome.block,
      segmentDirective: outcome.segmentDirective,
      graphDirective: graph.directive,
    },
    lessons,
  };
}
