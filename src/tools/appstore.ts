import type { ToolDefinition } from "./types";
import type { MemoryManager } from "../memory/types";
import {
  getRankings,
  getRankingsByCategory,
  getLowRatedReviews,
  upsertApps,
  upsertReviews,
  type AppRankingRow,
  type AppReviewRow,
  type AppRow,
} from "../sources/appstore/store";
import { createSemanticSearchTool } from "./search-factory";
import { createDigestTool } from "./digest-factory";
import { getEnum } from "./input-helpers";
import { createLogger } from "../logger";
import { getErrorMessage } from "../lib/error-serialization";

const log = createLogger("tool:search-appstore-apps");

function formatRanking(r: AppRankingRow, i: number): string {
  const price =
    !r.price || r.price === "0.00000" || r.price === "0" || r.price === "Free"
      ? "Free"
      : `$${r.price}`;
  const desc = r.description ? ` — ${r.description.slice(0, 100)}...` : "";
  return `${i + 1}. #${r.rank} ${r.name} by ${r.artist} [${r.category}] (${r.list_type}) ${price}${desc}`;
}

function formatReview(r: AppReviewRow, i: number): string {
  const stars = "★".repeat(r.rating) + "☆".repeat(5 - r.rating);
  const snippet = r.content.length > 200 ? r.content.slice(0, 200) + "..." : r.content;
  return `${i + 1}. ${r.app_name} ${stars}\n  "${r.title}" — ${snippet}`;
}

const LIST_TYPES = ["top-free", "top-paid"] as const;

interface ItunesSearchResult {
  readonly trackId?: number;
  readonly trackName?: string;
  readonly artistName?: string;
  readonly primaryGenreName?: string;
  readonly artworkUrl512?: string;
  readonly artworkUrl100?: string;
  readonly trackViewUrl?: string;
  readonly description?: string;
  readonly formattedPrice?: string;
  readonly price?: number;
}

interface ItunesReviewEntry {
  readonly id?: { readonly label?: string };
  readonly author?: { readonly name?: { readonly label?: string } };
  readonly "im:rating"?: { readonly label?: string };
  readonly title?: { readonly label?: string };
  readonly content?: { readonly label?: string };
  readonly "im:version"?: { readonly label?: string };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mapItunesResultToAppRow(r: ItunesSearchResult): AppRow {
  const now = Math.floor(Date.now() / 1000);
  const rawPrice = r.formattedPrice ?? (r.price === 0 ? "Free" : r.price ? `$${r.price}` : "Free");
  return {
    id: String(r.trackId ?? ""),
    name: String(r.trackName ?? ""),
    artist: String(r.artistName ?? ""),
    category: String(r.primaryGenreName ?? ""),
    icon_url: String(r.artworkUrl512 ?? r.artworkUrl100 ?? ""),
    store_url: String(r.trackViewUrl ?? ""),
    description: String(r.description ?? "").slice(0, 2000),
    price: rawPrice,
    bundle_id: "",
    release_date: "",
    updated_at: now,
    indexed_at: null,
  };
}

function parseItunesReviews(
  data: unknown,
  appId: string,
  appName: string,
): readonly AppReviewRow[] {
  const feed = (data as Record<string, unknown>)?.feed as
    | Record<string, unknown>
    | undefined;
  if (!feed) return [];

  const rawEntries = feed.entry;
  if (!rawEntries) return [];

  const entries = (
    Array.isArray(rawEntries) ? rawEntries : [rawEntries]
  ) as readonly ItunesReviewEntry[];

  const now = Math.floor(Date.now() / 1000);

  return entries
    .filter((e) => e.id?.label)
    .map((entry) => ({
      id: entry.id?.label ?? "",
      app_id: appId,
      app_name: appName,
      author: entry.author?.name?.label ?? "",
      rating: parseInt(entry["im:rating"]?.label ?? "0", 10),
      title: entry.title?.label ?? "",
      content: entry.content?.label ?? "",
      version: entry["im:version"]?.label ?? "",
      first_seen_at: now,
      indexed_at: null,
    }));
}

function formatSearchResult(app: AppRow, i: number): string {
  const price =
    !app.price || app.price === "0.00000" || app.price === "0" || app.price === "Free"
      ? "Free"
      : app.price.startsWith("$") ? app.price : `$${app.price}`;
  const desc = app.description
    ? ` — ${app.description.slice(0, 150)}...`
    : "";
  return `${i + 1}. ${app.name} by ${app.artist} [${app.category}] ${price}${desc}\n   ${app.store_url}`;
}

export function createAppStoreTools(
  memoryManager: MemoryManager | null,
): readonly ToolDefinition[] {
  const tools: ToolDefinition[] = [
    createDigestTool<AppRankingRow>({
      name: "get_appstore_rankings",
      description:
        "Get current App Store top rankings (US). Shows top free and paid apps with category and rank. Use to spot trending apps and identify market opportunities.",
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
              "Filter by app category (e.g. 'Games', 'Finance', 'Health & Fitness'). Returns category-specific rankings.",
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
      headerFn: (results) =>
        `App Store Rankings (${results.length} apps):\n`,
      emptyMessage: "No App Store ranking data available yet.",
      errorPrefix: "Error retrieving App Store rankings",
    }),
    createDigestTool<AppReviewRow>({
      name: "get_appstore_complaints",
      description:
        "Get recent low-rated App Store reviews (1-2 stars). Shows what users hate about top apps — goldmine for identifying pain points and building better alternatives.",
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
        `Low-Rated App Reviews (${results.length} complaints):\n`,
      emptyMessage: "No low-rated reviews found yet.",
      errorPrefix: "Error retrieving App Store reviews",
    }),
    {
      name: "search_appstore_apps",
      description:
        "Search the Apple App Store for apps by keyword. Fetches live results from the iTunes Search API, persists them to the database, and optionally fetches reviews for the top results.",
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
              "Fetch reviews for the top N results (default 0, max 5). Adds ~2s per app.",
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
          const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=software&limit=${limit}&country=us`;
          const response = await fetch(url, {
            headers: {
              "User-Agent": "OpenCrow/1.0 (App Store Tool)",
              Accept: "application/json",
            },
          });

          if (!response.ok) {
            throw new Error(`iTunes API returned HTTP ${response.status}`);
          }

          const data = (await response.json()) as {
            results?: readonly ItunesSearchResult[];
          };
          const results = data.results ?? [];

          if (results.length === 0) {
            return { output: `No App Store results found for "${query}".`, isError: false };
          }

          const appRows = results
            .filter((r) => r.trackId)
            .map(mapItunesResultToAppRow);

          await upsertApps(appRows);
          log.info("Upserted App Store search results", {
            query,
            count: appRows.length,
          });

          if (fetchReviewsCount > 0) {
            const topApps = appRows.slice(0, fetchReviewsCount);
            for (const app of topApps) {
              if (!app.id) continue;
              await delay(2_000);
              try {
                const reviewsUrl = `https://itunes.apple.com/us/rss/customerreviews/id=${app.id}/sortBy=mostRecent/json`;
                const reviewResp = await fetch(reviewsUrl, {
                  headers: {
                    "User-Agent": "OpenCrow/1.0 (App Store Tool)",
                    Accept: "application/json",
                  },
                });
                if (reviewResp.ok) {
                  const reviewData = await reviewResp.json();
                  const reviews = parseItunesReviews(reviewData, app.id, app.name);
                  if (reviews.length > 0) {
                    await upsertReviews(reviews);
                    log.info("Fetched reviews for app", {
                      appId: app.id,
                      appName: app.name,
                      count: reviews.length,
                    });
                  }
                }
              } catch (err) {
                log.warn("Failed to fetch reviews for app", {
                  appId: app.id,
                  error: getErrorMessage(err),
                });
              }
            }
          }

          const lines = appRows.map(formatSearchResult);
          const header = `App Store Search: "${query}" (${appRows.length} results)\n\n`;
          return { output: header + lines.join("\n\n"), isError: false };
        } catch (err) {
          const msg = getErrorMessage(err);
          log.error("search_appstore_apps failed", { query, err });
          return { output: `Error searching App Store: ${msg}`, isError: true };
        }
      },
    },
  ];

  if (memoryManager) {
    tools.unshift(
      createSemanticSearchTool({
        name: "search_appstore_reviews",
        description:
          "Semantic search over indexed App Store reviews. Find user complaints and feedback about specific topics. Query like 'slow performance' or 'subscription pricing'.",
        agentId: "appstore",
        kinds: ["appstore_review"],
        memoryManager,
        emptyMessage: "No matching reviews found.",
        errorPrefix: "Error searching App Store reviews",
      }),
    );
  }

  return tools;
}
