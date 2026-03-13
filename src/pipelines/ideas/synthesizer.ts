/**
 * Multi-pass AI synthesizer for the idea generation pipeline.
 *
 * Pass 1: Extract signals from aggregated data
 * Pass 2: Cross-reference signals, find patterns & gaps
 * Pass 3: Generate specific ideas from opportunity clusters
 */

import { chat } from "../../agent/chat";
import type { ConversationMessage, AgentOptions } from "../../agent/types";
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
    maxOutputTokens: 16000,
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

async function extractSignals(
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

async function analyzeSignals(
  signals: readonly ExtractedSignal[],
  category: IdeaCategory,
  model: string,
): Promise<AnalysisResult> {
  if (signals.length === 0) {
    return { signals: [], themes: [], gaps: [], totalSignals: 0 };
  }

  const prompt = `You are a strategic analyst. Given these extracted signals, perform cross-reference analysis.

${CATEGORY_CONTEXT[category]}

SIGNALS:
${JSON.stringify(signals, null, 2)}

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
    ...result,
    totalSignals: result.signals?.length ?? signals.length,
  };
}

// ── Pass 3: Idea Generation ─────────────────────────────────────────────

async function generateIdeas(
  analysis: AnalysisResult,
  category: IdeaCategory,
  maxIdeas: number,
  existingTitles: readonly string[],
  model: string,
): Promise<SynthesisResult> {
  const existingList =
    existingTitles.length > 0
      ? `\n\nEXISTING IDEAS (DO NOT duplicate these):\n${existingTitles.map((t) => `- ${t}`).join("\n")}`
      : "";

  const prompt = `You are a visionary product strategist and serial entrepreneur. Based on the following market analysis, generate ${maxIdeas} specific, actionable product ideas.

${CATEGORY_CONTEXT[category]}

ANALYSIS:
Top Themes: ${analysis.themes.join(", ")}
Market Gaps: ${analysis.gaps.join("; ")}
Key Signals: ${JSON.stringify(analysis.signals.slice(0, 15), null, 2)}
${existingList}

For each idea, provide:
- title: A catchy, memorable product name (2-4 words)
- summary: 2-3 sentences describing what it does and why it matters
- reasoning: Detailed reasoning (3-5 sentences): which signals led to this idea, why now, what's the competitive advantage
- sourcesUsed: Comma-separated list of data sources that informed this idea
- category: "${category}"
- qualityScore: Self-assessed quality score (1.0-5.0) based on:
  * Market demand (from complaint/pain point data)
  * Trend alignment (how many sources confirm this direction)
  * Feasibility (are building blocks available on GitHub?)
  * Competition gap (how poorly served is this niche currently?)
  * Uniqueness (how different from existing ideas)
- targetAudience: Who is this for? (1 sentence)
- keyFeatures: 3-5 key features as an array
- revenueModel: Monetization strategy (1 sentence)

Generate DIVERSE ideas - don't just focus on one theme. Cover multiple opportunity areas.

Return ONLY a JSON array:
\`\`\`json
[
  {
    "title": "string",
    "summary": "string",
    "reasoning": "string",
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
      "You are an elite product strategist who generates innovative, data-driven product ideas. Always respond with valid JSON.",
  });

  const candidates = parseJsonFromResponse<GeneratedIdeaCandidate[]>(
    response.text,
    [],
  );

  return {
    candidates,
    totalGenerated: candidates.length,
  };
}

// ── Main synthesizer entry point ────────────────────────────────────────

export interface SynthesizerInput {
  readonly aggregatedContext: string;
  readonly category: IdeaCategory;
  readonly maxIdeas: number;
  readonly existingTitles: readonly string[];
  readonly model: string;
}

export interface SynthesizerOutput {
  readonly analysis: AnalysisResult;
  readonly synthesis: SynthesisResult;
  readonly signalCount: number;
  readonly themeCount: number;
}

export async function synthesize(
  input: SynthesizerInput,
): Promise<SynthesizerOutput> {
  const { aggregatedContext, category, maxIdeas, existingTitles, model } = input;

  // Pass 1: Extract signals
  log.info("Pass 1: Extracting signals from collected data");
  const signals = await extractSignals(aggregatedContext, category, model);
  log.info("Signal extraction complete", { count: signals.length });

  // Pass 2: Cross-reference analysis
  log.info("Pass 2: Cross-referencing signals");
  const analysis = await analyzeSignals(signals, category, model);
  log.info("Analysis complete", {
    themes: analysis.themes.length,
    gaps: analysis.gaps.length,
  });

  // Pass 3: Generate ideas
  log.info("Pass 3: Generating ideas from analysis");
  const synthesis = await generateIdeas(
    analysis,
    category,
    maxIdeas,
    existingTitles,
    model,
  );
  log.info("Synthesis complete", { ideas: synthesis.totalGenerated });

  return {
    analysis,
    synthesis,
    signalCount: signals.length,
    themeCount: analysis.themes.length,
  };
}
