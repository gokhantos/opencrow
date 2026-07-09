/**
 * Generation layer for the trend-intersection synthesizer.
 *
 * Owns the three LLM sub-phases and the single-pass fallback:
 *   - Pass 1 `discoverIntersections`
 *   - Pass 2 `developIdeas` / `developIdeasWide`
 *   - Pass 3 `critiqueIdeas` (GIANT)
 *   - `singlePassSynthesis`
 * The shared prompt constants, section builders, exemplar blocks, and pure
 * helpers these passes use live in `./synthesizer-prompts`.
 *
 * Extracted verbatim from synthesizer.ts as a behavior-preserving structural
 * refactor; the public symbols are re-exported from "./synthesizer".
 */

import { chat } from "../../agent/chat";
import { resolveLlmCallTimeoutMs } from "../../agent/llm-timeout";
import type { ConversationMessage } from "../../agent/types";
import { createLogger } from "../../logger";
import { UNTRUSTED_PREAMBLE } from "../../sige/untrusted";
import type { ModelProvider } from "../../store/model-routing";
import type { IdeaCategory } from "../types";
import type {
  TrendData,
  ClusteredPains,
  CapabilityScan,
  GeneratedIdeaCandidate,
  IntersectionHypothesis,
  SynthesisResult,
} from "./types";
import { aggregateGiant } from "./giant";
import {
  buildCompetabilityPersisted,
  heuristicMoatFlags,
  hardVetoCompetability,
} from "./competability";
import {
  type CompetabilityDecisionInput,
  persistCompetabilityDecisions,
} from "../../sources/ideas/competability-decisions-store";
import {
  DEFAULT_BUILDER_PROFILE,
  type BuilderProfile,
  decideCompetabilityForProfile,
  matchExpertiseDomain,
} from "./builder-profile";
import type {
  GiantConfig,
  GenerateWideConfig,
  CompetabilityConfig,
} from "../../config/schema";
import {
  parseVerbalizedSeeds,
  planSegmentDirectives,
  renderSegmentSpread,
} from "./generate-wide";
import {
  buildChatOptions,
  parseJsonArrayLenient,
  parseJsonFromResponse,
  sanitizeForPrompt,
} from "./synthesizer";
import { chunkIntersections, mergeWithCap } from "./overgen-chunking";
import { bindCritiques, type CritiqueBatch } from "./giant-critique-binding";
import {
  DEFAULT_CRITIQUE_BATCH_SIZE,
  type GiantCritiqueContext,
  runCritiqueBatch,
} from "./giant-critique";
import {
  CATEGORY_CONTEXT,
  SCHLEP_INSTRUCTION,
  NEVER_GENERATE_BLOCK,
  antiExemplarSection,
  buildExistingIdeasContext,
  buildInsightsSection,
  compositeToQualityScore,
  hasDemandEvidence,
  normalizeSignalIds,
  outcomeMemorySection,
  seedToCandidate,
  validatedExemplarSection,
} from "./synthesizer-prompts";

const log = createLogger("pipeline:synthesizer");

// ── Pass 1: Intersection Discovery ──────────────────────────────────────

export async function discoverIntersections(
  trends: TrendData,
  pains: ClusteredPains,
  capabilities: CapabilityScan,
  model: string,
  chainOfEvidence: boolean,
  segmentDirective = "",
  graphDirective = "",
  // REQUIRED routed provider (no Claude default) — see buildChatOptions.
  provider: ModelProvider,
  // App Store keyword-gap SIGNAL block (already rendered + sanitized upstream in
  // synthesizeFromTrends, flag-gated on appstoreKeywordGap.enabled). Injected as
  // additional whitespace-opportunity context so the seed can surface
  // intersections that address an under-served keyword. Empty string → the
  // prompt is byte-identical to today. Optional + defaulted so every existing
  // caller compiles and behaves identically.
  keywordGapSection = "",
): Promise<readonly IntersectionHypothesis[]> {
  const insightsSection = buildInsightsSection(trends, pains, capabilities, chainOfEvidence);
  // SEED diversity steering (learned from past verdicts, flag-gated upstream).
  // Injected at the TOP of the seed prompt so it redirects WHICH intersections
  // the model surfaces — the deterministic seed (avg-rating / complaint-count
  // ordering) otherwise repeats the same over-explored segments every run. The
  // v2 directive asks for a BALANCED SPREAD across several under-explored
  // segments (not a single new one) so the pool the cap balances is multi-segment.
  // Empty string → prompt is byte-identical to today.
  const diversitySection = segmentDirective ? `${segmentDirective}\n\n` : "";
  // SEED graph-reasoning steering (multi-hop opportunity paths from the Neo4j
  // graph, flag-gated upstream). Injected right after the diversity directive so
  // both shape WHICH intersections are surfaced before the source insights. The
  // directive is already sanitized + untrusted-fenced. Empty string → prompt is
  // byte-identical to today.
  const graphSection = graphDirective ? `${graphDirective}\n\n` : "";
  // App Store keyword-gap whitespace signals (flag-gated + rendered upstream).
  // Placed after the source insights so they augment — never displace — the
  // three-source intelligence. Empty string → prompt byte-identical to today.
  const gapSection = keywordGapSection ? `\n\n${keywordGapSection}` : "";

  const prompt = `You have structured market intelligence from three sources. Find the non-obvious intersections.

${diversitySection}${graphSection}${insightsSection}${gapSection}

Generate 15-20 intersection hypotheses. Each hypothesis should represent a SPECIFIC opportunity where:
- A real pain or gap in the market (from the landscape/review data) meets
- A new capability that just became available (from the capability data) and
- A market timing signal that makes this the RIGHT MOMENT

Return ONLY a JSON array:
[
  {
    "title": "string — 3-5 word hypothesis name",
    "painSignal": "string — which specific pain/gap/workaround this addresses",
    "capabilitySignal": "string — which new capability enables a fundamentally better solution",
    "marketSignal": "string — which trend or timing signal makes this opportune NOW",
    "hypothesis": "string — 2-sentence description: what becomes possible and why it matters",
    "signalStrength": number
  }
]

signalStrength is 0.0-1.0: how strongly the data supports this intersection (not how excited you are). High scores require all three signals to be clearly present in the data above.`;

  const messages: ConversationMessage[] = [
    { role: "user", content: prompt, timestamp: Date.now() },
  ];

  const response = await chat(messages, {
    ...buildChatOptions(model, provider),
    systemPrompt: "You are a product opportunity spotter. Find non-obvious intersections between market pain points and new capabilities. Output only valid JSON arrays.",
  });

  log.info("Pass 1 (intersections) raw response", {
    length: response.text.length,
    preview: response.text.slice(0, 200),
  });

  const intersections = parseJsonFromResponse<IntersectionHypothesis[]>(response.text, []);

  log.info("Pass 1 complete", { count: intersections.length });
  return intersections;
}

// ── Pass 2: Idea Development ─────────────────────────────────────────────

export async function developIdeas(
  topIntersections: readonly IntersectionHypothesis[],
  category: IdeaCategory,
  saturatedThemes: string,
  deepSearchContext: string,
  model: string,
  validatedExemplars: string,
  chainOfEvidence: boolean,
  antiExemplars = "",
  outcomeMemory = "",
  // REQUIRED routed provider (no Claude default). This is the SINGLE-IDEA
  // fallback target for the wide path: it MUST inherit the same routed provider
  // the wide pass used, never silently jump to Claude — see buildChatOptions.
  provider: ModelProvider,
): Promise<readonly GeneratedIdeaCandidate[]> {
  const intersectionLines = topIntersections.map((h, i) =>
    `${i + 1}. "${h.title}"\n   Pain: ${h.painSignal}\n   Capability: ${h.capabilitySignal}\n   Market: ${h.marketSignal}\n   Hypothesis: ${h.hypothesis}\n   Signal strength: ${h.signalStrength.toFixed(2)}`,
  ).join("\n\n");

  const saturatedSection = saturatedThemes
    ? `\nPREVIOUSLY GENERATED (avoid these themes):\n${saturatedThemes}`
    : "";

  const exemplarSection = validatedExemplarSection(validatedExemplars);
  const antiSection = antiExemplarSection(antiExemplars);
  const outcomeSection = outcomeMemorySection(outcomeMemory);

  const evidenceInstruction = chainOfEvidence
    ? `\n- supportingSignalIds: array of [id:...] tokens from the SIGNAL CITATIONS / capability annotations above that ground THIS idea (e.g. ["hackernews_3","producthunt_1"]). Cite only signals you actually used.`
    : "";

  const evidenceField = chainOfEvidence
    ? `,\n    "supportingSignalIds": ["string"]`
    : "";

  const existingIdeasContext = await buildExistingIdeasContext();

  const prompt = `You are developing the following validated market intersection hypotheses into concrete product ideas.

DIVERSITY REQUIREMENT (CRITICAL):
- Each idea MUST target a DIFFERENT market category and user segment
- No two ideas should address the same pain point or use the same technology
- If two ideas sound similar, DISCARD the weaker one and think of something completely different
- Spread across: consumer apps, B2B tools, developer tools, health/wellness, education, finance, creative tools, logistics

${CATEGORY_CONTEXT[category]}

${SCHLEP_INSTRUCTION}

${NEVER_GENERATE_BLOCK}

=== VALIDATED INTERSECTION HYPOTHESES (ranked by signal strength) ===
${intersectionLines}
${sanitizeForPrompt(deepSearchContext)}
${exemplarSection}
${antiSection}
${outcomeSection}
${saturatedSection}
${existingIdeasContext}

For EACH hypothesis, develop a full product idea. Ground every field in the hypothesis signals above.

Each idea requires:
- title: Creative 2-3 word name
- summary: Full paragraph (4-6 sentences). What is it? Who specifically uses it? What is the "10x moment"? Why is timing perfect?
- reasoning: Full paragraph. Trace each signal: which specific pain + which capability + which market shift. Why couldn't this exist 12 months ago?
- trendIntersection: One sentence — "Trending X + Pain Y + Capability Z = this idea"
- designDescription: Full paragraph. Key screens, core user journey, visual style.
- monetizationDetail: Full paragraph. Pricing tiers, TAM estimate, path to $1M ARR, comparable comps.
- sourceLinks: References traceable to real data signals (can be [])
- sourcesUsed: Which data sources provided evidence for each signal
- category: "${category}"
- qualityScore: 1.0-5.0 (self-assessed — will be overridden by critique pass)
- targetAudience: Specific person (job title, age, situation, location if relevant)
- keyFeatures: 5-7 specific features (not generic, tied to the hypothesis signals)
- revenueModel: One-line summary${evidenceInstruction}

Return ONLY a JSON array of ${topIntersections.length} ideas:
[
  {
    "title": "string",
    "summary": "string",
    "reasoning": "string",
    "trendIntersection": "string",
    "designDescription": "string",
    "monetizationDetail": "string",
    "sourceLinks": [{"title": "string", "url": "string", "source": "string"}],
    "sourcesUsed": "string",
    "category": "${category}",
    "qualityScore": number,
    "targetAudience": "string",
    "keyFeatures": ["string"],
    "revenueModel": "string"${evidenceField}
  }
]`;

  const messages: ConversationMessage[] = [
    { role: "user", content: prompt, timestamp: Date.now() },
  ];

  const response = await chat(messages, {
    ...buildChatOptions(model, provider),
    systemPrompt: `${UNTRUSTED_PREAMBLE}\n\nYou are a product strategist turning validated market opportunities into concrete product ideas. Output only valid JSON arrays.`,
  });

  log.info("Pass 2 (development) raw response", {
    length: response.text.length,
    preview: response.text.slice(0, 200),
  });

  let candidates = parseJsonFromResponse<GeneratedIdeaCandidate[]>(response.text, []);

  if (candidates.length === 0 && response.text.length > 0) {
    log.warn("Pass 2 returned no parseable JSON, retrying");
    const retryPrompt = `Generate ${topIntersections.length} product ideas as a JSON array. Each needs: title, summary, reasoning, trendIntersection, designDescription, monetizationDetail, sourceLinks (can be []), sourcesUsed, category ("${category}"), qualityScore (1-5), targetAudience, keyFeatures (array), revenueModel. Respond with ONLY the JSON array:`;

    const retryResponse = await chat(
      [{ role: "user", content: retryPrompt, timestamp: Date.now() }],
      { ...buildChatOptions(model, provider), systemPrompt: "Output only valid JSON. No other text." },
    );

    candidates = parseJsonFromResponse<GeneratedIdeaCandidate[]>(retryResponse.text, []);
  }

  const normalized = chainOfEvidence
    ? candidates.map(normalizeSignalIds)
    : candidates;

  log.info("Pass 2 complete", { count: normalized.length });
  return normalized;
}

// ── Pass 2 (wide): Verbalized-Sampling over-generation ──────────────────────
//
// Phase 1 "generate-wide": instead of ONE idea per intersection (single-category,
// novelty-hostile), ask the model for a DISTRIBUTION of `seedsPerIntersection`
// DISTINCT candidate ideas — each as an {idea, probability} pair (Verbalized
// Sampling). The self-reported probability is captured as a diversity/coverage
// prior ONLY (verbalizedProb), never as the quality score (qualityScore stays
// owned by the GIANT critique). Every seed MUST keep its supportingSignalIds so
// breadth never drifts off the grounding signals (groundedness is the gate).
//
// When multiSegment is on, the prompt also carries a per-segment spread quota so
// the pool SPANS opportunity spaces (consumer/b2b_saas/devtools/...) instead of
// collapsing to consumer-mobile. Every candidate is tagged with its segment.
//
// Backward-compatible + graceful: any failure here is caught by the caller, which
// falls back to the legacy single-idea developIdeas path.

/**
 * VERBALIZED-SAMPLING over-generation for ONE batch of intersections. Asks the
 * model for `seedsPerIntersection` distinct {idea, probability} seeds per
 * intersection, parses + tags them, and caps to `maxCandidates`. Never throws on
 * a parse miss (returns []), but a chat() failure propagates so the caller can
 * fall back to the legacy path.
 */
export async function developIdeasWide(
  topIntersections: readonly IntersectionHypothesis[],
  category: IdeaCategory,
  saturatedThemes: string,
  deepSearchContext: string,
  model: string,
  validatedExemplars: string,
  chainOfEvidence: boolean,
  generateWide: GenerateWideConfig,
  antiExemplars = "",
  outcomeMemory = "",
  // REQUIRED routed provider (no Claude default) — see buildChatOptions.
  provider: ModelProvider,
): Promise<readonly GeneratedIdeaCandidate[]> {
  const seedsPer = generateWide.seedsPerIntersection;
  // Plan the segment spread over the FULL over-generated target so the pool spans
  // opportunity spaces (multiSegment only — empty block otherwise). Planned over
  // the FULL intersection set (not per-chunk) so segment diversity spans the
  // whole pool; the same spread text is reused in every chunk's prompt.
  const target = Math.min(
    topIntersections.length * seedsPer,
    generateWide.maxCandidates,
  );
  const segmentSpread = generateWide.multiSegment
    ? renderSegmentSpread(planSegmentDirectives(target))
    : "";

  const saturatedSection = saturatedThemes
    ? `\nPREVIOUSLY GENERATED (avoid these themes):\n${saturatedThemes}`
    : "";
  const exemplarSection = validatedExemplarSection(validatedExemplars);
  const antiSection = antiExemplarSection(antiExemplars);
  const outcomeSection = outcomeMemorySection(outcomeMemory);

  const evidenceInstruction = chainOfEvidence
    ? `\n  - supportingSignalIds: array of [id:...] tokens from the SIGNAL CITATIONS / capability annotations above that ground THIS idea. Cite only signals you actually used. EVERY seed MUST stay bound to its grounding signals.`
    : "";
  const evidenceField = chainOfEvidence
    ? `,\n      "supportingSignalIds": ["string"]`
    : "";
  const segmentField = generateWide.multiSegment
    ? `,\n      "segment": "string — one of: consumer, b2b_saas, devtools, fintech, healthcare, vertical_ops, marketplace, infrastructure, ai_native"`
    : "";

  const existingIdeasContext = await buildExistingIdeasContext();

  // Build the prompt + issue ONE chat call for a single chunk of intersections,
  // returning that chunk's parsed candidates. Byte-identical in shape to the
  // legacy single-call output (same prompt template, system prompt, output cap,
  // and parse/seed→candidate path) so only the INPUT slice differs per chunk —
  // downstream dedupe/select/critique is unaffected.
  const developChunk = async (
    chunk: readonly IntersectionHypothesis[],
  ): Promise<readonly GeneratedIdeaCandidate[]> => {
    const intersectionLines = chunk
      .map(
        (h, i) =>
          `${i + 1}. "${h.title}"\n   Pain: ${h.painSignal}\n   Capability: ${h.capabilitySignal}\n   Market: ${h.marketSignal}\n   Hypothesis: ${h.hypothesis}\n   Signal strength: ${h.signalStrength.toFixed(2)}`,
      )
      .join("\n\n");

    const prompt = `You are developing validated market intersection hypotheses into a DIVERSE DISTRIBUTION of concrete product ideas (Verbalized Sampling).

OVER-GENERATION REQUIREMENT (CRITICAL):
- For EACH hypothesis below, propose ${seedsPer} DISTINCT product ideas — not one. Cover genuinely different angles, buyers, and wedges for the same underlying signals.
- Return a DISTRIBUTION: each idea carries a self-reported "probability" (0.0-1.0) = how likely YOU think this specific framing is the strongest realization of the signals. The probabilities across a hypothesis's seeds need not sum to 1; treat them as relative confidence. We use them ONLY for coverage/diversity, so DO include lower-probability "long-shot" framings — do not collapse to the single safest idea.
- Every seed MUST stay grounded in the SAME intersection signals. Breadth must NOT drift off the evidence.

DIVERSITY REQUIREMENT (CRITICAL):
- Spread ideas across DIFFERENT market segments and user types — not all consumer mobile apps.
- No two seeds should be near-duplicates; if two sound similar, replace the weaker with a fundamentally different angle.

${CATEGORY_CONTEXT[category]}

${SCHLEP_INSTRUCTION}

${NEVER_GENERATE_BLOCK}
${segmentSpread}

=== VALIDATED INTERSECTION HYPOTHESES (ranked by signal strength) ===
${intersectionLines}
${sanitizeForPrompt(deepSearchContext)}
${exemplarSection}
${antiSection}
${outcomeSection}
${saturatedSection}
${existingIdeasContext}

For EACH seed, develop a full product idea grounded in the hypothesis signals above. Each idea requires:
  - title: Creative 2-3 word name
  - summary: Full paragraph (4-6 sentences). What is it? Who specifically uses it? The "10x moment"? Why is timing perfect?
  - reasoning: Full paragraph tracing each signal (pain + capability + market shift). Why couldn't this exist 12 months ago?
  - trendIntersection: One sentence — "Trending X + Pain Y + Capability Z = this idea"
  - designDescription: Full paragraph. Key screens, core user journey, visual style.
  - monetizationDetail: Full paragraph. Pricing tiers, TAM estimate, path to $1M ARR, comps.
  - sourceLinks: References traceable to real data signals (can be [])
  - sourcesUsed: Which data sources provided evidence for each signal
  - category: "${category}"
  - qualityScore: 1.0-5.0 (self-assessed — will be overridden by critique pass)
  - targetAudience: Specific person (job title, age, situation)
  - keyFeatures: 5-7 specific features tied to the hypothesis signals
  - revenueModel: One-line summary${evidenceInstruction}

Return ONLY a JSON array of {idea, probability} seeds (${seedsPer} per hypothesis):
[
  {
    "probability": number,
    "idea": {
      "title": "string",
      "summary": "string",
      "reasoning": "string",
      "trendIntersection": "string",
      "designDescription": "string",
      "monetizationDetail": "string",
      "sourceLinks": [{"title": "string", "url": "string", "source": "string"}],
      "sourcesUsed": "string",
      "category": "${category}",
      "qualityScore": number,
      "targetAudience": "string",
      "keyFeatures": ["string"],
      "revenueModel": "string"${segmentField}${evidenceField}
    }
  }
]`;

    const messages: ConversationMessage[] = [
      { role: "user", content: prompt, timestamp: Date.now() },
    ];

    const response = await chat(messages, {
      ...buildChatOptions(model, provider),
      // Over-generating N seeds per chunk is still a large response; the default
      // 16k output cap truncates the JSON array mid-stream. Raise the budget and
      // pair it with the truncation-tolerant parser below so the pool never
      // silently collapses.
      maxOutputTokens: 32000,
      // Defense-in-depth: give each chunk call more than the default 210s LLM
      // deadline. Chunking is the primary fix (each call now stays in the proven
      // ~90s regime); this floor avoids a borderline chunk tipping over the
      // global default. Keep a 240s floor BUT let LLM_CALL_TIMEOUT_MS raise it —
      // slower routes (e.g. deepseek via OpenCode Zen, which can take >240s for a
      // large ~20k-token synthesis response) need a higher ceiling or the pool
      // collapses to zero ideas.
      callTimeoutMs: Math.max(240_000, resolveLlmCallTimeoutMs()),
      systemPrompt: `${UNTRUSTED_PREAMBLE}\n\nYou are a product strategist emitting a DIVERSE DISTRIBUTION of grounded product ideas via Verbalized Sampling. Each idea is a {idea, probability} pair. Output only a valid JSON array.`,
    });

    log.info("Pass 2 (wide over-generation) chunk raw response", {
      chunkSize: chunk.length,
      length: response.text.length,
      preview: response.text.slice(0, 200),
    });

    // Truncation-tolerant: recover every complete element even if the array was
    // cut off at the token cap (standard parse would yield 0).
    const parsed = parseJsonArrayLenient(response.text);
    const seeds = parseVerbalizedSeeds(parsed, generateWide.maxCandidates);

    return seeds
      .map((seed) =>
        seedToCandidate(seed, category, generateWide.multiSegment, chainOfEvidence),
      )
      // Drop empty-title noise (a seed with no idea payload is unusable).
      .filter((c) => c.title.trim().length > 0);
  };

  // Chunk the intersections so each call stays in the proven ~5k-output / ~90s
  // regime instead of asking ONE call for ~30 dense ideas (which timed out at
  // 210s on every run). Issue one chat per chunk; a slow/failed chunk is caught,
  // logged, and skipped so it only costs that chunk — the outer fallback in
  // synthesizer.ts still fires when EVERY chunk yields nothing (length === 0).
  const chunks = chunkIntersections(topIntersections, generateWide.chunkSize);
  const perChunkCandidates: GeneratedIdeaCandidate[][] = [];
  let collected = 0;

  for (const chunk of chunks) {
    // Cap is a HARD ceiling across the concatenated total: once reached, stop
    // issuing further chunk calls (no point spending tokens we will truncate).
    if (collected >= generateWide.maxCandidates) break;
    try {
      const chunkCandidates = await developChunk(chunk);
      perChunkCandidates.push([...chunkCandidates]);
      collected += chunkCandidates.length;
    } catch (chunkErr) {
      log.warn("Over-generation chunk failed, continuing with remaining chunks", {
        chunkSize: chunk.length,
        err: chunkErr,
      });
    }
  }

  const candidates = mergeWithCap(perChunkCandidates, generateWide.maxCandidates);

  log.info("Pass 2 (wide) complete", {
    chunks: chunks.length,
    chunkSize: generateWide.chunkSize,
    candidates: candidates.length,
    seedsPerIntersection: seedsPer,
    multiSegment: generateWide.multiSegment,
  });

  return candidates;
}

// ── Pass 3: GIANT Critique ─────────────────────────────────────────────────
//
// The critique LLM pass now scores each idea against THE GIANT RUBRIC — the
// single shared 9-axis optimization target (acuteProblem, whyNow, demand,
// monetization, feasibility, nonObviousness, defensibility, marketShape,
// founderFit, each 0..5) plus a
// Sequoia archetype tag, a structured dated whyNow array, and a painSeverity.
// It is still a SINGLE LLM call (no added cost) — only WHAT it scores changed.
//
// Aggregation is non-compensatory (weighted geometric mean) and runs in
// SHADOW MODE: aggregateGiant always computes `gated` from the hard gates +
// demand evidence-gate, but ideas are only actually dropped when
// smart.giant.enforceGates is true. The composite (0..5) becomes qualityScore
// so existing downstream code keeps working.

// GiantCritiqueEntry (the parsed-and-bound scorecard) + the parse/bind helpers
// now live in ./giant-critique-binding so they can be unit-tested without a chat
// client; critiqueIdeas chunks the candidate pool and binds per batch.

// The Pass-3 prompt builder + per-batch chat call live in ./giant-critique
// (DEFAULT_CRITIQUE_BATCH_SIZE / runCritiqueBatch / GiantCritiqueContext). This
// file keeps the survival + gating loop that consumes the bound critiques.

/**
 * Score candidates against the GIANT rubric (CHUNKED into small per-batch LLM
 * calls) then aggregate each into the non-compensatory composite. Shadow-mode by
 * default: gated ideas are KEPT (with their GIANT scorecard attached) and merely
 * logged unless `giant.enforceGates` is true, in which case gated ideas are
 * dropped.
 *
 * Backward-compatible: on any parse/LLM failure the original candidates are
 * returned unchanged so the optional GIANT path can't break the pipeline.
 */
export async function critiqueIdeas(
  candidates: readonly GeneratedIdeaCandidate[],
  trendsSummary: string,
  painsSummary: string,
  capabilitiesSummary: string,
  model: string,
  giant: GiantConfig,
  antiExemplars = "",
  // Explicit `| undefined` (not optional `?`) so the trailing REQUIRED `provider`
  // is allowed and any un-threaded caller is a compile error. The sole caller
  // (synthesizeFromTrends) already passes all of these positionally.
  competability: CompetabilityConfig | undefined,
  incumbentSet: ReadonlySet<string> = new Set<string>(),
  audit:
    | {
        /** Pipeline run id stamped on each audit decision row (nullable). */
        readonly pipelineRunId?: string | null;
        /** Epoch SECONDS the decisions were made (caller supplies via `now()`). */
        readonly decidedAt: number;
      }
    | undefined,
  // REQUIRED routed provider (no Claude default) — see buildChatOptions.
  provider: ModelProvider,
): Promise<readonly GeneratedIdeaCandidate[]> {
  const competabilityOn = competability?.enabled === true;
  // The builder the gate is evaluated for. Defaults to the solo bootstrapper
  // (identity transform) when no profile is configured.
  const builderProfile: BuilderProfile =
    competability?.builderProfile ?? DEFAULT_BUILDER_PROFILE;
  // Shared, batch-invariant context. Injects the negative-archetype block so the
  // critic PENALIZES nonObviousness / defensibility for ideas matching the
  // generic patterns we steered away from.
  const critiqueCtx: GiantCritiqueContext = {
    antiSection: antiExemplarSection(antiExemplars),
    competabilityOn,
    builderProfile,
    rawContext: [
      "=== RAW TRENDS SUMMARY ===",
      sanitizeForPrompt(trendsSummary || "").slice(0, 8000),
      "=== RAW PAINS SUMMARY ===",
      sanitizeForPrompt(painsSummary || "").slice(0, 8000),
      "=== RAW CAPABILITIES SUMMARY ===",
      sanitizeForPrompt(capabilitiesSummary || "").slice(0, 8000),
    ].join("\n"),
  };

  // CHUNK the critique so each LLM call scores a small batch that fits the token
  // budget and fully parses. Scoring the whole over-generated pool (~20) in one
  // call made the 38-41k-char response TRUNCATE even at a 32k cap, so the strict
  // parse fell to lenient EVERY run, lenient salvaged only the front-half
  // scorecards, the whole-pool positional fallback then refused to bind, and NO
  // candidate received a GIANT scorecard → every giant_* column persisted NULL.
  // Per batch the response parses cleanly and positional alignment holds.
  // batchSize 0 => one batch over the whole pool (legacy single-call behavior).
  const configuredBatch = giant.critiqueBatchSize ?? DEFAULT_CRITIQUE_BATCH_SIZE;
  const batchSize = configuredBatch > 0 ? configuredBatch : candidates.length || 1;
  const batches = chunkIntersections(candidates, batchSize);

  const critiqueBatches: CritiqueBatch[] = [];
  for (const batch of batches) {
    // Sequential per-batch: bounded concurrency keeps the routed-provider call
    // pattern identical to the legacy single call (no burst of parallel calls).
    critiqueBatches.push(await runCritiqueBatch(batch, critiqueCtx, model, provider));
  }

  const totalRecovered = critiqueBatches.reduce((n, b) => n + b.entries.length, 0);
  log.info("Pass 3 (GIANT critique) chunked", {
    poolSize: candidates.length,
    batches: batches.length,
    batchSize,
    recovered: totalRecovered,
  });

  if (totalRecovered === 0) {
    log.warn("Pass 3 returned no parseable critiques, returning candidates as-is");
    return candidates;
  }

  // Bind each candidate to its critique: exact title first, then a PER-BATCH
  // positional fallback (sound when a batch returned one entry per candidate).
  // Per-batch alignment means one truncated batch can no longer disable
  // positional binding for the WHOLE pool (the legacy single-call failure).
  const binder = bindCritiques(critiqueBatches);

  const enforceGates = giant.enforceGates === true;
  const survived: GeneratedIdeaCandidate[] = [];

  // Competability observability counters — emitted as a single summary EVERY run
  // (mirrors the GIANT shadow gate summary) so an all-pass run is still visible.
  let competabilityEvaluated = 0;
  let competabilityWouldKill = 0;
  let competabilityDropped = 0;
  // Audit EVERY competability-evaluated idea — KEPT or KILLED — so the calibration
  // backtest sees the complete gate population, not just the survivors. Collected
  // here, flushed in ONE best-effort batch after the loop.
  const enforceCompetabilityGate = competabilityOn && competability?.enforceGate === true;
  const competabilityDecisions: CompetabilityDecisionInput[] = [];

  for (let idx = 0; idx < candidates.length; idx++) {
    const candidate = candidates[idx]!;
    const critique = binder.lookup(idx, candidate.title);

    if (!critique) {
      // No critique found — keep with original score (degrade gracefully).
      log.warn("No GIANT critique found for idea, keeping with original score", {
        title: candidate.title,
      });
      survived.push(candidate);
      continue;
    }

    const { parsed, painSeverity } = critique;
    const demandEvidence = hasDemandEvidence(parsed);
    const aggregate = aggregateGiant(parsed.scores, {
      weights: giant.weights,
      enforceGates,
      hasDemandEvidence: demandEvidence,
      // A hard-gate axis the critic OMITTED (formatting failure) is "not scored"
      // — it must not falsely reject the idea under enforcement. Safety-valved in
      // parseGiant: a near-empty/malformed critique reports no missing axes and
      // keeps the strict missing→0 gate behavior.
      missingAxes: parsed.missingAxes,
    });

    const qualityScore = compositeToQualityScore(aggregate.composite);

    // ── Layer B: competability gate ─────────────────────────────────────────
    // Cheap heuristic pre-filter first (no extra LLM cost), then the LLM-scored
    // moat decision. Computed whenever competability is enabled; ENFORCED only
    // when enforceGate is on (shadow mode by default, mirroring giant gates).
    const competabilityScore = critique.competability;
    const enforceCompetability =
      competabilityOn && competability?.enforceGate === true;
    let competabilityGated = false;
    let competabilityReason = "";
    // EFFECTIVE (profile-adjusted) moat dims/overall persisted on the candidate;
    // null until the profile transform runs on a scored idea.
    let effectiveDims:
      | Readonly<Record<"capital" | "networkEffect" | "logistics" | "regulated", number>>
      | null = null;
    let effectiveOverall: number | null = null;
    let matchedExpertiseDomain: string | null = null;

    if (competabilityOn) {
      competabilityEvaluated += 1;
      const heuristic = heuristicMoatFlags(
        `${candidate.title}. ${candidate.summary} ${candidate.targetAudience}`,
        incumbentSet,
      );
      if (competabilityScore) {
        // Apply the builder profile as a pure discount, then run the
        // non-compensatory gate on the EFFECTIVE score.
        matchedExpertiseDomain = matchExpertiseDomain(
          `${candidate.title}. ${candidate.summary} ${candidate.targetAudience}`,
          builderProfile.expertiseDomains,
        );
        const { effective, decision } = decideCompetabilityForProfile(
          competabilityScore,
          builderProfile,
          {
            rejectThreshold: competability?.rejectThreshold,
            softPenaltyThreshold: competability?.softPenaltyThreshold,
          },
          { matchedExpertiseDomain },
        );
        effectiveDims = effective.dimensions;
        effectiveOverall = effective.overall;
        competabilityGated = !decision.pass;
        competabilityReason = decision.reason;

        // HARD per-dimension veto — evaluated on the RAW (profile-INDEPENDENT)
        // moat score, so an inherently-uncompetable market (regulation / heavy
        // capital / physical logistics / network-effect cold-start) is killed
        // regardless of the overall AND regardless of any builder-profile
        // discount. Independent backstop; only ACTS when enforcing (shadow
        // otherwise), mirroring the composite gate below.
        if (competability?.hardVeto !== false) {
          const veto = hardVetoCompetability(competabilityScore, {
            threshold: competability?.hardVetoThreshold,
            dimensions: competability?.hardVetoDimensions,
          });
          if (veto.vetoed) {
            competabilityGated = true;
            competabilityReason = competabilityReason
              ? `${veto.reason}; ${competabilityReason}`
              : veto.reason;
            log.info("Idea HARD-VETOED by competability gate (uncompetable moat)", {
              title: candidate.title,
              dimension: veto.dimension,
              rawScore: veto.value,
              threshold: competability?.hardVetoThreshold ?? 4,
              enforced: enforceCompetabilityGate,
            });
          }
        }
      }
      // The heuristic can ALSO flag an obvious uncompetable shell even when the
      // LLM was lenient — treat that as a gate too.
      if (heuristic.obvious) {
        competabilityGated = true;
        competabilityReason = competabilityReason
          ? `${competabilityReason}; ${heuristic.reason}`
          : heuristic.reason;
      }

      // AUDIT this evaluation (KEPT or KILLED), BEFORE the kill `continue` below,
      // using the EFFECTIVE (decided) score + RAW slice — the same scorecard the
      // idea would carry. Only when a real LLM score exists (heuristic-only rows
      // have no dims to persist). Skipped when the caller passed no `audit` ctx.
      if (audit && competabilityScore && effectiveDims && effectiveOverall !== null) {
        const persisted = buildCompetabilityPersisted(
          {
            dimensions: effectiveDims,
            overall: effectiveOverall,
            rationale: competabilityScore.rationale,
          },
          competabilityReason,
          competabilityGated,
          {
            raw: {
              dimensions: competabilityScore.dimensions,
              overall: competabilityScore.overall,
            },
            matchedExpertiseDomain,
          },
        );
        if (persisted) {
          competabilityDecisions.push({
            source: "pipeline",
            pipelineRunId: audit.pipelineRunId ?? null,
            ideaTitle: candidate.title,
            // DB id not yet assigned at gate time — candidates are in-memory
            // structs that have not been persisted yet.  Null by design;
            // a future backfill could match on (pipeline_run_id, idea_title).
            ideaId: null,
            persisted,
            gated: competabilityGated,
            enforced: enforceCompetabilityGate,
            decidedAt: audit.decidedAt,
          });
        }
      }
    }

    const scored: GeneratedIdeaCandidate = {
      ...candidate,
      qualityScore,
      giant: parsed.scores,
      giantEvidence: parsed.evidence,
      archetype: parsed.archetype,
      whyNow: parsed.whyNow,
      painSeverity,
      giantComposite: aggregate.composite,
      giantGated: aggregate.gated,
      giantGateReasons: aggregate.gateReasons,
      ...(competabilityScore && effectiveDims && effectiveOverall !== null
        ? {
            // EFFECTIVE (decided) values feed the column + JSON top-level.
            competability: effectiveDims,
            competabilityOverall: effectiveOverall,
            // RAW (pre-profile) moat preserved for audit / re-scoring.
            competabilityRaw: competabilityScore.dimensions,
            competabilityRawOverall: competabilityScore.overall,
            competabilityMatchedExpertiseDomain: matchedExpertiseDomain,
          }
        : {}),
      ...(competabilityOn
        ? { competabilityGated, competabilityReason }
        : {}),
    };

    // SHADOW MODE: gating is always computed + stored; the idea is only actually
    // dropped when enforcement is on. Otherwise we keep it and log the would-kill.
    if (aggregate.gated) {
      if (enforceGates) {
        log.info("Idea KILLED by GIANT hard gate (enforced)", {
          title: candidate.title,
          composite: aggregate.composite,
          gateReasons: aggregate.gateReasons,
          verdict: critique.verdict,
        });
        continue;
      }
      log.info("Idea WOULD-KILL by GIANT gate (shadow mode, kept)", {
        title: candidate.title,
        composite: aggregate.composite,
        gateReasons: aggregate.gateReasons,
        verdict: critique.verdict,
      });
    }

    // Layer B competability gate (independent of the GIANT gate above).
    if (competabilityGated) {
      competabilityWouldKill += 1;
      if (enforceCompetability) {
        competabilityDropped += 1;
        log.info("Idea KILLED by competability gate (enforced)", {
          title: candidate.title,
          overall: competabilityScore?.overall,
          reason: competabilityReason,
        });
        continue;
      }
      log.info("Idea WOULD-KILL by competability gate (shadow mode, kept)", {
        title: candidate.title,
        overall: competabilityScore?.overall,
        reason: competabilityReason,
      });
    }

    survived.push(scored);
  }

  // Best-effort audit flush — NEVER throws (the store swallows + logs), so an
  // audit-insert problem can never break idea generation. No-op when the caller
  // passed no `audit` context (e.g. tests) or when nothing was scored.
  if (audit) {
    await persistCompetabilityDecisions(competabilityDecisions);
  }

  // Competability gate summary — emitted EVERY run regardless of kills (mirrors
  // the GIANT shadow gate summary) so an all-pass run is still observable.
  if (competabilityOn) {
    log.info("Competability gate summary", {
      evaluated: competabilityEvaluated,
      killed: competabilityWouldKill,
      enforced: competability?.enforceGate === true,
      dropped: competabilityDropped,
    });
  }

  log.info("Pass 3 (GIANT) complete", {
    input: candidates.length,
    survived: survived.length,
    dropped: candidates.length - survived.length,
    enforceGates,
  });

  return survived;
}

// ── Fallback: Single-pass synthesis ──────────────────────────────────────

export async function singlePassSynthesis(input: {
  readonly trends: TrendData;
  readonly pains: ClusteredPains;
  readonly capabilities: CapabilityScan;
  readonly deepSearchContext: string;
  readonly saturatedThemes: string;
  readonly category: IdeaCategory;
  readonly maxIdeas: number;
  readonly model: string;
  /** REQUIRED routed provider (no Claude default) — see buildChatOptions. */
  readonly provider: ModelProvider;
  readonly validatedExemplars?: string;
  readonly antiExemplars?: string;
  readonly outcomeMemory?: string;
}): Promise<SynthesisResult> {
  const { trends, pains, capabilities, deepSearchContext, saturatedThemes, category, maxIdeas, model } = input;
  const provider: ModelProvider = input.provider;

  const saturatedSection = saturatedThemes
    ? `\nPREVIOUSLY GENERATED (avoid these themes):\n${saturatedThemes}`
    : "";

  const exemplarSection = validatedExemplarSection(input.validatedExemplars ?? "");
  const antiSection = antiExemplarSection(input.antiExemplars ?? "");
  const outcomeSection = outcomeMemorySection(input.outcomeMemory ?? "");

  const existingIdeasContext = await buildExistingIdeasContext();

  const prompt = `You are a product strategist analyzing REAL market data. You have three data sets:

1. THE APP LANDSCAPE — what 4000+ existing apps offer, their satisfaction scores, and which categories are underserved
2. USER VOICES — what users hate AND what they love (both complaints and praises tell you what matters)
3. NEW CAPABILITIES — what new tech, open source tools, and behavior shifts just became available

Your job: Find opportunities where existing apps FAIL to deliver what users clearly want, and where new capabilities make a BETTER solution possible now.

${CATEGORY_CONTEXT[category]}

${SCHLEP_INSTRUCTION}

${NEVER_GENERATE_BLOCK}

=== APP LANDSCAPE (4000+ apps across 28 categories — satisfaction scores, what they offer) ===
${sanitizeForPrompt(trends.summary || "No landscape data")}

=== USER REVIEWS (what people HATE and what they LOVE — both matter) ===
${sanitizeForPrompt(pains.summary || "No review data")}

=== NEW CAPABILITIES (emerging tech, open source, behavior shifts) ===
${sanitizeForPrompt(capabilities.summary || "No capability data")}
${sanitizeForPrompt(deepSearchContext)}
${exemplarSection}
${antiSection}
${outcomeSection}
${saturatedSection}
${existingIdeasContext}

Generate ${maxIdeas} ideas. Return ONLY a JSON array:
[
  {
    "title": "string",
    "summary": "string",
    "reasoning": "string",
    "trendIntersection": "string",
    "designDescription": "string",
    "monetizationDetail": "string",
    "sourceLinks": [{"title": "string", "url": "string", "source": "string"}],
    "sourcesUsed": "string",
    "category": "${category}",
    "qualityScore": number,
    "targetAudience": "string",
    "keyFeatures": ["string"],
    "revenueModel": "string"
  }
]`;

  const messages: ConversationMessage[] = [
    { role: "user", content: prompt, timestamp: Date.now() },
  ];

  const response = await chat(messages, {
    ...buildChatOptions(model, provider),
    systemPrompt: `${UNTRUSTED_PREAMBLE}\n\nYou are a JSON API. You ONLY output valid JSON arrays. No markdown, no explanations, no preamble. Start your response with [ and end with ].`,
  });

  log.info("Fallback single-pass raw response", {
    length: response.text.length,
    preview: response.text.slice(0, 300),
  });

  let candidates = parseJsonFromResponse<GeneratedIdeaCandidate[]>(response.text, []);

  if (candidates.length === 0 && response.text.length > 0) {
    log.warn("Fallback synthesis returned no parseable JSON, retrying");
    const retryPrompt = `Generate ${maxIdeas} product ideas as a JSON array. Each needs: title, summary, reasoning, trendIntersection, designDescription, monetizationDetail, sourceLinks (can be []), sourcesUsed, category ("${category}"), qualityScore (1-5), targetAudience, keyFeatures (array), revenueModel. Respond with ONLY the JSON array:`;

    const retryResponse = await chat(
      [{ role: "user", content: retryPrompt, timestamp: Date.now() }],
      { ...buildChatOptions(model, provider), systemPrompt: "Output only valid JSON. No other text." },
    );

    candidates = parseJsonFromResponse<GeneratedIdeaCandidate[]>(retryResponse.text, []);
  }

  return { candidates, totalGenerated: candidates.length };
}
