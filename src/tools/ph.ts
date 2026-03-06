import type { ToolDefinition } from "./types";
import type { MemoryManager } from "../memory/types";
import { getProducts, type PHProductRow } from "../sources/producthunt/store";
import { createSemanticSearchTool } from "./search-factory";
import { createDigestTool } from "./digest-factory";

function formatProduct(p: PHProductRow, i: number): string {
  const rank = p.rank ? `#${p.rank}` : "unranked";
  const topics = JSON.parse(p.topics_json || "[]") as string[];
  const topicStr = topics.length > 0 ? topics.join(", ") : "none";
  const makers = JSON.parse(p.makers_json || "[]") as Array<{
    username: string;
    name: string;
  }>;
  const makerStr =
    makers.length > 0
      ? makers.map((m) => `${m.name} (@${m.username})`).join(", ")
      : "unknown";
  const featured = p.featured_at
    ? new Date(p.featured_at * 1000).toISOString().slice(0, 10)
    : "N/A";

  return [
    `${i + 1}. ${p.name} (${rank}, ${p.votes_count} votes, ${p.comments_count} comments)`,
    `  Tagline: ${p.tagline}`,
    `  Description: ${p.description.slice(0, 300)}`,
    `  Topics: ${topicStr}`,
    `  Makers: ${makerStr}`,
    `  Featured: ${featured}`,
    `  Reviews: ${p.reviews_count} (${p.reviews_rating?.toFixed(1) ?? "N/A"} stars)`,
    `  PH: ${p.url}`,
    `  Website: ${p.website_url}`,
  ].join("\n");
}

export function createPHTools(
  memoryManager: MemoryManager | null,
): readonly ToolDefinition[] {
  const tools: ToolDefinition[] = [
    createDigestTool<PHProductRow>({
      name: "get_product_digest",
      description:
        "Get recent Product Hunt products with full details (votes, makers, topics, description). Use for browsing trending products, generating idea reports, or competitive analysis.",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Number of products to return (default 20, max 50).",
          },
        },
        required: [],
      },
      fetchFn: async (_input, limit) => getProducts(limit),
      formatFn: formatProduct,
      headerFn: (results) => `Product Hunt Digest (${results.length} products):\n`,
      emptyMessage: "No products found in the database.",
      errorPrefix: "Error retrieving products",
      defaultLimit: 20,
    }),
  ];

  if (memoryManager) {
    tools.unshift(
      createSemanticSearchTool({
        name: "search_products",
        description:
          "Semantic search over Product Hunt products. Use for finding product ideas, competitors, inspiration, or market research. Query with concepts like 'AI writing assistant' or 'developer productivity tools'.",
        agentId: "ph",
        kinds: ["product"],
        memoryManager,
        emptyMessage: "No matching products found.",
        errorPrefix: "Error searching products",
      }),
    );
  }

  return tools;
}
