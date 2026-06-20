/**
 * Stage 2 — Broad-shallow ideation (Approach A of the Funnel Breadth Redesign).
 *
 * Sits between Stage 1 (broad stratified intake → many candidate themes) and
 * Stage 3 (selective deep-development of a diverse few). The narrow neck today
 * (`synthesizer.ts` `slice(0, min(maxIdeas*2, 10))`) collapses a wide deduped
 * theme pool to ≤10 BEFORE any ideation. This module instead ideates CHEAPLY
 * over many candidates so the expensive deep-development can spend its budget on
 * a DIVERSE few.
 *
 *   form many ThemeCandidates
 *     → one cheap one-line IdeaSketch each (batched, small/cheap model)
 *       → score each sketch (signalStrength + novelty-vs-saturation + market-gap)
 *         → return sorted ScoredSketch[]   (Stage 3 then `selectDiverseBy`s these)
 *
 * Design rules honored here:
 *   - The cheap model is resolved via the existing model-routing seam
 *     (`getModelRoute` / provider-threaded `chat`) — NEVER a hardcoded id or
 *     bypassed provider. See `defaultShallowIdeationDeps`.
 *   - Novelty REUSES the pipeline's existing saturation signal (the
 *     `saturatedThemes` n-gram block) rather than inventing a new mem0 call path.
 *   - Everything is immutable + readonly; the LLM boundary is Zod-validated; the
 *     scoring function is PURE (no I/O) so it is unit-testable in isolation.
 *   - The orchestrator takes its model client + saturation lookup as injected
 *     `deps` so it is fully mockable without `mock.module`.
 *
 * SHARED: both `pipeline.ts` and (as a follow-up seam) `src/sige/run.ts` can feed
 * candidates here — nothing below is pipeline-specific.
 */

import { z } from "zod";
import { createLogger } from "../../logger";
import { chat } from "../../agent/chat";
import type { AgentOptions, AgentResponse, ConversationMessage } from "../../agent/types";
import {
  getModelRoute,
  MODEL_ROUTING_DEFAULTS,
  type ModelProvider,
  type ModelRoute,
} from "../../store/model-routing";

const log = createLogger("ideas:shallow");

// ── Types ───────────────────────────────────────────────────────────────────

/**
 * A candidate theme to ideate over, derived from the broad corpus / discovered
 * intersections. Provider-agnostic so SIGE frontiers and pipeline intersections
 * both map onto it. `signalStrength` (0..1) and the optional stratification
 * fields (`signalCategory`/`kind`/`source`) are carried THROUGH from the broad
 * pool so scoring + downstream diversity selection can use them.
 */
export interface ThemeCandidate {
  /** Stable id used to bind a model sketch back to its candidate. */
  readonly id: string;
  /** Short human-readable theme name (the sketch prompt anchors on this). */
  readonly title: string;
  /** Stratification bucket carried from the broad pool (may be undefined). */
  readonly signalCategory?: string;
  /** Source-kind carried from the broad pool (trend|pain|capability|…). */
  readonly kind?: string;
  /** Originating source label (producthunt|reddit|appstore|…). */
  readonly source?: string;
  /** 0..1 strength of the underlying signal (clamped at scoring time). */
  readonly signalStrength: number;
  /** Free-text grounding the cheap model sees (pain/capability/market lines). */
  readonly context: string;
}

/** The single cheap one-line sketch the small model emits for a candidate. */
export interface IdeaSketch {
  /** The {@link ThemeCandidate.id} this sketch develops. */
  readonly candidateId: string;
  /** One-line idea sketch (≤ ~200 chars by prompt; not enforced here). */
  readonly line: string;
  /** Model-estimated market gap 0..1 (clamped at scoring time). */
  readonly marketGap: number;
}

/** A sketch with its composite score, component breakdown, and origin candidate. */
export interface ScoredSketch {
  readonly candidate: ThemeCandidate;
  readonly sketch: IdeaSketch;
  /** Composite 0..1 score = Σ weight·component (weights documented below). */
  readonly score: number;
  readonly components: {
    readonly signal: number;
    readonly novelty: number;
    readonly marketGap: number;
  };
}

/** Documented blend weights for the composite sketch score. MUST sum to 1. */
export interface ShallowWeights {
  /** Weight on the carried-through signalStrength of the candidate. */
  readonly signal: number;
  /** Weight on novelty (1 − saturation overlap of the sketch). */
  readonly novelty: number;
  /** Weight on the model-estimated market gap. */
  readonly marketGap: number;
}

/**
 * Default weights. Signal and novelty carry the most weight: signal keeps the
 * sketches evidence-tethered, novelty is the redesign's whole point (push AWAY
 * from saturated themes); marketGap is a softer, model-estimated nudge. Tunable
 * via config but fixed-and-documented here so the pure scorer is deterministic.
 */
export const DEFAULT_SHALLOW_WEIGHTS: ShallowWeights = {
  signal: 0.4,
  novelty: 0.4,
  marketGap: 0.2,
};

/** Context the pure {@link scoreSketch} needs (no I/O). */
export interface ScoreContext {
  readonly candidate: ThemeCandidate;
  /** Lowercased saturated theme phrases (see {@link extractSaturatedPhrases}). */
  readonly saturatedPhrases: readonly string[];
  readonly weights: ShallowWeights;
}

/**
 * Injected dependencies for {@link runShallowIdeation}. Both are async so the
 * default factory can route the model + read the saturation block, while tests
 * pass plain doubles (no `mock.module`).
 */
export interface ShallowIdeationDeps {
  /** Candidates per cheap-model call. */
  readonly batchSize: number;
  /** Run the cheap model over ONE batch; returns the raw model text. */
  readonly callModel: (batch: readonly ThemeCandidate[]) => Promise<string>;
  /** Fetch the current saturated-themes block (pipeline already builds it). */
  readonly lookupSaturation: () => Promise<string>;
  /** Optional weight override; falls back to {@link DEFAULT_SHALLOW_WEIGHTS}. */
  readonly weights?: ShallowWeights;
}

// ── Pure helpers (no I/O) ─────────────────────────────────────────────────────

/** Clamp a number into [0,1]; NaN → 0 (safe floor). PURE. */
function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

const STOP = new Set(["the", "a", "an", "and", "or", "for", "of", "to", "with", "app", "tool"]);

/** Tokenize to lowercase alpha words ≥3 chars, minus a tiny stop list. PURE. */
function tokens(text: string): readonly string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z]/g, ""))
    .filter((w) => w.length >= 3 && !STOP.has(w));
}

/**
 * Parse the pipeline's `saturatedThemes` block into the quoted phrase list it
 * carries (`- "ai email" theme (5 ideas) — …`). REUSES the existing saturation
 * signal rather than a new mem0 call. Returns lowercased phrases. PURE.
 */
export function extractSaturatedPhrases(saturatedThemes: string): readonly string[] {
  if (!saturatedThemes) return [];
  const out: string[] = [];
  const re = /"([^"]+)"\s+theme/gi;
  let m: RegExpExecArray | null = re.exec(saturatedThemes);
  while (m !== null) {
    const phrase = m[1]?.trim().toLowerCase();
    if (phrase) out.push(phrase);
    m = re.exec(saturatedThemes);
  }
  return out;
}

/**
 * Novelty 0..1 of a sketch line vs the saturated phrases. 1 = nothing
 * saturated (no overlap, or no saturated phrases at all). Each saturated phrase
 * whose tokens are ALL present in the sketch costs novelty, additively, so
 * overlapping more distinct saturated themes is more saturated (lower). PURE.
 */
export function noveltyScore(line: string, saturatedPhrases: readonly string[]): number {
  if (saturatedPhrases.length === 0) return 1;
  const lineTokens = new Set(tokens(line));
  if (lineTokens.size === 0) return 1;

  let hits = 0;
  for (const phrase of saturatedPhrases) {
    const phraseTokens = tokens(phrase);
    if (phraseTokens.length === 0) continue;
    const allPresent = phraseTokens.every((t) => lineTokens.has(t));
    if (allPresent) hits += 1;
  }
  if (hits === 0) return 1;
  // Each saturated theme hit removes an even share of novelty, capped at 0.
  return clamp01(1 - hits / saturatedPhrases.length);
}

/**
 * PURE composite scorer: signalStrength + novelty(vs saturation) + market-gap,
 * blended by `weights`. signalStrength + marketGap are clamped to [0,1]; novelty
 * is derived from the saturated phrases. Returns a {@link ScoredSketch} carrying
 * the component breakdown and the originating candidate. No I/O — unit-testable.
 */
export function scoreSketch(sketch: IdeaSketch, ctx: ScoreContext): ScoredSketch {
  const signal = clamp01(ctx.candidate.signalStrength);
  const novelty = noveltyScore(sketch.line, ctx.saturatedPhrases);
  const marketGap = clamp01(sketch.marketGap);
  const { weights } = ctx;
  const score = clamp01(
    weights.signal * signal + weights.novelty * novelty + weights.marketGap * marketGap,
  );
  return {
    candidate: ctx.candidate,
    sketch,
    score,
    components: { signal, novelty, marketGap },
  };
}

/** Stable descending sort by composite score (does not mutate input). PURE. */
export function rankScored(scored: readonly ScoredSketch[]): readonly ScoredSketch[] {
  return [...scored].sort((a, b) => b.score - a.score);
}

// ── LLM boundary (Zod-validated parse) ────────────────────────────────────────

const sketchSchema = z.object({
  candidateId: z.string().min(1),
  line: z.string().min(1),
  marketGap: z.coerce.number(),
});

/** Extract the JSON array body from a (possibly fenced) model response. */
function jsonArrayBody(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  const body = (fenced?.[1] ?? text).trim();
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  return body.slice(start, end + 1);
}

/**
 * Parse + Zod-validate a cheap-model batch response into {@link IdeaSketch}es,
 * binding each to a KNOWN candidate id (hallucinated ids are dropped). Never
 * throws — malformed JSON / missing fields yield fewer sketches, never an error
 * into the pipeline. Immutable output.
 */
export function parseSketchBatch(
  text: string,
  batch: readonly ThemeCandidate[],
): readonly IdeaSketch[] {
  const body = jsonArrayBody(text);
  if (body === null) return [];

  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    log.warn("shallow: failed to parse sketch batch JSON", { preview: text.slice(0, 160) });
    return [];
  }
  if (!Array.isArray(raw)) return [];

  const knownIds = new Set(batch.map((c) => c.id));
  const out: IdeaSketch[] = [];
  for (const entry of raw) {
    const parsed = sketchSchema.safeParse(entry);
    if (!parsed.success) continue;
    if (!knownIds.has(parsed.data.candidateId)) continue;
    out.push({
      candidateId: parsed.data.candidateId,
      line: parsed.data.line,
      marketGap: parsed.data.marketGap,
    });
  }
  return out;
}

/** Chunk a list into fixed-size batches (last batch may be smaller). PURE. */
function chunk<T>(items: readonly T[], size: number): readonly (readonly T[])[] {
  const safe = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += safe) out.push(items.slice(i, i + safe));
  return out;
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

/**
 * Stage 2 entry point: batch-ideate cheap one-line sketches over `candidates`,
 * score each by signal + novelty + market-gap, and return them sorted descending
 * by composite score. Stage 3 then applies `selectDiverseBy` to pick a diverse
 * few for deep-development.
 *
 * Resilient by construction: a batch whose model call rejects or returns junk
 * simply contributes no sketches (logged); the run still returns the rest. The
 * model client + saturation lookup are injected via `deps` so this is fully
 * mockable without `mock.module`.
 */
export async function runShallowIdeation(
  candidates: readonly ThemeCandidate[],
  deps: ShallowIdeationDeps,
): Promise<readonly ScoredSketch[]> {
  if (candidates.length === 0) return [];

  const saturatedPhrases = extractSaturatedPhrases(await safeSaturation(deps));
  const weights = deps.weights ?? DEFAULT_SHALLOW_WEIGHTS;
  const batches = chunk(candidates, deps.batchSize);

  const results = await Promise.all(
    batches.map(async (batch) => {
      let text: string;
      try {
        text = await deps.callModel(batch);
      } catch (err) {
        log.warn("shallow: cheap-model batch failed; skipping batch", {
          size: batch.length,
          err,
        });
        return [] as readonly IdeaSketch[];
      }
      return parseSketchBatch(text, batch);
    }),
  );

  const byId = new Map(candidates.map((c) => [c.id, c] as const));
  const scored: ScoredSketch[] = [];
  for (const sketches of results) {
    for (const sketch of sketches) {
      const candidate = byId.get(sketch.candidateId);
      if (!candidate) continue;
      scored.push(scoreSketch(sketch, { candidate, saturatedPhrases, weights }));
    }
  }

  log.info("shallow ideation complete", {
    candidates: candidates.length,
    batches: batches.length,
    sketches: scored.length,
    saturatedPhrases: saturatedPhrases.length,
  });

  return rankScored(scored);
}

/** Saturation lookup that never throws (novelty degrades to "everything novel"). */
async function safeSaturation(deps: ShallowIdeationDeps): Promise<string> {
  try {
    return await deps.lookupSaturation();
  } catch (err) {
    log.warn("shallow: saturation lookup failed; treating all as novel", { err });
    return "";
  }
}

// ── Default deps factory (model-routing seam) ─────────────────────────────────

/**
 * Neutralize prompt-injection vectors in untrusted candidate text before it
 * reaches the cheap model, then collapse whitespace and hard-cap length.
 * Self-contained (no import cycle with `synthesizer.ts`) so this module stays
 * SIGE-shareable: a future SIGE caller may feed LESS-cooked candidate text, and
 * Stage 2 must not lower the injection bar. Mirrors `synthesizer.sanitizeForPrompt`.
 */
function sanitizeCandidateText(text: string, maxLen: number): string {
  return text
    .replace(/`{3,}/g, "'''")
    .replace(
      /\b(ignore|disregard|forget)\s+(all\s+)?(previous|above|prior)\s+(instructions?|context|prompts?)\b/gi,
      "[filtered]",
    )
    .replace(/<\/?(?:system|assistant|user|human)>/gi, "[filtered]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

/** The prompt + parsing for one cheap-model sketch batch. */
function buildBatchPrompt(batch: readonly ThemeCandidate[]): string {
  const items = batch
    .map(
      (c, i) =>
        `${i + 1}. id="${c.id}" — ${sanitizeCandidateText(c.title, 200)}` +
        (c.signalCategory ? ` [${sanitizeCandidateText(c.signalCategory, 60)}]` : "") +
        `\n   ${sanitizeCandidateText(c.context, 400)}`,
    )
    .join("\n");
  return (
    "You are a fast product-idea sketcher. For EACH theme below, write ONE concrete " +
    "one-line product idea (≤25 words) and estimate its market gap (0.0 = crowded, " +
    "1.0 = wide-open whitespace).\n\n" +
    `THEMES:\n${items}\n\n` +
    "Return ONLY a JSON array, one object per theme, echoing the id exactly:\n" +
    '[{ "candidateId": "string", "line": "string — the one-line idea", "marketGap": number }]'
  );
}

/**
 * Build the production {@link ShallowIdeationDeps}: resolves the CHEAP model via
 * the existing model-routing seam (`getModelRoute("sige.fast-agent")`,
 * Haiku-class by default — explicitly NOT the deep `pipeline.generator`) and a
 * caller-supplied saturation lookup. An optional `model`/`provider` override
 * (from `shallowIdeation.model` config) wins over the route. Threads the provider
 * through `chat` exactly like the synthesizer does — no hardcoded id, no bypass.
 */
/**
 * Resolve the cheap `sige.fast-agent` route, falling back to the seeded default
 * if the DB-backed override lookup throws (e.g. an uninitialized DB). A transient
 * routing hiccup must never break Stage 2 — degrade to the default cheap route.
 */
async function resolveFastRoute(): Promise<ModelRoute> {
  try {
    return await getModelRoute("sige.fast-agent");
  } catch (err) {
    log.warn("shallow: model-route lookup failed; using default cheap route", { err });
    return MODEL_ROUTING_DEFAULTS["sige.fast-agent"];
  }
}

/**
 * The single LLM call the default deps make. Injectable so tests can verify the
 * model-routing thread WITHOUT `mock.module` on the shared `../../agent/chat`
 * module (which leaks across the single-process isolated lane). Defaults to the
 * real `chat`.
 */
export type ChatFn = (
  messages: readonly ConversationMessage[],
  options: AgentOptions,
) => Promise<AgentResponse>;

export async function defaultShallowIdeationDeps(opts: {
  readonly batchSize: number;
  readonly lookupSaturation: () => Promise<string>;
  /** Optional cheap-model override id from `shallowIdeation.model` config. */
  readonly model?: string;
  /** Optional provider override paired with `model`. */
  readonly provider?: ModelProvider;
  readonly weights?: ShallowWeights;
  /** Test seam: override the LLM call. Defaults to the real `chat`. */
  readonly chatFn?: ChatFn;
}): Promise<ShallowIdeationDeps> {
  const route = await resolveFastRoute();
  const model = opts.model && opts.model.length > 0 ? opts.model : route.model;
  const provider: ModelProvider = opts.provider ?? route.provider;
  const callChat: ChatFn = opts.chatFn ?? chat;

  return {
    batchSize: opts.batchSize,
    lookupSaturation: opts.lookupSaturation,
    weights: opts.weights,
    callModel: async (batch) => {
      const messages: ConversationMessage[] = [
        { role: "user", content: buildBatchPrompt(batch), timestamp: Date.now() },
      ];
      const response = await callChat(messages, {
        systemPrompt:
          "You sketch concrete one-line product ideas fast. Output ONLY a valid JSON array.",
        model,
        provider,
        agentId: "idea-pipeline",
        usageContext: { channel: "pipeline", chatId: "ideas-shallow", source: "workflow" },
      });
      return response.text;
    },
  };
}
