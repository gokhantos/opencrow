import type { ToolDefinition } from "./types";
import type { MemoryManager } from "../memory/types";
import {
  getRankings,
  getRankingsByCategory,
  getLowRatedReviews,
  type PlayRankingRow,
  type PlayReviewRow,
} from "../sources/playstore/store";
import { createSemanticSearchTool } from "./search-factory";
import { createDigestTool } from "./digest-factory";
import { getEnum } from "./input-helpers";

function formatRanking(r: PlayRankingRow, i: number): string {
  const price =
    !r.price || r.price === "0" || r.price === "Free" ? "Free" : r.price;
  const rating = r.rating !== null ? ` ★${r.rating.toFixed(1)}` : "";
  const installs = r.installs ? ` | ${r.installs} installs` : "";
  const desc = r.description ? ` — ${r.description.slice(0, 100)}...` : "";
  return `${i + 1}. #${r.rank} ${r.name} by ${r.developer} [${r.category}] (${r.list_type}) ${price}${rating}${installs}${desc}`;
}

function formatReview(r: PlayReviewRow, i: number): string {
  const stars = "★".repeat(r.rating) + "☆".repeat(5 - r.rating);
  const snippet =
    r.content.length > 200 ? r.content.slice(0, 200) + "..." : r.content;
  return `${i + 1}. ${r.app_name} ${stars}\n  "${r.title}" — ${snippet}`;
}

const LIST_TYPES = ["top-free", "top-paid"] as const;

export function createPlayStoreTools(
  memoryManager: MemoryManager | null,
): readonly ToolDefinition[] {
  const tools: ToolDefinition[] = [
    createDigestTool<PlayRankingRow>({
      name: "get_playstore_rankings",
      description:
        "Get current Google Play Store top rankings. Shows top free and paid apps with category, rating, and install counts. Use to spot trending Android apps and identify market opportunities.",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Number of apps to return (default 25, max 50).",
          },
          list_type: {
            type: "string",
            enum: ["top-free", "top-paid"],
            description: "Filter by list type (overall charts only).",
          },
          category: {
            type: "string",
            description:
              "Filter by app category (e.g. 'Games', 'Finance', 'Productivity'). Returns category-specific rankings.",
          },
        },
        required: [],
      },
      fetchFn: async (input, limit) => {
        const category =
          typeof input.category === "string" ? input.category.trim() : "";
        if (category) {
          return getRankingsByCategory(category, limit);
        }
        const listType = getEnum(input, "list_type", LIST_TYPES);
        return getRankings(listType, limit);
      },
      formatFn: formatRanking,
      defaultLimit: 25,
      headerFn: (results) => `Play Store Rankings (${results.length} apps):\n`,
      emptyMessage: "No Play Store ranking data available yet.",
      errorPrefix: "Error retrieving Play Store rankings",
    }),
    createDigestTool<PlayReviewRow>({
      name: "get_playstore_complaints",
      description:
        "Get recent low-rated Google Play Store reviews (1-2 stars). Shows what users hate about top Android apps — goldmine for identifying pain points and building better alternatives.",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Number of reviews to return (default 30, max 50).",
          },
        },
        required: [],
      },
      fetchFn: async (_input, limit) => getLowRatedReviews(limit),
      formatFn: formatReview,
      headerFn: (results) =>
        `Low-Rated Play Store Reviews (${results.length} complaints):\n`,
      emptyMessage: "No low-rated Play Store reviews found yet.",
      errorPrefix: "Error retrieving Play Store reviews",
    }),
  ];

  if (memoryManager) {
    tools.unshift(
      createSemanticSearchTool({
        name: "search_playstore_reviews",
        description:
          "Semantic search over indexed Google Play Store reviews. Find user complaints and feedback about specific topics. Query like 'slow performance' or 'subscription pricing'.",
        agentId: "playstore",
        kinds: ["article"],
        memoryManager,
        emptyMessage: "No matching Play Store reviews found.",
        errorPrefix: "Error searching Play Store reviews",
      }),
    );
  }

  return tools;
}
