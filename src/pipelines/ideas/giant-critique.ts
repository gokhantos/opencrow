/**
 * GIANT Pass-3 critique orchestration: the per-batch prompt + the chat call that
 * scores ONE small batch of candidates.
 *
 * Why this is chunked (the live regression it fixes): the critic used to score
 * the WHOLE over-generated pool (~20) in one call. With deepseek-v4-flash the
 * 38-41k-char response TRUNCATED even at a 32k cap, so the strict parse fell to
 * lenient every run, lenient only salvaged the front-half scorecards, the
 * whole-pool positional fallback then refused to bind, and NO candidate received
 * a GIANT scorecard → every giant_* column persisted NULL. Scoring a small batch
 * per call keeps each response inside the budget so it parses cleanly and stays
 * positionally aligned per batch.
 *
 * The pure parse/bind math lives in ./giant-critique-binding; the survival /
 * gating loop stays in critiqueIdeas (synthesizer-generation).
 */

import { chat } from "../../agent/chat";
import type { ConversationMessage } from "../../agent/types";
import { createLogger } from "../../logger";
import type { ModelProvider } from "../../store/model-routing";
import type { BuilderProfile } from "./builder-profile";
import { describeBuilderProfile } from "./builder-profile";
import {
  buildCritiqueEntries,
  parseRawCritiques,
  type CritiqueBatch,
} from "./giant-critique-binding";
import { buildChatOptions } from "./synthesizer";
import { GIANT_RUBRIC_PROMPT } from "./synthesizer-prompts";
import type { GeneratedIdeaCandidate } from "./types";

const log = createLogger("pipeline:synthesizer");

/** Default candidates per GIANT-critique LLM call when no batch size is configured. */
export const DEFAULT_CRITIQUE_BATCH_SIZE = 7;

/** Shared, batch-invariant context the GIANT critique prompt wraps each batch in. */
export interface GiantCritiqueContext {
  readonly rawContext: string;
  readonly antiSection: string;
  readonly competabilityOn: boolean;
  readonly builderProfile: BuilderProfile;
}

/**
 * Build the GIANT-critique prompt for ONE batch of candidates. The shared market
 * context + rubric are constant across batches; only the numbered idea list
 * changes. Numbering restarts at 1 per batch so the model's "same order"
 * contract maps cleanly onto the batch (positional binding is then per-batch —
 * see bindCritiques).
 */
export function buildGiantCritiquePrompt(
  batch: readonly GeneratedIdeaCandidate[],
  ctx: GiantCritiqueContext,
): string {
  const ideaList = batch
    .map(
      (c, i) =>
        `${i + 1}. "${c.title}"\n   Summary: ${c.summary.slice(0, 300)}\n   Reasoning: ${c.reasoning.slice(0, 200)}\n   Target: ${c.targetAudience}\n   Features: ${c.keyFeatures.slice(0, 4).join(", ")}`,
    )
    .join("\n\n");

  return `You are a ruthless product idea critic. Score each idea honestly against the raw market data.

${ctx.rawContext}
${ctx.antiSection}

=== IDEAS TO CRITIQUE ===
${ideaList}

${GIANT_RUBRIC_PROMPT}
${
  ctx.competabilityOn
    ? `
=== COMPETABILITY (can a SMALL / solo builder realistically WIN this market?) ===
This is the INVERSE of defensibility: score the INCUMBENT moat the small builder must OVERCOME.
Context: ${describeBuilderProfile(ctx.builderProfile)} Score the OBJECTIVE, profile-independent moat barriers below — do NOT adjust for the builder; the system applies the builder's resources separately.
Each moat dimension is 0..5 where 5 = the moat is OVERWHELMING for a small builder:
  - capital: capex / sustained funding burn to even launch (fleets, hardware, content licensing, deep subsidies).
  - networkEffect: value needs critical-mass users/supply already locked up by incumbents (two-sided marketplaces, social).
  - logistics: physical ops / fulfillment / field operations at scale.
  - regulated: licensing / compliance / regulatory capture as a barrier.
Then give ONE overall 0..5 score for "a small builder CAN realistically win v1" (5 = wide open, 0 = impossible).
A "build a DoorDash / Uber / Spotify" idea must score overall LOW (<=1.5). A sharp niche tool a solo dev can ship scores HIGH.`
    : ""
}

Return ONLY a JSON array with one entry per idea (in the same order):
[
  {
    "title": "string — must match exactly",
    "scores": {
      "acuteProblem": number,
      "whyNow": number,
      "demand": number,
      "monetization": number,
      "feasibility": number,
      "nonObviousness": number,
      "defensibility": number,
      "marketShape": number,
      "founderFit": number
    },
    "archetype": "hair-on-fire" | "hard-fact" | "future-vision",
    "painSeverity": number,
    "whyNow": [
      {
        "axis": "technological" | "regulatory" | "behavioral" | "economic",
        "claim": "string — the dated enabling shift",
        "boundSignalId": "string — a [id:...] token if this is bound to a real signal (optional)",
        "date": "string — ISO-ish date of the shift (optional)",
        "strength": number
      }
    ],
    "evidence": {
      "acuteProblem": "string — per-axis evidence citation",
      "whyNow": "string",
      "demand": "string — MUST cite a demand artifact or leave empty (demand is then capped low)",
      "monetization": "string — name the buyer + pricing/ARR path",
      "feasibility": "string — what exists TODAY that makes this buildable now",
      "nonObviousness": "string",
      "defensibility": "string",
      "marketShape": "string",
      "founderFit": "string"
    },${
      ctx.competabilityOn
        ? `
    "competability": {
      "dimensions": {
        "capital": number,
        "networkEffect": number,
        "logistics": number,
        "regulated": number
      },
      "overall": number,
      "rationale": "string"
    },`
        : ""
    }
    "verdict": "string — one sentence on the idea's core strength or fatal flaw"
  }
]`;
}

/**
 * Critique ONE batch of candidates: issue the chat call, parse strict→lenient,
 * and normalize into ordered entries. Never throws — an LLM/parse failure for a
 * batch yields zero entries (that batch's candidates keep their original score)
 * so one failing batch can't drop the whole pool. The maxOutputTokens budget is
 * sized for a SMALL batch (the over-gen pool used to truncate in one call).
 */
export async function runCritiqueBatch(
  batch: readonly GeneratedIdeaCandidate[],
  ctx: GiantCritiqueContext,
  model: string,
  provider: ModelProvider,
): Promise<CritiqueBatch> {
  const batchTitles = batch.map((c) => c.title);
  if (batch.length === 0) return { batchTitles, entries: [] };

  try {
    const prompt = buildGiantCritiquePrompt(batch, ctx);
    const messages: ConversationMessage[] = [
      { role: "user", content: prompt, timestamp: Date.now() },
    ];
    const response = await chat(messages, {
      ...buildChatOptions(model, provider),
      // Sized for ONE small batch (~7 scorecards). The legacy single-call path
      // scored the whole over-generated pool here, which TRUNCATED even at 32k
      // and dropped the back-half scorecards → no GIANT bound → giant_* NULL.
      maxOutputTokens: 16000,
      systemPrompt:
        "You are a ruthless product idea critic scoring ideas against the GIANT rubric. Score honestly; cite per-axis evidence. Output only valid JSON arrays.",
    });

    const rawCritiques = parseRawCritiques(response.text);
    const entries = buildCritiqueEntries(rawCritiques, ctx.competabilityOn);
    log.info("Pass 3 (GIANT critique) batch parsed", {
      batchSize: batch.length,
      responseLength: response.text.length,
      recovered: entries.length,
    });
    return { batchTitles, entries };
  } catch (error) {
    // Degrade gracefully: this batch contributes no critiques; the surviving
    // batches still bind. NEVER let one batch break the optional GIANT pass.
    log.warn("Pass 3 (GIANT critique) batch failed, skipping batch", {
      batchSize: batch.length,
      error: error instanceof Error ? error.message : String(error),
    });
    return { batchTitles, entries: [] };
  }
}
