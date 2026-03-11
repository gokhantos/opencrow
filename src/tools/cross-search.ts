import type { ToolDefinition, ToolCategory } from "./types";
import type { MemoryManager, MemorySourceKind } from "../memory/types";
import { NEWS_KINDS } from "../memory/types";
import { requireString, getNumber, isToolError } from "./input-helpers";

const SEARCHABLE_KINDS: readonly MemorySourceKind[] = [
  ...NEWS_KINDS,
  "hackernews_story",
  "reddit_post",
  "x_post",
  "producthunt_product",
  "github_repo",
  "appstore_review",
  "appstore_ranking",
  "playstore_review",
  "playstore_ranking",
];

const KIND_LABELS: Record<string, string> = {
  reuters_news: "Reuters",
  cointelegraph_news: "CoinTelegraph",
  cryptopanic_news: "CryptoPanic",
  investingnews_news: "Investing News",
  hackernews_story: "Hacker News",
  reddit_post: "Reddit",
  x_post: "X/Twitter",
  producthunt_product: "Product Hunt",
  github_repo: "GitHub",
  appstore_review: "App Store Reviews",
  appstore_ranking: "App Store Rankings",
  playstore_review: "Play Store Reviews",
  playstore_ranking: "Play Store Rankings",
};

function formatResult(r: {
  chunk: { content: string };
  score: number;
  source: { kind: MemorySourceKind; metadata: Readonly<Record<string, string>> };
}, i: number): string {
  const label = KIND_LABELS[r.source.kind] ?? r.source.kind;
  const title = r.source.metadata.title ?? "";
  const url = r.source.metadata.url ?? "";
  const header = title ? `${title}` : r.chunk.content.slice(0, 80);
  const urlLine = url ? `\n  URL: ${url}` : "";
  const snippet = r.chunk.content.slice(0, 250);
  return `${i + 1}. [${label}] ${header} (score: ${r.score.toFixed(2)})${urlLine}\n  ${snippet}`;
}

export function createCrossSourceSearchTool(
  memoryManager: MemoryManager,
): ToolDefinition {
  return {
    name: "cross_source_search",
    description:
      "Search across ALL indexed sources in one call: news, Hacker News, Reddit, X/Twitter, Product Hunt, GitHub. Returns results ranked by relevance with source labels. Use this instead of calling 5+ individual search tools when you need a broad sweep across sources.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural language search query.",
        },
        sources: {
          type: "array",
          items: {
            type: "string",
            enum: [...SEARCHABLE_KINDS],
          },
          description:
            "Optional: limit to specific sources. Omit to search all.",
        },
        limit: {
          type: "number",
          description: "Max total results across all sources (default 15, max 30).",
        },
      },
      required: ["query"],
    },
    categories: ["research"] as readonly ToolCategory[],
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const query = requireString(input, "query", { maxLength: 1000 });
      if (isToolError(query)) return query;

      const limit = getNumber(input, "limit", { defaultVal: 15, min: 1, max: 30 });
      const rawSources = input.sources as string[] | undefined;
      const kinds: readonly MemorySourceKind[] =
        rawSources && rawSources.length > 0
          ? (rawSources.filter((k) =>
              SEARCHABLE_KINDS.includes(k as MemorySourceKind),
            ) as MemorySourceKind[])
          : SEARCHABLE_KINDS;

      if (kinds.length === 0) {
        return { output: "No valid sources specified.", isError: true };
      }

      try {
        const results = await memoryManager.search("shared", query, {
          limit: limit * 2,
          kinds,
        });

        const top = results.slice(0, limit);

        if (top.length === 0) {
          const sourceList = kinds.map((k) => KIND_LABELS[k] ?? k).join(", ");
          return {
            output: `No results found across ${sourceList}.`,
            isError: false,
          };
        }

        // Count per source for header
        const counts = new Map<string, number>();
        for (const r of top) {
          const label = KIND_LABELS[r.source.kind] ?? r.source.kind;
          counts.set(label, (counts.get(label) ?? 0) + 1);
        }
        const breakdown = [...counts.entries()]
          .map(([src, n]) => `${src}: ${n}`)
          .join(", ");

        const header = `Cross-source search: ${top.length} results (${breakdown})\n`;
        const lines = top.map(formatResult);

        return { output: header + lines.join("\n\n"), isError: false };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { output: `Error in cross-source search: ${msg}`, isError: true };
      }
    },
  };
}
