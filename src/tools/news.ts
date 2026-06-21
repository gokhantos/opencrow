import type { ToolDefinition, ToolResult, ToolCategory } from "./types";
import type { MemoryManager } from "../memory/types";
import { getRecentArticles } from "../sources/news/store";
import type { NewsArticle } from "../sources/news/types";
import { createSemanticSearchTool } from "./search-factory";
import { getNumber, getEnum } from "./input-helpers";

function formatArticle(a: NewsArticle, i: number): string {
  const date = a.published_at || new Date(a.scraped_at * 1000).toISOString();
  const snippet = a.summary ? `\n  ${a.summary.slice(0, 200)}` : "";
  return `${i + 1}. [${a.source_name}] ${a.title}\n  Date: ${date}\n  URL: ${a.url}${snippet}`;
}

const NEWS_SOURCES = ["cryptopanic", "cointelegraph", "reuters", "investing_news"] as const;

function createGetNewsDigestTool(): ToolDefinition {
  return {
    name: "get_news_digest",
    description:
      "Get a digest of recent news articles grouped by source. Returns raw article data for you to synthesize into a briefing. Use this for daily summaries or catching up on recent developments.",
    inputSchema: {
      type: "object",
      properties: {
        hours: {
          type: "number",
          description: "How far back to look in hours (default 24, max 168).",
        },
        source: {
          type: "string",
          enum: ["cryptopanic", "cointelegraph", "reuters", "investing_news"],
          description: "Filter to a single source.",
        },
      },
      required: [],
    },
    categories: ["research"] as readonly ToolCategory[],
    async execute(input): Promise<ToolResult> {
      const hours = getNumber(input, "hours", { defaultVal: 24, min: 1, max: 168 });
      const source = getEnum(input, "source", NEWS_SOURCES);

      try {
        const articles = await getRecentArticles({
          hours,
          source,
          limit: 100,
        });

        if (articles.length === 0) {
          return {
            output: `No articles found in the last ${hours} hours.`,
            isError: false,
          };
        }

        // Group by source
        const bySource = new Map<string, NewsArticle[]>();
        for (const a of articles) {
          const group = bySource.get(a.source_name) ?? [];
          group.push(a);
          bySource.set(a.source_name, group);
        }

        const sections: string[] = [
          `News Digest (last ${hours}h, ${articles.length} articles):`,
        ];

        for (const [src, group] of bySource) {
          sections.push(`\n## ${src} (${group.length} articles)`);
          for (const [i, a] of group.entries()) {
            sections.push(formatArticle(a, i));
          }
        }

        return { output: sections.join("\n"), isError: false };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { output: `Error retrieving news digest: ${msg}`, isError: true };
      }
    },
  };
}

export function createNewsTools(
  memoryManager: MemoryManager | null,
): readonly ToolDefinition[] {
  const tools: ToolDefinition[] = [createGetNewsDigestTool()];

  if (memoryManager) {
    tools.unshift(
      createSemanticSearchTool({
        name: "search_news",
        description:
          "Semantic search over indexed news articles. Returns the most relevant articles ranked by meaning similarity to your query. Use natural language queries like 'Bitcoin ETF approval' or 'Fed interest rate decision'.",
        agentId: "shared",
        kinds: ["reuters_news", "cointelegraph_news", "cryptopanic_news", "investingnews_news"],
        memoryManager,
        extraInputFields: {
          source: {
            type: "string",
            enum: ["cryptopanic", "cointelegraph", "reuters", "investing_news"],
            description: "Filter by news source.",
          },
          hours: {
            type: "number",
            description: "Only articles from the last N hours.",
          },
        },
        fetchMultiplier: 2,
        postFilter: (results, input) => {
          const source = getEnum(input, "source", NEWS_SOURCES);
          const hours = getNumber(input, "hours", { defaultVal: 0, min: 0 });
          const cutoff = hours > 0 ? Math.floor(Date.now() / 1000) - hours * 3600 : 0;

          return results.filter((r) => {
            if (source && r.source.metadata?.sourceName !== source) return false;
            if (cutoff > 0 && r.source.createdAt < cutoff) return false;
            return true;
          });
        },
        formatResult: (r, i) => {
          const meta = r.source.metadata ?? {};
          const src = meta.sourceName ?? "unknown";
          const title = meta.title ?? "";
          const url = meta.url ?? "";
          return `${i + 1}. [${src}] ${title} (score: ${r.score.toFixed(2)})\n  URL: ${url}\n  ${r.chunk.content.slice(0, 300)}`;
        },
        emptyMessage: "No relevant articles found for that query.",
        errorPrefix: "Error searching news",
      }),
    );
  }

  return tools;
}
