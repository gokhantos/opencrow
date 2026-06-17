/**
 * LLM-as-judge re-scoring for the offline ideas eval harness.
 *
 * Optional / gated: judging makes an LLM call per batch and is therefore NEVER
 * part of the pipeline hot path. The harness only invokes this when explicitly
 * asked (opts.enabled === true). It degrades gracefully — any failure returns an
 * empty verdict map rather than throwing, so an eval run never breaks because
 * the judge model was unavailable.
 *
 * The judge re-scores already-generated ideas on the same axes the pipeline
 * cares about (novelty / feasibility / groundedness) on a 0–1 scale, so its
 * scores can be aggregated by the same {@link aggregateMeanSubscores}-style math
 * and compared against the persisted critique sub-scores to detect drift.
 */

import { chat } from "../../../agent/chat";
import type { ConversationMessage } from "../../../agent/types";
import { createLogger } from "../../../logger";
import type { CritiqueSubscores } from "./aggregate";

const log = createLogger("ideas:eval:judge");

// ── Public types ───────────────────────────────────────────────────────────────

/** The minimal idea shape the judge needs. */
export interface JudgeIdeaInput {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
}

/** One judge verdict, scores clamped to [0,1]. */
export interface JudgeVerdict {
  readonly id: string;
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
}

const DEFAULT_JUDGE_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_IDEAS = 25;

const SYSTEM_PROMPT =
  "You are a rigorous, calibrated evaluator of product ideas. You assign honest, well-separated scores. You never inflate. Respond with ONLY valid JSON.";

// ── Prompt ─────────────────────────────────────────────────────────────────────

function buildPrompt(ideas: readonly JudgeIdeaInput[]): string {
  const list = ideas
    .map(
      (idea, i) =>
        `${i + 1}. id: ${idea.id}\n   title: ${idea.title}\n   summary: ${idea.summary}`,
    )
    .join("\n\n");

  return `Score each product idea on three axes from 0.0 to 1.0.

## Axes
- novelty: genuinely new/non-obvious (0.9) vs generic/derivative (0.1)
- feasibility: shippable MVP with existing tech in weeks (0.9) vs needs heavy R&D/regulation (0.2)
- signal_grounding: clearly anchored in a real, observed need (0.9) vs speculative (0.1)

## Ideas
${list}

Return ONLY valid JSON:
{
  "verdicts": [
    { "id": "<id>", "novelty": 0.0, "feasibility": 0.0, "signal_grounding": 0.0, "rationale": "one sentence" }
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

function toScore(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }
  if (typeof value === "string") {
    const parsed = parseFloat(value);
    if (Number.isFinite(parsed)) return Math.max(0, Math.min(1, parsed));
  }
  return 0;
}

/**
 * Parse a raw verdict array into typed JudgeVerdicts keyed by id. PURE and
 * exported for unit testing the parser without an LLM call.
 */
export function parseJudgeVerdicts(raw: RawJudgeResponse): readonly JudgeVerdict[] {
  if (!Array.isArray(raw.verdicts)) return [];
  const out: JudgeVerdict[] = [];
  for (const entry of raw.verdicts as readonly unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const obj = entry as Record<string, unknown>;
    const id = typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : null;
    if (!id) continue;
    out.push({
      id,
      novelty: toScore(obj.novelty),
      feasibility: toScore(obj.feasibility),
      signalGrounding: toScore(obj.signal_grounding ?? obj.signalGrounding),
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
 * Re-score ideas with an LLM judge. Returns a map id → JudgeVerdict.
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
    const verdicts = parseJudgeVerdicts(raw);
    const map = new Map<string, JudgeVerdict>();
    for (const v of verdicts) map.set(v.id, v);
    log.info("LLM judge complete", { requested: capped.length, scored: map.size });
    return map;
  } catch (err) {
    log.warn("LLM judge failed; returning empty verdict map", { err });
    return new Map();
  }
}
