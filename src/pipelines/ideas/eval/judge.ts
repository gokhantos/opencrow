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

import { chat } from "../../../agent/chat";
import type { ConversationMessage } from "../../../agent/types";
import { createLogger } from "../../../logger";
import {
  AXIS_MAX,
  GIANT_AXES,
  GIANT_AXIS_KEYS,
  evaluateGiant,
  type Archetype,
  type GiantAxisKey,
  type GiantAxisScores,
  type WhyNow,
} from "../giant";
import type { CritiqueSubscores } from "./aggregate";

const log = createLogger("ideas:eval:judge");

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

const DEFAULT_JUDGE_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_IDEAS = 25;

const SYSTEM_PROMPT =
  "You are a rigorous, calibrated evaluator of product ideas using the GIANT rubric. You assign honest, well-separated scores and never inflate. Respond with ONLY valid JSON.";

// ── Prompt ─────────────────────────────────────────────────────────────────────

/** Render the GIANT axis anchors straight from the shared rubric table. */
function renderAxisAnchors(): string {
  return GIANT_AXIS_KEYS.map((key) => {
    const spec = GIANT_AXES[key];
    const tags = [
      spec.hardGate ? "HARD GATE (<=1 rejects)" : null,
      spec.evidenceGated ? "EVIDENCE-GATED (<=2 without a cited artifact)" : null,
    ]
      .filter((t): t is string => t !== null)
      .join(", ");
    const suffix = tags ? ` [${tags}]` : "";
    return `- ${key} (weight ${spec.weight}): ${spec.description}${suffix}`;
  }).join("\n");
}

function buildPrompt(ideas: readonly JudgeIdeaInput[]): string {
  const list = ideas
    .map(
      (idea, i) =>
        `${i + 1}. id: ${idea.id}\n   title: ${idea.title}\n   summary: ${idea.summary}`,
    )
    .join("\n\n");

  return `Score each product idea against the GIANT rubric. Every axis is 0..5 (0 = absent/worst, 5 = exceptional). Be non-compensatory: a near-zero axis must NOT be propped up by strong axes.

## GIANT axes (0..5)
${renderAxisAnchors()}

## Archetype (pick one)
- hair-on-fire: an acute, screaming-now pain.
- hard-fact: an inevitable shift makes this true regardless of taste.
- future-vision: a non-obvious bet on where the world is going.

## Ideas
${list}

Return ONLY valid JSON:
{
  "verdicts": [
    {
      "id": "<id>",
      "scores": {
        "acuteProblem": 0, "whyNow": 0, "demand": 0, "nonObviousness": 0,
        "defensibility": 0, "marketShape": 0, "founderFit": 0
      },
      "archetype": "hair-on-fire",
      "whyNow": [
        { "axis": "technological", "claim": "<dated enabling shift>", "date": "2025-01", "strength": 0.0 }
      ],
      "evidence": { "acuteProblem": "<one-line citation>", "demand": "<demand artifact or empty>" },
      "rationale": "one sentence"
    }
  ]
}`;
}

// ── JSON extraction (mirrors taste-filter for robustness) ──────────────────────

interface RawJudgeResponse {
  verdicts?: unknown;
}

function extractJson(text: string): RawJudgeResponse {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as RawJudgeResponse;
  } catch {
    // fall through
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim()) as RawJudgeResponse;
    } catch {
      // fall through
    }
  }
  const obj = trimmed.match(/\{[\s\S]*\}/);
  if (obj) {
    try {
      return JSON.parse(obj[0]) as RawJudgeResponse;
    } catch {
      // fall through
    }
  }
  throw new Error(`Unable to extract JSON from judge response. Preview: ${trimmed.slice(0, 200)}`);
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

// ── Entry point ────────────────────────────────────────────────────────────────

/**
 * Re-score ideas with an LLM judge against the GIANT rubric. Returns a map
 * id → JudgeVerdict.
 *
 * Gated: returns an empty map immediately when `opts.enabled` is not true.
 * Graceful: returns an empty map (never throws) on LLM/parse failure so the
 * surrounding eval run continues with persisted scores only.
 */
export async function judgeIdeas(
  ideas: readonly JudgeIdeaInput[],
  opts?: JudgeOptions,
): Promise<ReadonlyMap<string, JudgeVerdict>> {
  if (!opts?.enabled) return new Map();
  if (ideas.length === 0) return new Map();

  const model = opts.model ?? DEFAULT_JUDGE_MODEL;
  const provider = opts.provider ?? "anthropic";
  const capped = ideas.slice(0, opts.maxIdeas ?? DEFAULT_MAX_IDEAS);

  const messages: readonly ConversationMessage[] = [
    { role: "user", content: buildPrompt(capped), timestamp: Date.now() },
  ];

  try {
    const response = await chat(messages, {
      systemPrompt: SYSTEM_PROMPT,
      model,
      provider,
    });
    if (!response.text.trim()) {
      log.warn("LLM judge returned empty response");
      return new Map();
    }
    const raw = extractJson(response.text);
    const verdicts = parseJudgeVerdicts(raw, {
      hasDemandEvidence: opts.hasDemandEvidence === true,
    });
    const map = new Map<string, JudgeVerdict>();
    for (const v of verdicts) map.set(v.id, v);
    log.info("LLM judge complete", {
      requested: capped.length,
      scored: map.size,
      gated: verdicts.filter((v) => v.gated).length,
    });
    return map;
  } catch (err) {
    log.warn("LLM judge failed; returning empty verdict map", { err });
    return new Map();
  }
}
