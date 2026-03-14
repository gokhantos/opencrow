/**
 * Multi-pass AI synthesizer for the idea generation pipeline.
 *
 * Pass 1: Extract signals from aggregated data
 * Pass 2: Cross-reference signals, find patterns & gaps
 * Pass 3: Generate specific ideas from opportunity clusters
 */

import { chat } from "../../agent/chat";
import type { ConversationMessage, AgentOptions } from "../../agent/types";
import type { MemoryManager, SearchResult } from "../../memory/types";
import { createLogger } from "../../logger";
import type { IdeaCategory } from "../types";
import type {
  AnalysisResult,
  ExtractedSignal,
  GeneratedIdeaCandidate,
  SynthesisResult,
} from "./types";

const log = createLogger("pipeline:synthesizer");

/**
 * Sanitize scraped content before inserting into AI prompts.
 * Strips patterns that could be used for prompt injection.
 */
function sanitizeForPrompt(text: string): string {
  return text
    // Strip backtick sequences that could close/open code blocks
    .replace(/`{3,}/g, "'''")
    // Strip instruction-like patterns
    .replace(/\b(ignore|disregard|forget)\s+(all\s+)?(previous|above|prior)\s+(instructions?|context|prompts?)\b/gi, "[filtered]")
    // Strip system/assistant role markers
    .replace(/<\/?(?:system|assistant|user|human)>/gi, "[filtered]")
    // Truncate individual items to prevent context stuffing
    .slice(0, 50000);
}

const CATEGORY_CONTEXT: Record<IdeaCategory, string> = {
  mobile_app:
    "You are generating mobile app ideas. Focus on iOS/Android apps that solve real user problems. Consider monetization, user acquisition, and app store competition.",
  crypto_project:
    "You are generating crypto/blockchain project ideas. Focus on DeFi, NFT, DAO, or infrastructure projects. Consider tokenomics, community building, and regulatory landscape.",
  ai_app:
    "You are generating AI application ideas. Focus on practical AI-powered tools and services. Consider model costs, data requirements, and competitive moats.",
  open_source:
    "You are generating open source project ideas. Focus on developer tools, libraries, and frameworks. Consider community adoption, maintenance burden, and ecosystem fit.",
  general:
    "You are generating general tech product ideas. Consider market size, competition, and feasibility.",
};

function buildChatOptions(model: string): AgentOptions {
  return {
    systemPrompt: "",
    model,
    provider: "agent-sdk",
    agentId: "idea-pipeline",
    usageContext: { channel: "pipeline", chatId: "ideas", source: "workflow" },
  };
}

function parseJsonFromResponse<T>(text: string, fallback: T): T {
  // Extract JSON from markdown code blocks or raw text
  const jsonMatch =
    text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/) ?? text.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);

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

// ── Pass 1: Signal Extraction ───────────────────────────────────────────

export async function extractSignals(
  aggregatedContext: string,
  category: IdeaCategory,
  model: string,
): Promise<readonly ExtractedSignal[]> {
  const sanitizedContext = sanitizeForPrompt(aggregatedContext);

  const prompt = `You are an expert trend analyst. Analyze the following data collected from multiple sources and extract actionable signals.

${CATEGORY_CONTEXT[category]}

DATA:
${sanitizedContext}

Extract 15-25 signals. For each signal, identify:
- theme: A short category label (e.g. "health-tracking", "ai-coding", "privacy-tools")
- type: One of "pain_point", "trend", "gap", "opportunity", "emerging_tech"
- description: 1-2 sentences describing the signal
- sources: Which data sources support this signal
- strength: 1-5 rating (5 = very strong cross-source signal)

Focus on:
1. PAIN POINTS: User complaints in app store reviews that indicate unmet needs
2. TRENDS: Topics appearing across multiple sources (HN + Reddit + PH = strong signal)
3. GAPS: Categories where existing apps have many complaints but no good alternatives
4. OPPORTUNITIES: New technologies or markets that lack good mobile/app solutions
5. EMERGING TECH: GitHub repos and HN discussions about new capabilities not yet in consumer apps

Return ONLY a JSON array of signals:
\`\`\`json
[
  {
    "theme": "string",
    "type": "pain_point|trend|gap|opportunity|emerging_tech",
    "description": "string",
    "sources": ["appstore", "reddit", ...],
    "strength": 1-5
  }
]
\`\`\``;

  const messages: ConversationMessage[] = [
    { role: "user", content: prompt, timestamp: Date.now() },
  ];

  const response = await chat(messages, {
    ...buildChatOptions(model),
    systemPrompt:
      "You are a data analyst specializing in market research and trend identification. Always respond with valid JSON.",
  });

  return parseJsonFromResponse<ExtractedSignal[]>(response.text, []);
}

// ── Pass 2: Cross-Reference & Gap Analysis ──────────────────────────────

export async function analyzeSignals(
  signals: readonly ExtractedSignal[],
  category: IdeaCategory,
  model: string,
  deepSearchContext?: string,
): Promise<AnalysisResult> {
  if (signals.length === 0) {
    return { signals: [], themes: [], gaps: [], totalSignals: 0 };
  }

  const deepSearchSection = deepSearchContext
    ? `\n\nADDITIONAL EVIDENCE FROM SEMANTIC SEARCH (searched the full indexed corpus for each theme):\n${deepSearchContext}`
    : "";

  const prompt = `You are a strategic analyst. Given these extracted signals AND the deep search results, perform cross-reference analysis.

${CATEGORY_CONTEXT[category]}

SIGNALS:
${JSON.stringify(signals, null, 2)}
${deepSearchSection}

Analyze these signals and:

1. GROUP signals by theme - which signals reinforce each other?
2. RANK themes by strength (themes appearing in 3+ sources are strongest)
3. IDENTIFY GAPS: Where are there strong pain points but no recent product launches addressing them?
4. IDENTIFY TOP OPPORTUNITIES: Combine trends + pain points + emerging tech into actionable opportunity clusters

Return a JSON object:
\`\`\`json
{
  "signals": [... the original signals, re-ranked by cross-source strength],
  "themes": ["theme1", "theme2", ...],
  "gaps": ["description of gap 1", "description of gap 2", ...],
  "totalSignals": number
}
\`\`\`

Prioritize themes where multiple signal types converge (e.g., a pain_point + trend + emerging_tech in the same domain = high priority).`;

  const messages: ConversationMessage[] = [
    { role: "user", content: prompt, timestamp: Date.now() },
  ];

  const response = await chat(messages, {
    ...buildChatOptions(model),
    systemPrompt:
      "You are a strategic market analyst. Identify patterns across multiple data sources. Always respond with valid JSON.",
  });

  const result = parseJsonFromResponse<AnalysisResult>(response.text, {
    signals,
    themes: [],
    gaps: [],
    totalSignals: signals.length,
  });

  return {
    signals: result.signals ?? signals,
    themes: result.themes ?? [],
    gaps: result.gaps ?? [],
    totalSignals: result.signals?.length ?? signals.length,
  };
}

// ── Pass 3: Idea Generation ─────────────────────────────────────────────

export async function generateIdeas(
  analysis: AnalysisResult,
  category: IdeaCategory,
  maxIdeas: number,
  saturatedThemes: string,
  model: string,
): Promise<SynthesisResult> {
  const saturatedSection = saturatedThemes
    ? `\n\nSATURATED THEMES — these have been explored extensively, DO NOT generate ideas in these areas:\n${saturatedThemes}\n\nYou MUST find COMPLETELY DIFFERENT angles. Think about underserved niches, emerging markets, and problems nobody is solving yet.`
    : "";

  const prompt = `You are a world-class entrepreneur who has built multiple $100M+ companies. You think INDEPENDENTLY — you don't just react to data, you see the future.

Your task: Invent ${maxIdeas} genuinely creative, original product ideas that could become real businesses.

${CATEGORY_CONTEXT[category]}

IMPORTANT: Do NOT just react to the data below. The data is context — it shows you what's happening in the market right now. Use it to VALIDATE your thinking, not to SOURCE your ideas. The best ideas come from YOUR creative insight about human needs, emerging behaviors, and technology intersections that nobody else sees yet.

Think about:
- What human behaviors are changing RIGHT NOW that create new needs?
- What's about to become possible that wasn't possible 6 months ago?
- What do people waste time/money on that could be 10x better?
- What problems do specific PROFESSIONS have that nobody builds for?
- What would you build if you had $500K and 6 months?

MARKET CONTEXT (use for validation, NOT as idea source):
Emerging themes: ${analysis.themes.join(", ")}
Unmet needs: ${(analysis.gaps ?? []).join("; ")}
${saturatedSection}

RULES:
- Each idea must be SURPRISING — if it's obvious from reading app store complaints, it's not good enough
- Each idea must target a SPECIFIC person (not "users" or "professionals" — name the exact job title, life situation, or demographic)
- Each idea must have a clear "why now" — what changed recently that makes this possible/necessary?
- NO generic tool/utility apps (no "tracker", "scanner", "guard", "monitor" apps)
- NO ideas that are just "existing thing but with AI"
- Each idea should make someone say "why doesn't this exist yet?"

For each idea provide:
- title: Memorable 2-3 word product name (creative, not descriptive)
- summary: Full paragraph (4-6 sentences). What is it? Who is it for specifically? What's the core insight? Why now?
- reasoning: Full paragraph (5-8 sentences). What creative insight led here? What's the "why now"? What's the unfair advantage? Why will this win?
- designDescription: Full paragraph (4-6 sentences). Key screens, user journey, visual style, what makes it delightful.
- monetizationDetail: Full paragraph (3-5 sentences). Pricing with specific dollar amounts, TAM, comparable revenue benchmarks, path to $1M ARR.
- sourceLinks: Array of references (can be empty if idea comes from creative insight rather than specific data). Each: {"title": "string", "url": "string", "source": "string"}
- sourcesUsed: Comma-separated source names that provided supporting context
- category: "${category}"
- qualityScore: 1.0-5.0 (be honest — 5.0 means "this is a unicorn idea")
- targetAudience: One specific sentence — name the person, not a category
- keyFeatures: 5-7 specific features
- revenueModel: One-line summary

Return ONLY a JSON array:
[
  {
    "title": "string",
    "summary": "string",
    "reasoning": "string",
    "designDescription": "string",
    "monetizationDetail": "string",
    "sourceLinks": [],
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
      "You are a JSON API. You ONLY output valid JSON arrays. No markdown, no explanations, no preamble. Just the raw JSON array. Start your response with [ and end with ].",
  });

  log.info("Pass 3 raw response", {
    length: response.text.length,
    preview: response.text.slice(0, 300),
    endsWithBracket: response.text.trimEnd().endsWith("]"),
  });

  let candidates = parseJsonFromResponse<GeneratedIdeaCandidate[]>(
    response.text,
    [],
  );

  // If first attempt failed, retry with an even more forceful prompt
  if (candidates.length === 0 && response.text.length > 0) {
    log.warn("Pass 3 returned no parseable JSON, retrying with simplified prompt");
    const retryPrompt = `The previous response was not valid JSON. I need ONLY a JSON array of product ideas. No other text.

Based on these themes: ${analysis.themes.join(", ")}
And these gaps: ${(analysis.gaps ?? []).join("; ")}

Generate ${maxIdeas} product ideas as a JSON array. Each object needs: title, summary, reasoning, designDescription, monetizationDetail, sourceLinks (empty array is fine), sourcesUsed, category ("${category}"), qualityScore (1-5), targetAudience, keyFeatures (array), revenueModel.

Respond with ONLY the JSON array, starting with [ and ending with ]:`;

    const retryResponse = await chat(
      [{ role: "user", content: retryPrompt, timestamp: Date.now() }],
      {
        ...buildChatOptions(model),
        systemPrompt: "Output only valid JSON. No other text.",
      },
    );

    log.info("Pass 3 retry response", {
      length: retryResponse.text.length,
      preview: retryResponse.text.slice(0, 300),
    });

    candidates = parseJsonFromResponse<GeneratedIdeaCandidate[]>(
      retryResponse.text,
      [],
    );
  }

  return {
    candidates,
    totalGenerated: candidates.length,
  };
}

// ── Semantic Deep Search ─────────────────────────────────────────────────

/**
 * After Pass 1 extracts themes from fresh data, do semantic search
 * across the ENTIRE indexed corpus (Qdrant) to find deeper evidence,
 * historical patterns, and supporting data the initial collection missed.
 */
export async function deepSearch(
  signals: readonly ExtractedSignal[],
  memoryManager: MemoryManager,
): Promise<string> {
  if (signals.length === 0) return "";

  // Build search queries from the top themes/signals
  const searchQueries = signals
    .slice(0, 8)
    .map((s) => `${s.theme}: ${s.description}`);

  // Search across all indexed source types in parallel
  const allKinds = [
    "hackernews_story",
    "reddit_post",
    "producthunt_product",
    "github_repo",
    "x_post",
    "reuters_news",
    "cointelegraph_news",
    "cryptopanic_news",
    "investingnews_news",
    "appstore_review",
    "appstore_app",
    "playstore_review",
    "playstore_app",
  ] as const;

  const searchPromises = searchQueries.map((query) =>
    memoryManager
      .search("shared", query, {
        limit: 5,
        minScore: 0.3,
        kinds: [...allKinds],
      })
      .catch(() => [] as readonly SearchResult[]),
  );

  const results = await Promise.all(searchPromises);

  // Deduplicate by source ID and format
  const seen = new Set<string>();
  const entries: string[] = [];

  for (let i = 0; i < searchQueries.length; i++) {
    const theme = signals[i]?.theme ?? "unknown";
    const hits = results[i] ?? [];
    const uniqueHits = hits.filter((h) => {
      const key = h.source.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (uniqueHits.length === 0) continue;

    const formatted = uniqueHits.map((h) => {
      const meta = h.source.metadata;
      const title = meta.title ?? meta.name ?? "";
      const url = meta.url ?? meta.hn_url ?? meta.store_url ?? "";
      const kind = h.source.kind;
      const score = h.score.toFixed(2);
      const content = h.chunk.content.slice(0, 300);
      return `  [${kind}, relevance: ${score}] ${title}${url ? `\n    URL: ${url}` : ""}\n    ${content}`;
    });

    entries.push(`--- Deep search: "${theme}" ---\n${formatted.join("\n")}`);
  }

  if (entries.length === 0) return "";

  log.info("Deep search complete", {
    queries: searchQueries.length,
    totalResults: seen.size,
  });

  return `\n\n=== DEEP SEARCH RESULTS (semantic search across full indexed corpus) ===\n${entries.join("\n\n")}`;
}

// ── Main synthesizer entry point ────────────────────────────────────────

export interface SynthesizerInput {
  readonly aggregatedContext: string;
  readonly category: IdeaCategory;
  readonly maxIdeas: number;
  readonly existingTitles: readonly string[];
  readonly model: string;
  readonly memoryManager?: MemoryManager | null;
}

export interface SynthesizerOutput {
  readonly analysis: AnalysisResult;
  readonly synthesis: SynthesisResult;
  readonly signalCount: number;
  readonly themeCount: number;
  readonly deepSearchResultCount: number;
}

export async function synthesize(
  input: SynthesizerInput,
): Promise<SynthesizerOutput> {
  const { aggregatedContext, category, maxIdeas, model, memoryManager } = input;

  // Pass 1: Extract signals from fresh collected data
  log.info("Pass 1: Extracting signals from collected data");
  const signals = await extractSignals(aggregatedContext, category, model);
  log.info("Signal extraction complete", { count: signals.length });

  // Pass 1.5: Semantic deep search — use extracted themes to search
  // the ENTIRE indexed corpus for deeper evidence and patterns
  let deepSearchContext = "";
  let deepSearchResultCount = 0;
  if (memoryManager && signals.length > 0) {
    log.info("Pass 1.5: Deep semantic search across indexed corpus");
    deepSearchContext = await deepSearch(signals, memoryManager);
    deepSearchResultCount = (deepSearchContext.match(/\[.*?, relevance:/g) ?? []).length;
    log.info("Deep search complete", { resultsFound: deepSearchResultCount });
  }

  // Pass 2: Cross-reference analysis (now enriched with deep search evidence)
  log.info("Pass 2: Cross-referencing signals + deep search results");
  const analysis = await analyzeSignals(signals, category, model, deepSearchContext || undefined);
  log.info("Analysis complete", {
    themes: analysis.themes.length,
    gaps: analysis.gaps.length,
  });

  // Pass 3: Generate ideas from analysis (deep search already fed into Pass 2)
  log.info("Pass 3: Generating ideas from analysis");
  const synthesis = await generateIdeas(
    analysis,
    category,
    maxIdeas,
    "", // no saturated themes when called via synthesize()
    model,
  );
  log.info("Synthesis complete", { ideas: synthesis.totalGenerated });

  return {
    analysis,
    synthesis,
    signalCount: signals.length,
    themeCount: analysis.themes.length,
    deepSearchResultCount,
  };
}
