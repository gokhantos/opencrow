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

  const prompt = `You are a visionary product strategist and serial entrepreneur. Based on the following market analysis, generate ${maxIdeas} specific, actionable product ideas.

${CATEGORY_CONTEXT[category]}

ANALYSIS:
Top Themes: ${analysis.themes.join(", ")}
Market Gaps: ${(analysis.gaps ?? []).join("; ")}
Key Signals: ${JSON.stringify(analysis.signals.slice(0, 10), null, 2)}
${saturatedSection}

CRITICAL DIVERSITY RULES:
- Each idea MUST target a completely different market, user persona, and problem space
- No two ideas should use the same core technology or solve adjacent problems
- Avoid generic app categories (voice assistants, subscription trackers, security scanners)
- Think about UNIQUE intersections: combine signals from different sources in unexpected ways
- Prefer ideas that could NOT have been generated from app store complaints alone

For each idea, provide ALL of these fields:
- title: A catchy, memorable product name (2-4 words)
- summary: A full paragraph (4-6 sentences) describing what the product does, the core problem it solves, who it's for, and why it matters NOW. Be specific — don't be generic.
- reasoning: Detailed analysis (5-8 sentences): which specific signals and data points led to this idea, what trends converge here, why the timing is right, and what's the competitive advantage over existing solutions.
- designDescription: A full paragraph (4-6 sentences) describing the UX/UI vision: what does the app look like? What are the key screens? What's the user journey from first open to daily use? Describe the visual style, interaction patterns, and what makes it delightful to use.
- monetizationDetail: A full paragraph (3-5 sentences) on the business model: pricing tiers with specific dollar amounts, expected conversion rates, comparable apps and their revenue, estimated TAM (total addressable market), and path to profitability.
- sourceLinks: An array of 3-8 specific references from the data that inspired this idea. Each link must have "title" (descriptive label), "url" (the actual URL from the data), and "source" (which platform: hackernews, reddit, producthunt, github, appstore, playstore, news). ONLY use real URLs that appear in the data above — do NOT make up URLs.
- sourcesUsed: Comma-separated list of data source names
- category: "${category}"
- qualityScore: Quality score (1.0-5.0) based on: market demand, trend alignment, feasibility, competition gap, uniqueness
- targetAudience: Who is this for? Be specific (age range, profession, pain level).
- keyFeatures: 5-7 key features as an array — be specific, not generic
- revenueModel: One-line summary of the primary revenue model

Generate DIVERSE ideas across different themes. Each idea should feel like a real product pitch, not a vague concept.

Return ONLY a JSON array:
\`\`\`json
[
  {
    "title": "string",
    "summary": "string (full paragraph)",
    "reasoning": "string (detailed analysis)",
    "designDescription": "string (UX/UI vision paragraph)",
    "monetizationDetail": "string (business model paragraph)",
    "sourceLinks": [{"title": "string", "url": "string", "source": "string"}],
    "sourcesUsed": "string",
    "category": "${category}",
    "qualityScore": number,
    "targetAudience": "string",
    "keyFeatures": ["string"],
    "revenueModel": "string"
  }
]
\`\`\``;

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
