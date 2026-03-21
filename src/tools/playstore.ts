import type { ToolDefinition } from "./types";
import type { MemoryManager } from "../memory/types";
import {
  getRankings,
  getRankingsByCategory,
  getLowRatedReviews,
  upsertApps,
  upsertReviews,
  type PlayRankingRow,
  type PlayReviewRow,
  type PlayAppRow,
} from "../sources/playstore/store";
import { createSemanticSearchTool } from "./search-factory";
import { createDigestTool } from "./digest-factory";
import { getEnum } from "./input-helpers";
import { createLogger } from "../logger";
import { getErrorMessage } from "../lib/error-serialization";

const log = createLogger("tool:search-playstore-apps");

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

interface GPlaySearchApp {
  readonly appId: string;
  readonly title: string;
  readonly developer: string;
  readonly icon: string;
  readonly url: string;
  readonly summary: string;
  readonly description: string;
  readonly price: number;
  readonly free: boolean;
  readonly scoreText: string | null;
  readonly score: number;
  readonly installs: string;
  readonly genre: string;
}

interface GPlayReview {
  readonly id: string;
  readonly userName: string;
  readonly score: number;
  readonly title: string;
  readonly text: string;
  readonly thumbsUp: number;
  readonly version: string;
}

interface GPlayReviewsResult {
  readonly data: readonly GPlayReview[];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mapGPlayAppToPlayAppRow(app: GPlaySearchApp): PlayAppRow {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: app.appId ?? "",
    name: app.title ?? "",
    developer: app.developer ?? "",
    category: app.genre ?? "",
    icon_url: app.icon ?? "",
    store_url: app.url ?? "",
    description: (app.description ?? app.summary ?? "").slice(0, 2000),
    price: app.free || app.price === 0 ? "Free" : `$${app.price}`,
    rating: app.score ?? null,
    installs: app.installs ?? "",
    updated_at: now,
    indexed_at: null,
  };
}

function formatSearchResult(app: PlayAppRow, i: number): string {
  const price =
    !app.price || app.price === "0" || app.price === "Free" ? "Free" : app.price;
  const rating = app.rating !== null ? ` ★${app.rating.toFixed(1)}` : "";
  const installs = app.installs ? ` | ${app.installs} installs` : "";
  const desc = app.description
    ? ` — ${app.description.slice(0, 150)}...`
    : "";
  return `${i + 1}. ${app.name} by ${app.developer} [${app.category}] ${price}${rating}${installs}${desc}\n   ${app.store_url}`;
}

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
    {
      name: "search_playstore_apps",
      description:
        "Search Google Play Store for apps by keyword. Uses the google-play-scraper library to fetch live results, persists them to the database, and optionally fetches reviews for the top results.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search keywords (e.g. 'meditation timer', 'budget tracker').",
          },
          limit: {
            type: "number",
            description: "Number of results to return (default 10, max 25).",
          },
          fetch_reviews: {
            type: "number",
            description:
              "Fetch reviews for the top N results (default 0, max 5). Adds ~4s per app.",
          },
        },
        required: ["query"],
      },
      categories: ["research"] as const,
      async execute(input) {
        const query = input.query as string;
        const limit = Math.min(
          typeof input.limit === "number" ? input.limit : 10,
          25,
        );
        const fetchReviewsCount = Math.min(
          typeof input.fetch_reviews === "number" ? input.fetch_reviews : 0,
          5,
        );

        try {
          const gplay = (
            (await import("google-play-scraper")) as unknown as {
              default: {
                search: (opts: Record<string, unknown>) => Promise<readonly GPlaySearchApp[]>;
                reviews: (opts: Record<string, unknown>) => Promise<GPlayReviewsResult>;
                sort: Record<string, number>;
              };
            }
          ).default;

          const results = await gplay.search({
            term: query,
            num: limit,
            country: "us",
            lang: "en",
          });

          if (results.length === 0) {
            return {
              output: `No Play Store results found for "${query}".`,
              isError: false,
            };
          }

          const appRows = results.map(mapGPlayAppToPlayAppRow);
          await upsertApps(appRows);
          log.info("Upserted Play Store search results", {
            query,
            count: appRows.length,
          });

          if (fetchReviewsCount > 0) {
            const topApps = appRows.slice(0, fetchReviewsCount);
            for (const app of topApps) {
              if (!app.id) continue;
              await delay(4_000);
              try {
                const reviewResult = await gplay.reviews({
                  appId: app.id,
                  sort: gplay.sort.NEWEST,
                  num: 50,
                  country: "us",
                  lang: "en",
                });

                const now = Math.floor(Date.now() / 1000);
                const reviews: readonly PlayReviewRow[] = reviewResult.data.map(
                  (r) => ({
                    id: r.id,
                    app_id: app.id,
                    app_name: app.name,
                    author: r.userName,
                    rating: r.score,
                    title: r.title ?? "",
                    content: r.text ?? "",
                    thumbs_up: r.thumbsUp ?? 0,
                    version: r.version ?? "",
                    first_seen_at: now,
                    indexed_at: null,
                  }),
                );

                if (reviews.length > 0) {
                  await upsertReviews(reviews);
                  log.info("Fetched reviews for Play Store app", {
                    appId: app.id,
                    appName: app.name,
                    count: reviews.length,
                  });
                }
              } catch (err) {
                log.warn("Failed to fetch reviews for Play Store app", {
                  appId: app.id,
                  error: getErrorMessage(err),
                });
              }
            }
          }

          const lines = appRows.map(formatSearchResult);
          const header = `Play Store Search: "${query}" (${appRows.length} results)\n\n`;
          return { output: header + lines.join("\n\n"), isError: false };
        } catch (err) {
          const msg = getErrorMessage(err);
          log.error("search_playstore_apps failed", { query, err });
          return { output: `Error searching Play Store: ${msg}`, isError: true };
        }
      },
    },
  ];

  if (memoryManager) {
    tools.unshift(
      createSemanticSearchTool({
        name: "search_playstore_reviews",
        description:
          "Semantic search over indexed Google Play Store reviews. Find user complaints and feedback about specific topics. Query like 'slow performance' or 'subscription pricing'.",
        agentId: "playstore",
        kinds: ["playstore_review"],
        memoryManager,
        emptyMessage: "No matching Play Store reviews found.",
        errorPrefix: "Error searching Play Store reviews",
      }),
    );
  }

  return tools;
}
