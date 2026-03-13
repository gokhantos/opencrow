import type { ToolDefinition, ToolCategory } from "./types";
import type { SemanticToolIndex } from "./semantic-index";

interface ToolScore {
  tool: ToolDefinition;
  score: number;
}

interface ToolExecutionRecord {
  toolName: string;
  timestamp: number;
  success: boolean;
}

/**
 * ToolRouter - intelligent tool selection based on context
 *
 * Ranking algorithm:
 * - Category Match (40%): Based on detected user intent
 * - Recency Boost (25%): Tools used successfully recently
 * - Success Rate (20%): Historical success rate
 * - Keyword Match (15%): Tool name/description matching conversation keywords
 */
export class ToolRouter {
  private executionHistory: ToolExecutionRecord[] = [];
  private readonly maxHistorySize = 100;
  private readonly recencyWindowMs = 3600000; // 1 hour
  private semanticIndex: SemanticToolIndex | null = null;

  constructor(private tools: readonly ToolDefinition[]) {}

  /**
   * Attach a semantic index for embedding-based routing.
   */
  setSemanticIndex(index: SemanticToolIndex): void {
    this.semanticIndex = index;
  }

  /**
   * Record a tool execution result for history tracking
   */
  recordExecution(toolName: string, success: boolean): void {
    const record: ToolExecutionRecord = {
      toolName,
      timestamp: Date.now(),
      success,
    };
    const appended = [...this.executionHistory, record];
    this.executionHistory =
      appended.length > this.maxHistorySize
        ? appended.slice(-this.maxHistorySize)
        : appended;
  }

  /**
   * Get relevant tools from a raw message string.
   * Uses semantic index when available; falls back to keyword/category routing.
   */
  async getRelevantToolsForMessage(
    message: string,
    limit = 25,
  ): Promise<readonly ToolDefinition[]> {
    if (this.semanticIndex?.isAvailable()) {
      const names = await this.semanticIndex.search(message, limit);
      if (names.length > 0) {
        const nameSet = new Set(names);
        const matched = this.tools.filter((t) => nameSet.has(t.name));
        // Preserve semantic ranking order
        matched.sort((a, b) => names.indexOf(a.name) - names.indexOf(b.name));
        return matched;
      }
    }

    // Fallback: keyword/category routing
    const intent = ToolRouter.detectIntent(message);
    const keywords = ToolRouter.extractKeywords(message);
    return this.getRelevantTools(intent, keywords, limit);
  }

  /**
   * Get the most relevant tools for a given context
   */
  getRelevantTools(
    intent: readonly ToolCategory[],
    keywords: readonly string[],
    limit = 15,
  ): readonly ToolDefinition[] {
    const now = Date.now();

    // Score each tool
    const scored: ToolScore[] = this.tools.map((tool) => {
      let categoryScore = 0;
      let recencyScore = 0;
      let successScore = 0;
      let keywordScore = 0;

      // 1. Category Match (40%)
      if (intent.length > 0) {
        const matchingCategories = tool.categories.filter((c) =>
          intent.includes(c),
        );
        categoryScore = matchingCategories.length / Math.max(intent.length, 1);
      }

      // 2. Recency Boost (25%) - tools used successfully recently
      const recentExecutions = this.executionHistory.filter(
        (r) => r.toolName === tool.name && now - r.timestamp < this.recencyWindowMs,
      );
      if (recentExecutions.length > 0) {
        const successfulRecent = recentExecutions.filter((r) => r.success).length;
        recencyScore = successfulRecent / recentExecutions.length;
      }

      // 3. Success Rate (20%) - historical success rate
      const allExecutions = this.executionHistory.filter(
        (r) => r.toolName === tool.name,
      );
      if (allExecutions.length > 0) {
        const successful = allExecutions.filter((r) => r.success).length;
        successScore = successful / allExecutions.length;
      }

      // 4. Keyword Match (15%) - tool name/description matching keywords
      if (keywords.length > 0) {
        const toolText = `${tool.name} ${tool.description}`.toLowerCase();
        const keywordMatches = keywords.filter((k) =>
          toolText.includes(k.toLowerCase()),
        );
        keywordScore = keywordMatches.length / Math.max(keywords.length, 1);
      }

      // Calculate weighted total
      const totalScore =
        categoryScore * 0.4 +
        recencyScore * 0.25 +
        successScore * 0.2 +
        keywordScore * 0.15;

      return { tool, score: totalScore };
    });

    // Sort by score descending and return top tools
    scored.sort((a, b) => b.score - a.score);

    // Always include at least some tools even if score is 0
    const topTools = scored.slice(0, limit).map((s) => s.tool);

    // If we have fewer tools than limit, add some from the rest to ensure minimum coverage
    if (topTools.length < Math.min(10, limit)) {
      const remaining = scored
        .slice(limit)
        .map((s) => s.tool)
        .slice(0, Math.min(10, limit) - topTools.length);
      return [...topTools, ...remaining];
    }

    return topTools;
  }

  /**
   * Detect intent categories from conversation context
   */
  static detectIntent(message: string): readonly ToolCategory[] {
    const lower = message.toLowerCase();
    const intent: ToolCategory[] = [];

    // Research-related keywords
    if (
      /search|find|look|news|article|blog|reddit|hacker news|product hunt|github/.test(
        lower,
      )
    ) {
      intent.push("research");
    }

    // Code-related keywords
    if (
      /code|file|write|edit|read|function|class|implement|debug|error|bug|test/.test(
        lower,
      )
    ) {
      intent.push("code");
    }

    // Analytics/Metrics keywords
    if (
      /analytics|metrics|stats|performance|usage|cost|error rate|session|conversation/.test(
        lower,
      )
    ) {
      intent.push("analytics");
    }

    // File operations
    if (/file|directory|folder|list|glob|grep|search in files/.test(lower)) {
      intent.push("fileops");
    }

    // System operations
    if (/process|system|restart|cron|job|schedule/.test(lower)) {
      intent.push("system");
    }

    // Memory/Context
    if (/memory|remember|observation|preference|context/.test(lower)) {
      intent.push("memory");
    }

    // Social
    if (/twitter|x\.com|tweet|reddit post|discussion/.test(lower)) {
      intent.push("social");
    }

    return intent.length > 0 ? intent : ["research", "code"]; // Default to research + code
  }

  /**
   * Extract keywords from message
   */
  static extractKeywords(message: string): readonly string[] {
    // Simple keyword extraction - could be enhanced with NLP
    const words = message.split(/\s+/);
    const keywords: string[] = [];

    // Add significant words (longer than 3 chars, not common stopwords)
    const stopwords = new Set([
      "the",
      "and",
      "for",
      "that",
      "this",
      "with",
      "from",
      "have",
      "are",
      "was",
      "can",
      "will",
      "just",
      "get",
      "got",
      "need",
      "want",
      "could",
      "would",
      "should",
      "make",
      "does",
      "doing",
      "done",
    ]);

    for (const word of words) {
      const cleaned = word.replace(/[^a-zA-Z0-9-]/g, "").toLowerCase();
      if (cleaned.length > 3 && !stopwords.has(cleaned)) {
        keywords.push(cleaned);
      }
    }

    // Return top keywords
    return keywords.slice(0, 10);
  }

  /**
   * Get all available tools (for when routing is disabled or not needed)
   */
  getAllTools(): readonly ToolDefinition[] {
    return [...this.tools];
  }

  /**
   * Update tools list (useful when registry adds new tools)
   */
  setTools(tools: readonly ToolDefinition[]): void {
    this.tools = tools;
  }
}

/**
 * Create a tool router with the given tools
 */
export function createToolRouter(
  tools: readonly ToolDefinition[],
): ToolRouter {
  return new ToolRouter(tools);
}