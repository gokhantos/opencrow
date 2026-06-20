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
import type { ConversationMessage } from "../../agent/types";
import { createLogger } from "../../logger";
import { UNTRUSTED_PREAMBLE } from "../../sige/untrusted";
import type { IdeaCategory } from "../types";
import type {
  TrendData,
  ClusteredPains,
  CapabilityScan,
  GeneratedIdeaCandidate,
  IntersectionHypothesis,
  SynthesisResult,
} from "./types";
import {
  parseGiant,
  aggregateGiant,
  type ParsedGiant,
} from "./giant";
import {
  parseCompetability,
  decideCompetability,
  heuristicMoatFlags,
  type CompetabilityScore,
} from "./competability";
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
import {
  CATEGORY_CONTEXT,
  GIANT_RUBRIC_PROMPT,
  SCHLEP_INSTRUCTION,
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

  const prompt = `You have structured market intelligence from three sources. Find the non-obvious intersections.

${diversitySection}${insightsSection}

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
    ...buildChatOptions(model),
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
    ...buildChatOptions(model),
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
      { ...buildChatOptions(model), systemPrompt: "Output only valid JSON. No other text." },
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
): Promise<readonly GeneratedIdeaCandidate[]> {
  const intersectionLines = topIntersections
    .map(
      (h, i) =>
        `${i + 1}. "${h.title}"\n   Pain: ${h.painSignal}\n   Capability: ${h.capabilitySignal}\n   Market: ${h.marketSignal}\n   Hypothesis: ${h.hypothesis}\n   Signal strength: ${h.signalStrength.toFixed(2)}`,
    )
    .join("\n\n");

  const seedsPer = generateWide.seedsPerIntersection;
  // Plan the segment spread over the FULL over-generated target so the pool spans
  // opportunity spaces (multiSegment only — empty block otherwise).
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
    ...buildChatOptions(model),
    // Over-generating N seeds per intersection is a large response; the default
    // 16k output cap truncates the JSON array mid-stream. Raise the budget and
    // pair it with the truncation-tolerant parser below so the pool never
    // silently collapses to the single-idea fallback.
    maxOutputTokens: 32000,
    systemPrompt: `${UNTRUSTED_PREAMBLE}\n\nYou are a product strategist emitting a DIVERSE DISTRIBUTION of grounded product ideas via Verbalized Sampling. Each idea is a {idea, probability} pair. Output only a valid JSON array.`,
  });

  log.info("Pass 2 (wide over-generation) raw response", {
    length: response.text.length,
    preview: response.text.slice(0, 200),
  });

  // Truncation-tolerant: recover every complete element even if the array was
  // cut off at the token cap (standard parse would yield 0 and force fallback).
  const parsed = parseJsonArrayLenient(response.text);
  const seeds = parseVerbalizedSeeds(parsed, generateWide.maxCandidates);

  const candidates = seeds
    .map((seed) =>
      seedToCandidate(seed, category, generateWide.multiSegment, chainOfEvidence),
    )
    // Drop empty-title noise (a seed with no idea payload is unusable).
    .filter((c) => c.title.trim().length > 0)
    .slice(0, generateWide.maxCandidates);

  log.info("Pass 2 (wide) complete", {
    seeds: seeds.length,
    candidates: candidates.length,
    seedsPerIntersection: seedsPer,
    multiSegment: generateWide.multiSegment,
  });

  return candidates;
}

// ── Pass 3: GIANT Critique ─────────────────────────────────────────────────
//
// The critique LLM pass now scores each idea against THE GIANT RUBRIC — the
// single shared 7-axis optimization target (acuteProblem, whyNow, demand,
// nonObviousness, defensibility, marketShape, founderFit, each 0..5) plus a
// Sequoia archetype tag, a structured dated whyNow array, and a painSeverity.
// It is still a SINGLE LLM call (no added cost) — only WHAT it scores changed.
//
// Aggregation is non-compensatory (weighted geometric mean) and runs in
// SHADOW MODE: aggregateGiant always computes `gated` from the hard gates +
// demand evidence-gate, but ideas are only actually dropped when
// smart.giant.enforceGates is true. The composite (0..5) becomes qualityScore
// so existing downstream code keeps working.

/** One parsed GIANT critique entry, keyed back to its idea by title. */
interface GiantCritiqueEntry {
  readonly title: string;
  readonly parsed: ParsedGiant;
  readonly painSeverity: number;
  readonly verdict: string;
  /** Layer B: parsed competability moat score (present only when emitted). */
  readonly competability?: CompetabilityScore;
}

/**
 * Score candidates against the GIANT rubric in a single LLM call, then aggregate
 * each into the non-compensatory composite. Shadow-mode by default: gated ideas
 * are KEPT (with their GIANT scorecard attached) and merely logged unless
 * `giant.enforceGates` is true, in which case gated ideas are dropped.
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
  competability?: CompetabilityConfig,
  incumbentSet: ReadonlySet<string> = new Set<string>(),
): Promise<readonly GeneratedIdeaCandidate[]> {
  const competabilityOn = competability?.enabled === true;
  const ideaList = candidates.map((c, i) =>
    `${i + 1}. "${c.title}"\n   Summary: ${c.summary.slice(0, 300)}\n   Reasoning: ${c.reasoning.slice(0, 200)}\n   Target: ${c.targetAudience}\n   Features: ${c.keyFeatures.slice(0, 4).join(", ")}`,
  ).join("\n\n");

  // Inject the negative archetype block so the critic PENALIZES nonObviousness /
  // defensibility for ideas that match the generic patterns we steered away from.
  const antiSection = antiExemplarSection(antiExemplars);

  const rawContext = [
    "=== RAW TRENDS SUMMARY ===",
    sanitizeForPrompt(trendsSummary || "").slice(0, 8000),
    "=== RAW PAINS SUMMARY ===",
    sanitizeForPrompt(painsSummary || "").slice(0, 8000),
    "=== RAW CAPABILITIES SUMMARY ===",
    sanitizeForPrompt(capabilitiesSummary || "").slice(0, 8000),
  ].join("\n");

  const prompt = `You are a ruthless product idea critic. Score each idea honestly against the raw market data.

${rawContext}
${antiSection}

=== IDEAS TO CRITIQUE ===
${ideaList}

${GIANT_RUBRIC_PROMPT}
${
  competabilityOn
    ? `
=== COMPETABILITY (can a SMALL / solo builder realistically WIN this market?) ===
This is the INVERSE of defensibility: score the INCUMBENT moat the small builder must OVERCOME.
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
      "nonObviousness": "string",
      "defensibility": "string",
      "marketShape": "string",
      "founderFit": "string"
    },${
      competabilityOn
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

  const messages: ConversationMessage[] = [
    { role: "user", content: prompt, timestamp: Date.now() },
  ];

  const response = await chat(messages, {
    ...buildChatOptions(model),
    // The GIANT critique scales with the (over-generated) pool: one scorecard per
    // candidate, each ~7 scores + 7 evidence strings + a whyNow array + verdict.
    // With generate-wide ON (default, up to maxCandidates ideas) the default 16k
    // output cap TRUNCATES this array mid-stream. A truncated response made the
    // non-lenient parser below yield ZERO critiques → every candidate fell through
    // the "no critique" branch WITHOUT a GIANT scorecard, so candidate.giant stayed
    // undefined all the way to the store and giant_* columns persisted NULL on live
    // runs. Raise the budget to match the wide over-generation pass.
    maxOutputTokens: 32000,
    systemPrompt:
      "You are a ruthless product idea critic scoring ideas against the GIANT rubric. Score honestly; cite per-axis evidence. Output only valid JSON arrays.",
  });

  log.info("Pass 3 (GIANT critique) raw response", {
    length: response.text.length,
    preview: response.text.slice(0, 200),
  });

  // Truncation-tolerant parse (mirrors the wide over-generation pass): recover
  // every COMPLETE scorecard even if the array was cut off at the token cap. The
  // legacy non-lenient parser yielded NOTHING on truncation, which silently
  // stripped GIANT from the entire pool. Fall back to the lenient walker whenever
  // the strict parse comes back empty so a single late-truncated entry can no
  // longer drop the GIANT scorecards the model DID emit.
  let rawCritiques = parseJsonFromResponse<unknown[]>(response.text, []);
  if (rawCritiques.length === 0) {
    const recovered = parseJsonArrayLenient(response.text);
    if (recovered.length > 0) {
      log.info("Pass 3 strict parse empty; recovered critiques leniently", {
        recovered: recovered.length,
      });
      rawCritiques = recovered;
    }
  }

  if (rawCritiques.length === 0) {
    log.warn("Pass 3 returned no parseable critiques, returning candidates as-is");
    return candidates;
  }

  // Tolerantly parse each raw critique into a normalized GIANT entry, keyed by
  // title AND retained in emission order. parseGiant never throws, so a malformed
  // row degrades to safe defaults rather than killing the whole pass. The ordered
  // list backs a POSITIONAL fallback below: the critic is instructed to return one
  // entry per idea "in the same order", so when the model lightly rewords a title
  // (common on the wide path) we can still bind the scorecard by index instead of
  // dropping GIANT for that candidate.
  const critiqueByTitle = new Map<string, GiantCritiqueEntry>();
  const critiquesInOrder: GiantCritiqueEntry[] = [];
  for (const raw of rawCritiques) {
    if (raw === null || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const title = typeof r.title === "string" ? r.title : "";
    if (title.trim().length === 0) continue;
    const parsed = parseGiant(raw);
    const painSeverity =
      typeof r.painSeverity === "number"
        ? Math.min(5, Math.max(0, r.painSeverity))
        : parsed.scores.acuteProblem;
    // Layer B: tolerantly parse the competability moat object when present.
    const competabilityScore =
      competabilityOn && "competability" in r
        ? parseCompetability(r.competability)
        : undefined;
    const entry: GiantCritiqueEntry = {
      title,
      parsed,
      painSeverity,
      verdict: typeof r.verdict === "string" ? r.verdict : "",
      ...(competabilityScore ? { competability: competabilityScore } : {}),
    };
    critiqueByTitle.set(title.toLowerCase().trim(), entry);
    critiquesInOrder.push(entry);
  }

  // Positional fallback is only sound when the critic returned exactly one entry
  // per candidate (the prompt's "same order" contract). Otherwise we never guess
  // by index and fall back to keeping the original score.
  const positionalAligned = critiquesInOrder.length === candidates.length;

  const enforceGates = giant.enforceGates === true;
  const survived: GeneratedIdeaCandidate[] = [];

  // Competability observability counters — emitted as a single summary EVERY run
  // (mirrors the GIANT shadow gate summary) so an all-pass run is still visible.
  let competabilityEvaluated = 0;
  let competabilityWouldKill = 0;
  let competabilityDropped = 0;

  for (let idx = 0; idx < candidates.length; idx++) {
    const candidate = candidates[idx]!;
    const critique =
      critiqueByTitle.get(candidate.title.toLowerCase().trim()) ??
      (positionalAligned ? critiquesInOrder[idx] : undefined);

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

    if (competabilityOn) {
      competabilityEvaluated += 1;
      const heuristic = heuristicMoatFlags(
        `${candidate.title}. ${candidate.summary} ${candidate.targetAudience}`,
        incumbentSet,
      );
      if (competabilityScore) {
        const decision = decideCompetability(competabilityScore, {
          rejectThreshold: competability?.rejectThreshold,
          softPenaltyThreshold: competability?.softPenaltyThreshold,
        });
        competabilityGated = !decision.pass;
        competabilityReason = decision.reason;
      }
      // The heuristic can ALSO flag an obvious uncompetable shell even when the
      // LLM was lenient — treat that as a gate too.
      if (heuristic.obvious) {
        competabilityGated = true;
        competabilityReason = competabilityReason
          ? `${competabilityReason}; ${heuristic.reason}`
          : heuristic.reason;
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
      ...(competabilityScore
        ? {
            competability: competabilityScore.dimensions,
            competabilityOverall: competabilityScore.overall,
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
  readonly validatedExemplars?: string;
  readonly antiExemplars?: string;
  readonly outcomeMemory?: string;
}): Promise<SynthesisResult> {
  const { trends, pains, capabilities, deepSearchContext, saturatedThemes, category, maxIdeas, model } = input;

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
    ...buildChatOptions(model),
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
      { ...buildChatOptions(model), systemPrompt: "Output only valid JSON. No other text." },
    );

    candidates = parseJsonFromResponse<GeneratedIdeaCandidate[]>(retryResponse.text, []);
  }

  return { candidates, totalGenerated: candidates.length };
}
