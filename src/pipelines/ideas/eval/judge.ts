/**
 * LLM-as-judge re-scoring for the offline ideas eval harness.
 *
 * Optional / gated: judging makes an LLM call per batch and is therefore NEVER
 * part of the pipeline hot path. The harness only invokes this when explicitly
 * asked (opts.enabled === true). It degrades gracefully — any failure returns an
 * empty verdict map rather than throwing, so an eval run never breaks because
 * the judge model was unavailable.
 *
 * The judge re-scores already-generated ideas against the SHARED GIANT rubric
 * (see ../giant.ts): the full 7-axis vector (0..5) + a Sequoia archetype + the
 * dated why-now shifts + per-axis evidence. The legacy
 * novelty/feasibility/signalGrounding [0,1] sub-scores are derived from the
 * GIANT vector so existing aggregation/drift math keeps working unchanged.
 */

import {
  AXIS_MAX,
  evaluateGiant,
  type Archetype,
  type GiantAxisKey,
  type GiantAxisScores,
  type WhyNow,
} from "../giant";
import type { CritiqueSubscores } from "./aggregate";

// ── Public types ───────────────────────────────────────────────────────────────

/** The minimal idea shape the judge needs. */
export interface JudgeIdeaInput {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
}

/**
 * One judge verdict scored against the GIANT rubric.
 *
 * `giantScores` is the full 7-axis vector (each 0..5); `composite`/`gated`/
 * `gateReasons` are the non-compensatory aggregate (see ../giant.ts). The legacy
 * `novelty`/`feasibility`/`signalGrounding` fields are derived [0,1] projections
 * of the GIANT axes so the existing drift aggregation keeps working.
 */
export interface JudgeVerdict {
  readonly id: string;
  // ── GIANT (primary) ──────────────────────────────────────────────────────
  readonly giantScores: GiantAxisScores;
  readonly archetype: Archetype;
  readonly whyNow: WhyNow;
  readonly evidence: Readonly<Record<GiantAxisKey, string>>;
  readonly composite: number;
  readonly gated: boolean;
  readonly gateReasons: readonly string[];
  // ── Legacy [0,1] projections (backward-compatible) ───────────────────────
  readonly novelty: number;
  readonly feasibility: number;
  readonly signalGrounding: number;
  readonly rationale: string;
}

export interface JudgeOptions {
  /** Master switch — judging only runs when true. Default false. */
  readonly enabled?: boolean;
  readonly model?: string;
  readonly provider?: "openrouter" | "agent-sdk" | "alibaba" | "anthropic";
  /** Cap the number of ideas sent to the judge in one call. Default 25. */
  readonly maxIdeas?: number;
  /**
   * Whether a cited demand artifact exists for the judged batch. Forwarded to
   * the GIANT demand evidence-gate. Defaults to false (un-evidenced demand is
   * capped); callers with a real demand-artifact check pass true.
   */
  readonly hasDemandEvidence?: boolean;
}

interface RawJudgeResponse {
  verdicts?: unknown;
}

/**
 * Project a GIANT axis score in [0,5] down to the legacy [0,1] range so the
 * existing critique-drift aggregation keeps working unchanged. PURE.
 */
function axisToUnit(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(1, score / AXIS_MAX));
}

/** Map the GIANT axis vector onto the three legacy [0,1] sub-scores. PURE. */
export function giantScoresToLegacy(scores: GiantAxisScores): CritiqueSubscores {
  return {
    novelty: axisToUnit(scores.nonObviousness),
    feasibility: axisToUnit(scores.founderFit),
    signalGrounding: axisToUnit(scores.acuteProblem),
  };
}

/**
 * Parse a raw verdict array into typed JudgeVerdicts keyed by id. PURE and
 * exported for unit testing the parser without an LLM call.
 *
 * Each verdict is run through the shared, tolerant {@link evaluateGiant} parse +
 * non-compensatory aggregation, so malformed/partial axis vectors degrade to
 * safe defaults rather than throwing. `opts.hasDemandEvidence` is forwarded to
 * the GIANT demand evidence-gate (default false → un-evidenced demand capped).
 */
export function parseJudgeVerdicts(
  raw: RawJudgeResponse,
  opts?: { readonly hasDemandEvidence?: boolean },
): readonly JudgeVerdict[] {
  if (!Array.isArray(raw.verdicts)) return [];
  const out: JudgeVerdict[] = [];
  for (const entry of raw.verdicts as readonly unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const obj = entry as Record<string, unknown>;
    const id = typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : null;
    if (!id) continue;

    const giant = evaluateGiant(obj, {
      hasDemandEvidence: opts?.hasDemandEvidence === true,
    });
    const legacy = giantScoresToLegacy(giant.scores);

    out.push({
      id,
      giantScores: giant.scores,
      archetype: giant.archetype,
      whyNow: giant.whyNow,
      evidence: giant.evidence,
      composite: giant.composite,
      gated: giant.gated,
      gateReasons: giant.gateReasons,
      novelty: legacy.novelty ?? 0,
      feasibility: legacy.feasibility ?? 0,
      signalGrounding: legacy.signalGrounding ?? 0,
      rationale: typeof obj.rationale === "string" ? obj.rationale : "",
    });
  }
  return out;
}

/** Convert a verdict into the CritiqueSubscores shape used by the aggregator. */
export function verdictToSubscores(verdict: JudgeVerdict): CritiqueSubscores {
  return {
    novelty: verdict.novelty,
    feasibility: verdict.feasibility,
    signalGrounding: verdict.signalGrounding,
  };
}

