/**
 * Trend-intersection idea synthesizer.
 *
 * 3-pass synthesis approach:
 * 1. Intersection Discovery — find 15-20 non-obvious intersection hypotheses
 * 2. Idea Development — develop top 10 hypotheses into full idea candidates
 * 3. Idea Critique — score each idea on specificity, signal grounding,
 *    differentiation, and buildability; kill weak ones
 *
 * Falls back to single-pass synthesis if Pass 1 fails.
 */

import { chat } from "../../agent/chat";
import type { ConversationMessage } from "../../agent/types";
import type { MemoryManager } from "../../memory/types";
import { createLogger } from "../../logger";
import type { IdeaCategory } from "../types";
import type {
  TrendData,
  ClusteredPains,
  CapabilityScan,
  GeneratedIdeaCandidate,
  IntersectionHypothesis,
  SynthesisResult,
} from "./types";

const log = createLogger("pipeline:synthesizer");

// ── Shared helpers ───────────────────────────────────────────────────────

export function sanitizeForPrompt(text: string): string {
  return text
    .replace(/`{3,}/g, "'''")
    .replace(/\b(ignore|disregard|forget)\s+(all\s+)?(previous|above|prior)\s+(instructions?|context|prompts?)\b/gi, "[filtered]")
    .replace(/<\/?(?:system|assistant|user|human)>/gi, "[filtered]")
    .slice(0, 80000);
}

export function buildChatOptions(model: string) {
  return {
    systemPrompt: "",
    model,
    provider: "anthropic" as const,
    agentId: "idea-pipeline",
    usageContext: { channel: "pipeline" as const, chatId: "ideas", source: "workflow" as const },
  };
}

export function parseJsonFromResponse<T>(text: string, fallback: T): T {
  const jsonMatch =
    text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/) ??
    text.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);

  if (!jsonMatch?.[1]) return fallback;

  try {
    return JSON.parse(jsonMatch[1].trim()) as T;
  } catch {
    log.warn("Failed to parse AI response as JSON", {
      preview: text.slice(0, 200),
    });
    return fallback;
  }
}

// ── Deep Search (optional Qdrant enrichment) ────────────────────────────

export async function deepSearch(
  themes: readonly string[],
  memoryManager: MemoryManager,
): Promise<string> {
  if (themes.length === 0) return "";

  const searchQueries = themes.slice(0, 6);
  const allKinds = [
    "hackernews_story", "reddit_post", "producthunt_product",
    "github_repo", "x_post", "reuters_news", "cointelegraph_news",
    "cryptopanic_news", "investingnews_news", "appstore_review",
    "appstore_app", "playstore_review", "playstore_app",
  ] as const;

  const results = await Promise.all(
    searchQueries.map((query) =>
      memoryManager
        .search("shared", query, { limit: 3, minScore: 0.3, kinds: [...allKinds] })
        .catch(() => []),
    ),
  );

  const seen = new Set<string>();
  const entries: string[] = [];

  for (let i = 0; i < searchQueries.length; i++) {
    const hits = (results[i] ?? []).filter((h) => {
      if (seen.has(h.source.id)) return false;
      seen.add(h.source.id);
      return true;
    });
    if (hits.length === 0) continue;
    const formatted = hits.map((h) => {
      const meta = h.source.metadata;
      const url = meta.url ?? meta.hn_url ?? meta.store_url ?? "";
      return `  [${h.source.kind}] ${meta.title ?? ""}${url ? ` — ${url}` : ""}\n    ${h.chunk.content.slice(0, 200)}`;
    });
    entries.push(`Theme: "${searchQueries[i]}"\n${formatted.join("\n")}`);
  }

  return entries.length > 0
    ? `\n\n=== DEEP SEARCH (supporting evidence from indexed corpus) ===\n${entries.join("\n\n")}`
    : "";
}

// ── Category Context ─────────────────────────────────────────────────────

const CATEGORY_CONTEXT: Record<IdeaCategory, string> = {
  mobile_app: `Generate mobile app ideas for iOS and Android.

WHAT MAKES A GREAT MOBILE APP IDEA:
- Solves a daily friction (something people do 3+ times/week on their phone)
- Has a natural distribution channel (social sharing, word-of-mouth trigger, app store search term)
- Can deliver value in the first 30 seconds of use (no complex onboarding)
- Has a "10x moment" — a specific use case where it's 10x better than the current workaround
- Revenue model works at mobile scale (freemium, subscription, or transaction-based)

AVOID: Enterprise-only ideas, ideas requiring complex integrations, ideas that need a marketplace to work (chicken-and-egg), ideas where a website would work just as well.`,

  crypto_project: `Generate crypto/blockchain project ideas (DeFi, infrastructure, tooling, consumer).

WHAT MAKES A GREAT CRYPTO PROJECT IDEA:
- Leverages on-chain properties that can't be replicated off-chain (composability, permissionless access, programmable money, credible neutrality)
- Solves a problem that CURRENT crypto users have (not hypothetical mainstream users)
- Has a clear token utility or business model that doesn't depend on speculation
- Can launch on existing infrastructure (EVM, Solana, etc.) without building a new chain
- Has distribution via existing DeFi protocols, wallets, or communities

AVOID: "Blockchain for X" where X doesn't need a blockchain, ideas that require mass consumer adoption to work, ideas that are just a token wrapper around a centralized service.`,

  ai_app: `Generate AI application ideas powered by LLMs, vision models, or other ML capabilities.

WHAT MAKES A GREAT AI APP IDEA:
- Uses AI for a specific, narrow task where it's demonstrably better than manual work (not "AI-powered everything")
- The AI capability that enables it only became good enough in the last 12 months (why NOW?)
- Has a clear feedback loop — user corrections make it better over time
- Works even when the AI is 80% accurate (the UX handles errors gracefully)
- Can be built on top of existing model APIs (OpenAI, Anthropic, open source) — no custom training needed for v1

AVOID: "ChatGPT wrapper" ideas with no unique data or workflow, ideas where AI accuracy needs to be 99%+ to be useful, ideas that compete directly with foundation model providers.`,

  open_source: `Generate open source project ideas (developer tools, libraries, frameworks, infrastructure).

WHAT MAKES A GREAT OPEN SOURCE IDEA:
- Solves a pain that developers experience weekly and currently hack around with scripts/glue code
- Has a clear "aha moment" in the README — one code example that shows why this is better
- Can be adopted incrementally (doesn't require ripping out existing tools)
- Has a natural community of contributors (people who want this to exist for their own use)
- Business model path: hosting, enterprise features, support, or SaaS layer on top

AVOID: "Better version of X" where X is already good enough, frameworks that require full buy-in, tools that only matter at massive scale.`,

  general: `Generate tech product ideas across any category.

WHAT MAKES A GREAT PRODUCT IDEA:
- Addresses a specific pain point evidenced in the data (not assumed)
- Has identifiable first users who you could reach today
- Can deliver core value with a small team in 4-8 weeks (MVP scope)
- Has a clear "why now" — something changed recently that makes this possible or necessary
- The one-line pitch makes someone say "I need that" not just "that's interesting"

AVOID: Platform plays that require multiple sides, ideas that need partnerships to launch, ideas where the main value is aggregation without unique insight.`,
};

// ── Insights section builder ──────────────────────────────────────────────

function buildInsightsSection(
  trends: TrendData,
  pains: ClusteredPains,
  capabilities: CapabilityScan,
): string {
  const parts: string[] = [];

  if (trends.insights) {
    const { underservedSegments, workingPatterns, whiteSpaces } = trends.insights;
    const segmentLines = underservedSegments
      .slice(0, 8)
      .map((s) => `  • [${s.category}] ${s.gap} — ${s.evidence}`);
    const patternLines = workingPatterns
      .slice(0, 5)
      .map((p) => `  • ${p.pattern} — ${p.evidence}`);
    const spaceLines = whiteSpaces
      .slice(0, 5)
      .map((w) => `  • ${w.description} (adjacent: ${w.adjacentCategories.join(", ")}) — ${w.reason}`);

    parts.push(
      "=== LANDSCAPE INSIGHTS ===",
      "Underserved segments:",
      ...segmentLines,
      "Working patterns:",
      ...patternLines,
      "White spaces:",
      ...spaceLines,
    );
  } else {
    parts.push(
      "=== APP LANDSCAPE (raw) ===",
      sanitizeForPrompt(trends.summary || "No landscape data").slice(0, 20000),
    );
  }

  if (pains.insights) {
    const { painThemes, workaroundSignals, loveSignals } = pains.insights;
    const themeLines = painThemes
      .slice(0, 8)
      .map((t) => `  • [${t.frequency}] ${t.name}: ${t.description} (apps: ${t.affectedApps.slice(0, 3).join(", ")})`);
    const workaroundLines = workaroundSignals
      .slice(0, 5)
      .map((w) => `  • ${w.description} — current fix: ${w.currentSolution}`);
    const loveLines = loveSignals
      .slice(0, 5)
      .map((l) => `  • [${l.category}] ${l.feature}: ${l.whyUsersLoveIt}`);

    parts.push(
      "",
      "=== REVIEW INSIGHTS ===",
      "Pain themes:",
      ...themeLines,
      "Workaround signals (jobs-to-be-done):",
      ...workaroundLines,
      "Love signals (what to amplify):",
      ...loveLines,
    );
  } else {
    parts.push(
      "",
      "=== USER REVIEWS (raw) ===",
      sanitizeForPrompt(pains.summary || "No review data").slice(0, 20000),
    );
  }

  if (capabilities.insights) {
    const { genuinelyNew, technologyWaves, painCapabilityLinks } = capabilities.insights;
    const capLines = genuinelyNew
      .slice(0, 8)
      .map((c) => `  • [${c.classification}] ${c.title} (${c.source}): ${c.whyNew}`);
    const waveLines = technologyWaves
      .slice(0, 5)
      .map((w) => `  • ${w.name}: ${w.implication}`);
    const linkLines = painCapabilityLinks
      .slice(0, 8)
      .map((l) => `  • Pain "${l.painTheme}" × Capability "${l.capability}": ${l.connectionReason}`);

    parts.push(
      "",
      "=== CAPABILITY INSIGHTS ===",
      "Genuinely new capabilities:",
      ...capLines,
      "Technology waves:",
      ...waveLines,
      "Pain × Capability links:",
      ...linkLines,
    );
  } else {
    parts.push(
      "",
      "=== NEW CAPABILITIES (raw) ===",
      sanitizeForPrompt(capabilities.summary || "No capability data").slice(0, 20000),
    );
  }

  return parts.join("\n");
}

// ── Pass 1: Intersection Discovery ──────────────────────────────────────

async function discoverIntersections(
  trends: TrendData,
  pains: ClusteredPains,
  capabilities: CapabilityScan,
  model: string,
): Promise<readonly IntersectionHypothesis[]> {
  const insightsSection = buildInsightsSection(trends, pains, capabilities);

  const prompt = `You have structured market intelligence from three sources. Find the non-obvious intersections.

${insightsSection}

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

async function developIdeas(
  topIntersections: readonly IntersectionHypothesis[],
  category: IdeaCategory,
  saturatedThemes: string,
  deepSearchContext: string,
  model: string,
): Promise<readonly GeneratedIdeaCandidate[]> {
  const intersectionLines = topIntersections.map((h, i) =>
    `${i + 1}. "${h.title}"\n   Pain: ${h.painSignal}\n   Capability: ${h.capabilitySignal}\n   Market: ${h.marketSignal}\n   Hypothesis: ${h.hypothesis}\n   Signal strength: ${h.signalStrength.toFixed(2)}`,
  ).join("\n\n");

  const saturatedSection = saturatedThemes
    ? `\nPREVIOUSLY GENERATED (avoid these themes):\n${saturatedThemes}`
    : "";

  const prompt = `You are developing the following validated market intersection hypotheses into concrete product ideas.

${CATEGORY_CONTEXT[category]}

=== VALIDATED INTERSECTION HYPOTHESES (ranked by signal strength) ===
${intersectionLines}
${sanitizeForPrompt(deepSearchContext)}
${saturatedSection}

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
- revenueModel: One-line summary

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
    "revenueModel": "string"
  }
]`;

  const messages: ConversationMessage[] = [
    { role: "user", content: prompt, timestamp: Date.now() },
  ];

  const response = await chat(messages, {
    ...buildChatOptions(model),
    systemPrompt: "You are a product strategist turning validated market opportunities into concrete product ideas. Output only valid JSON arrays.",
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

  log.info("Pass 2 complete", { count: candidates.length });
  return candidates;
}

// ── Pass 3: Idea Critique ─────────────────────────────────────────────────

interface CritiqueScore {
  readonly specificity: number;
  readonly signalGrounding: number;
  readonly differentiation: number;
  readonly buildability: number;
}

interface CritiquedIdea {
  readonly title: string;
  readonly scores: CritiqueScore;
  readonly avgScore: number;
  readonly verdict: string;
}

async function critiqueIdeas(
  candidates: readonly GeneratedIdeaCandidate[],
  trendsSummary: string,
  painsSummary: string,
  capabilitiesSummary: string,
  model: string,
): Promise<readonly GeneratedIdeaCandidate[]> {
  const ideaList = candidates.map((c, i) =>
    `${i + 1}. "${c.title}"\n   Summary: ${c.summary.slice(0, 300)}\n   Reasoning: ${c.reasoning.slice(0, 200)}\n   Target: ${c.targetAudience}\n   Features: ${c.keyFeatures.slice(0, 4).join(", ")}`,
  ).join("\n\n");

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

=== IDEAS TO CRITIQUE ===
${ideaList}

Score each idea on 4 criteria (0.0 to 1.0):
- specificity: Is this a concrete product (high) or a vague category play (low)?
- signalGrounding: Can each claim be traced to specific data points above (high) or is it generic (low)?
- differentiation: Is this meaningfully different from obvious existing solutions (high) or incremental (low)?
- buildability: Can a small team ship an MVP in 4-8 weeks (high) or does it require massive infrastructure (low)?

Return ONLY a JSON array with one entry per idea (in the same order):
[
  {
    "title": "string — must match exactly",
    "scores": {
      "specificity": number,
      "signalGrounding": number,
      "differentiation": number,
      "buildability": number
    },
    "avgScore": number,
    "verdict": "string — one sentence on the idea's core strength or fatal flaw"
  }
]`;

  const messages: ConversationMessage[] = [
    { role: "user", content: prompt, timestamp: Date.now() },
  ];

  const response = await chat(messages, {
    ...buildChatOptions(model),
    systemPrompt: "You are a ruthless product idea critic. Score each idea honestly. Output only valid JSON arrays.",
  });

  log.info("Pass 3 (critique) raw response", {
    length: response.text.length,
    preview: response.text.slice(0, 200),
  });

  const critiques = parseJsonFromResponse<CritiquedIdea[]>(response.text, []);

  if (critiques.length === 0) {
    log.warn("Pass 3 returned no parseable critiques, returning candidates as-is");
    return candidates;
  }

  // Build a lookup by title for matching
  const critiqueByTitle = new Map<string, CritiquedIdea>();
  for (const c of critiques) {
    critiqueByTitle.set(c.title.toLowerCase().trim(), c);
  }

  const survived: GeneratedIdeaCandidate[] = [];

  for (const candidate of candidates) {
    const critique = critiqueByTitle.get(candidate.title.toLowerCase().trim());

    if (!critique) {
      // No critique found — keep with original score
      log.warn("No critique found for idea, keeping with original score", { title: candidate.title });
      survived.push(candidate);
      continue;
    }

    const { scores, avgScore } = critique;

    // Kill if average < 0.5 or any single dimension <= 0.2
    const minScore = Math.min(scores.specificity, scores.signalGrounding, scores.differentiation, scores.buildability);
    if (avgScore < 0.5 || minScore <= 0.2) {
      log.info("Idea killed by critique", {
        title: candidate.title,
        avgScore,
        minScore,
        verdict: critique.verdict,
      });
      continue;
    }

    // Map 0-1 critique avg to 1-5 quality scale
    const critiqueQualityScore = 1 + avgScore * 4;

    survived.push({ ...candidate, qualityScore: critiqueQualityScore });
  }

  log.info("Pass 3 complete", {
    input: candidates.length,
    survived: survived.length,
    killed: candidates.length - survived.length,
  });

  return survived;
}

// ── Fallback: Single-pass synthesis ──────────────────────────────────────

async function singlePassSynthesis(input: {
  readonly trends: TrendData;
  readonly pains: ClusteredPains;
  readonly capabilities: CapabilityScan;
  readonly deepSearchContext: string;
  readonly saturatedThemes: string;
  readonly category: IdeaCategory;
  readonly maxIdeas: number;
  readonly model: string;
}): Promise<SynthesisResult> {
  const { trends, pains, capabilities, deepSearchContext, saturatedThemes, category, maxIdeas, model } = input;

  const saturatedSection = saturatedThemes
    ? `\nPREVIOUSLY GENERATED (avoid these themes):\n${saturatedThemes}`
    : "";

  const prompt = `You are a product strategist analyzing REAL market data. You have three data sets:

1. THE APP LANDSCAPE — what 4000+ existing apps offer, their satisfaction scores, and which categories are underserved
2. USER VOICES — what users hate AND what they love (both complaints and praises tell you what matters)
3. NEW CAPABILITIES — what new tech, open source tools, and behavior shifts just became available

Your job: Find opportunities where existing apps FAIL to deliver what users clearly want, and where new capabilities make a BETTER solution possible now.

${CATEGORY_CONTEXT[category]}

=== APP LANDSCAPE (4000+ apps across 28 categories — satisfaction scores, what they offer) ===
${sanitizeForPrompt(trends.summary || "No landscape data")}

=== USER REVIEWS (what people HATE and what they LOVE — both matter) ===
${sanitizeForPrompt(pains.summary || "No review data")}

=== NEW CAPABILITIES (emerging tech, open source, behavior shifts) ===
${sanitizeForPrompt(capabilities.summary || "No capability data")}
${sanitizeForPrompt(deepSearchContext)}
${saturatedSection}

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
    systemPrompt:
      "You are a JSON API. You ONLY output valid JSON arrays. No markdown, no explanations, no preamble. Start your response with [ and end with ].",
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

// ── Main Synthesis ───────────────────────────────────────────────────────

export async function synthesizeFromTrends(input: {
  readonly trends: TrendData;
  readonly pains: ClusteredPains;
  readonly capabilities: CapabilityScan;
  readonly deepSearchContext: string;
  readonly saturatedThemes: string;
  readonly category: IdeaCategory;
  readonly maxIdeas: number;
  readonly model: string;
}): Promise<SynthesisResult> {
  const { trends, pains, capabilities, deepSearchContext, saturatedThemes, category, maxIdeas, model } = input;

  // ── Pass 1: Discover intersections ──────────────────────────────────
  let intersections: readonly IntersectionHypothesis[];

  try {
    intersections = await discoverIntersections(trends, pains, capabilities, model);
  } catch (err) {
    log.error("Pass 1 failed, falling back to single-pass synthesis", { err });
    return singlePassSynthesis(input);
  }

  if (intersections.length === 0) {
    log.warn("No intersections found in Pass 1, falling back to single-pass synthesis");
    return singlePassSynthesis(input);
  }

  // Take top 10 by signal strength
  const topIntersections = [...intersections]
    .sort((a, b) => b.signalStrength - a.signalStrength)
    .slice(0, Math.min(maxIdeas * 2, 10));

  log.info("Pass 1 complete — proceeding to Pass 2", {
    totalIntersections: intersections.length,
    selectedForDevelopment: topIntersections.length,
  });

  // ── Pass 2: Develop ideas from intersections ─────────────────────────
  let rawCandidates: readonly GeneratedIdeaCandidate[];

  try {
    rawCandidates = await developIdeas(topIntersections, category, saturatedThemes, deepSearchContext, model);
  } catch (err) {
    log.error("Pass 2 failed, falling back to single-pass synthesis", { err });
    return singlePassSynthesis(input);
  }

  if (rawCandidates.length === 0) {
    log.warn("No ideas developed in Pass 2, returning empty result");
    return { candidates: [], totalGenerated: 0 };
  }

  log.info("Pass 2 complete — proceeding to Pass 3", { count: rawCandidates.length });

  // ── Pass 3: Critique and score ───────────────────────────────────────
  let critiquedCandidates: readonly GeneratedIdeaCandidate[];

  try {
    critiquedCandidates = await critiqueIdeas(
      rawCandidates,
      trends.summary,
      pains.summary,
      capabilities.summary,
      model,
    );
  } catch (err) {
    log.error("Pass 3 failed, returning uncritiqued candidates", { err });
    critiquedCandidates = rawCandidates;
  }

  return {
    candidates: critiquedCandidates.slice(0, maxIdeas),
    totalGenerated: rawCandidates.length,
  };
}
