/**
 * SIGE competability gate (PR #208 follow-up #1).
 *
 * The trend-intersection pipeline gates ideas on competability inside its Pass-3
 * GIANT critique (`synthesizer-generation.ts → critiqueIdeas`). The SIGE
 * strategic-agent path BYPASSES that pass entirely — its finalized ideas reach
 * `generated_ideas` through `crossWriteSigeIdeas` without ever being asked
 * "can a SMALL / solo builder realistically win this market?".
 *
 * This module closes that gap WITHOUT reimplementing any moat logic: it reuses
 * the pure helpers in `pipelines/ideas/competability.ts` (`heuristicMoatFlags`,
 * `parseCompetability`, `decideCompetability`, `buildCompetabilityPersisted`) and
 * a single lightweight LLM scoring call over SIGE's EXISTING `chat` infra (same
 * provider/model the session already uses — no new provider).
 *
 * It respects the SAME shadow/enforce semantics as the pipeline path, sourced
 * from the shared `smart.competability` config block:
 *   - enabled      → compute the scorecard for every finalized idea.
 *   - enforceGate  → actually DROP uncompetable ideas before persistence;
 *                    otherwise keep them and log (shadow mode).
 *
 * The LLM call emits the SAME structured schema as the pipeline critique
 * (`rawCompetabilitySchema`) and is parsed by the SAME fail-safe parser, so a
 * malformed/truncated response degrades to neutral defaults instead of throwing.
 */

import { chat } from "../agent/chat";
import type { AiProvider, ConversationMessage } from "../agent/types";
import { createLogger } from "../logger";
import {
  type CompetabilityPersisted,
  type CompetabilityScore,
  buildCompetabilityPersisted,
  decideCompetability,
  heuristicMoatFlags,
  parseCompetability,
} from "../pipelines/ideas/competability";
import type { CompetabilityConfig } from "../config/schema";
import type { ScoredIdea } from "./types";

const log = createLogger("sige:competability");

const SYSTEM_PROMPT =
  "You score whether a SMALL / solo builder can realistically WIN a market in v1. " +
  "This is the INVERSE of defensibility: score the INCUMBENT moat the small builder " +
  "must OVERCOME. Be ruthless. Output only valid JSON.";

/** Cap the LLM scoring output so a batch of finalized ideas can't truncate. */
const MAX_OUTPUT_TOKENS = 8000;

/** Per-idea outcome of the SIGE competability gate. */
export interface SigeCompetabilityResult {
  readonly idea: ScoredIdea;
  /** Normalized, clamped competability score (heuristic + LLM). */
  readonly score: CompetabilityScore;
  /** true ⇒ the gate would reject this idea (uncompetable for a small builder). */
  readonly gated: boolean;
  /** Human-readable reason for the decision (LLM gate and/or heuristic). */
  readonly reason: string;
  /** The scorecard as persisted on generated_ideas.competability_json. */
  readonly persisted: CompetabilityPersisted;
}

/** Result of gating a batch of finalized SIGE ideas. */
export interface SigeCompetabilityGateResult {
  /** Ideas that survive the gate (all ideas when shadow mode / gate disabled). */
  readonly kept: readonly SigeCompetabilityResult[];
  /** Ideas dropped by the gate (only non-empty when enforcing). */
  readonly dropped: readonly SigeCompetabilityResult[];
}

/** Build the model-facing batch scoring prompt over the finalized ideas. */
function buildPrompt(ideas: readonly ScoredIdea[]): string {
  const ideaList = ideas
    .map(
      (idea, i) =>
        `${i + 1}. ID: ${idea.id}\n   Title: ${idea.title}\n   Description: ${idea.description.slice(0, 400)}`,
    )
    .join("\n\n");

  return `Score the INCUMBENT moat a small / solo builder must overcome for each idea.

Each moat dimension is 0..5 where 5 = the moat is OVERWHELMING for a small builder:
  - capital: capex / sustained funding burn to even launch (fleets, hardware, content licensing, deep subsidies).
  - networkEffect: value needs critical-mass users/supply already locked up by incumbents (two-sided marketplaces, social).
  - logistics: physical ops / fulfillment / field operations at scale.
  - regulated: licensing / compliance / regulatory capture as a barrier.
Then give ONE overall 0..5 score for "a small builder CAN realistically win v1" (5 = wide open, 0 = impossible).
A "build a DoorDash / Uber / Spotify" idea must score overall LOW (<=1.5). A sharp niche tool a solo dev can ship scores HIGH.

## Ideas
${ideaList}

Return ONLY a JSON array with one entry per idea (same order), each:
{
  "id": "<idea id>",
  "dimensions": { "capital": 0, "networkEffect": 0, "logistics": 0, "regulated": 0 },
  "overall": 0,
  "rationale": "one sentence"
}`;
}

/**
 * Tolerantly extract a JSON array of raw competability blobs from an LLM
 * response. Best-effort and NEVER throws — a non-parseable response yields an
 * empty array, leaving every idea to fall back to its heuristic-only score.
 */
export function extractRawArray(text: string): readonly Record<string, unknown>[] {
  const trimmed = text.trim();
  const tryParse = (candidate: string): unknown[] | null => {
    try {
      const parsed = JSON.parse(candidate);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };

  let arr = tryParse(trimmed);
  if (!arr) {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced?.[1]) arr = tryParse(fenced[1].trim());
  }
  if (!arr) {
    const bracket = trimmed.match(/\[[\s\S]*\]/);
    if (bracket) arr = tryParse(bracket[0]);
  }
  if (!arr) return [];
  return arr.filter(
    (e): e is Record<string, unknown> => e !== null && typeof e === "object",
  );
}

/**
 * Score and gate a batch of finalized SIGE ideas on competability, reusing the
 * pipeline's pure moat helpers and SIGE's existing `chat` infra. Never throws —
 * any LLM/parse failure degrades to a heuristic-only score so a competability
 * problem can NEVER break the SIGE session (callers wrap, but this is the inner
 * guarantee).
 *
 * @param ideas    Finalized SIGE ideas about to be cross-written.
 * @param config   Shared `smart.competability` block (enabled/enforceGate/thresholds).
 * @param model    Model id the SIGE session uses.
 * @param provider Provider the SIGE session uses (anthropic by default).
 * @param incumbentSet Top-N incumbents for the cheap heuristic pre-filter.
 */
export async function gateSigeIdeasOnCompetability(params: {
  readonly ideas: readonly ScoredIdea[];
  readonly config: CompetabilityConfig;
  readonly model: string;
  readonly provider?: AiProvider;
  readonly incumbentSet?: ReadonlySet<string>;
}): Promise<SigeCompetabilityGateResult> {
  const { ideas, config, model, provider = "anthropic" } = params;
  const incumbentSet = params.incumbentSet ?? new Set<string>();
  const enforce = config.enforceGate === true;

  if (ideas.length === 0) {
    return { kept: [], dropped: [] };
  }

  // Single batched LLM scoring call. A failure leaves rawById empty so every
  // idea falls back to a heuristic-only (neutral) competability score.
  const rawById = new Map<string, Record<string, unknown>>();
  try {
    const messages: readonly ConversationMessage[] = [
      { role: "user", content: buildPrompt(ideas), timestamp: Date.now() },
    ];
    const response = await chat(messages, {
      systemPrompt: SYSTEM_PROMPT,
      model,
      provider,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });
    const rawArray = extractRawArray(response.text);
    rawArray.forEach((raw, idx) => {
      const id = typeof raw.id === "string" ? raw.id : ideas[idx]?.id;
      if (id) rawById.set(id, raw);
    });
  } catch (err) {
    log.warn(
      "SIGE competability LLM scoring failed — falling back to heuristic-only",
      { err },
    );
  }

  const kept: SigeCompetabilityResult[] = [];
  const dropped: SigeCompetabilityResult[] = [];

  for (const idea of ideas) {
    const raw = rawById.get(idea.id);
    // parseCompetability is fail-safe: undefined/malformed → neutral midpoints.
    const score = parseCompetability(raw);

    const decision = decideCompetability(score, {
      rejectThreshold: config.rejectThreshold,
      softPenaltyThreshold: config.softPenaltyThreshold,
    });

    // Cheap heuristic can ALSO flag an obvious uncompetable shell even when the
    // LLM was lenient (mirrors the pipeline critique).
    const heuristic = heuristicMoatFlags(
      `${idea.title}. ${idea.description}`,
      incumbentSet,
    );

    const gated = !decision.pass || heuristic.obvious;
    const reason = heuristic.obvious
      ? decision.reason
        ? `${decision.reason}; ${heuristic.reason}`
        : heuristic.reason
      : decision.reason;

    // score is always a valid CompetabilityScore here, so this is never null.
    const persisted = buildCompetabilityPersisted(score, reason, gated)!;

    const result: SigeCompetabilityResult = {
      idea,
      score,
      gated,
      reason,
      persisted,
    };

    if (gated && enforce) {
      dropped.push(result);
      log.info("SIGE idea KILLED by competability gate (enforced)", {
        ideaId: idea.id,
        title: idea.title,
        overall: score.overall,
        reason,
      });
    } else {
      kept.push(result);
      if (gated) {
        log.info("SIGE idea WOULD-KILL by competability gate (shadow mode, kept)", {
          ideaId: idea.id,
          title: idea.title,
          overall: score.overall,
          reason,
        });
      }
    }
  }

  // Summary log — emitted EVERY run regardless of kills (mirrors the pipeline's
  // GIANT/Competability shadow gate summaries) so an all-pass run is observable.
  log.info("Competability gate summary", {
    evaluated: ideas.length,
    killed: kept.filter((r) => r.gated).length + dropped.length,
    enforced: enforce,
    dropped: dropped.length,
  });

  return { kept, dropped };
}
