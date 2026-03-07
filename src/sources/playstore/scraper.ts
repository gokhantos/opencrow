import { createLogger } from "../../logger";
import type { MemoryManager, ArticleForIndex } from "../../memory/types";
import {
  upsertRankings,
  upsertReviews,
  getUnindexedReviews,
  markReviewsIndexed,
  getUnindexedRankings,
  markRankingsIndexed,
  type PlayRankingRow,
  type PlayReviewRow,
} from "./store";

const log = createLogger("playstore-scraper");

const TICK_INTERVAL_MS = 3_600_000; // 60 minutes
const REQUEST_DELAY_MS = 2_500; // 2.5 seconds between API calls
const TOP_APPS_PER_LIST = 5; // fetch reviews for top N from each list/category

const PLAYSTORE_AGENT_ID = "playstore";

const PLAY_CATEGORIES: ReadonlyArray<{
  readonly id: string;
  readonly name: string;
}> = [
  { id: "BUSINESS", name: "Business" },
  { id: "COMMUNICATION", name: "Communication" },
  { id: "EDUCATION", name: "Education" },
  { id: "ENTERTAINMENT", name: "Entertainment" },
  { id: "FINANCE", name: "Finance" },
  { id: "FOOD_AND_DRINK", name: "Food & Drink" },
  { id: "HEALTH_AND_FITNESS", name: "Health & Fitness" },
  { id: "LIFESTYLE", name: "Lifestyle" },
  { id: "PRODUCTIVITY", name: "Productivity" },
  { id: "SHOPPING", name: "Shopping" },
  { id: "SOCIAL", name: "Social" },
  { id: "TOOLS", name: "Tools" },
  { id: "TRAVEL_AND_LOCAL", name: "Travel & Local" },
  { id: "GAME", name: "Games" },
];

// Local interfaces for google-play-scraper response shapes
interface GPlayApp {
  readonly appId: string;
  readonly title: string;
  readonly developer: string;
  readonly icon: string;
  readonly url: string;
  readonly description: string;
  readonly price: number;
  readonly scoreText: string | null;
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

export interface PlayStoreScraper {
  start(): void;
  stop(): void;
  scrapeNow(): Promise<ScrapeResult>;
}

interface ScrapeResult {
  ok: boolean;
  rankings?: number;
  reviews?: number;
  error?: string;
}

function parseRating(scoreText: string | null): number | null {
  if (!scoreText) return null;
  const parsed = parseFloat(scoreText);
  return isNaN(parsed) ? null : parsed;
}

function mapAppToRanking(
  app: GPlayApp,
  rank: number,
  listType: string,
): PlayRankingRow {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: app.appId,
    name: app.title,
    developer: app.developer,
    category: app.genre,
    rank,
    list_type: listType,
    icon_url: app.icon,
    store_url: app.url,
    description: app.description ?? "",
    price: app.price === 0 ? "Free" : `$${app.price}`,
    rating: parseRating(app.scoreText),
    installs: app.installs ?? "",
    updated_at: now,
    indexed_at: null,
  };
}

function reviewsToArticlesForIndex(
  reviews: readonly PlayReviewRow[],
): readonly ArticleForIndex[] {
  return reviews.map((r) => ({
    id: `playstore-review-${r.id}`,
    title: `${r.app_name} Review: ${r.title}`,
    url: "",
    sourceName: "playstore",
    category: "app-review",
    content: `App: ${r.app_name} | Rating: ${r.rating}/5 | Review: ${r.title} - ${r.content}`,
    publishedAt: r.first_seen_at,
  }));
}

function rankingsToArticlesForIndex(
  rankings: readonly PlayRankingRow[],
): readonly ArticleForIndex[] {
  return rankings
    .filter((r) => r.description)
    .map((r) => ({
      id: `playstore-ranking-${r.id}-${r.list_type}`,
      title: `${r.name} by ${r.developer}`,
      url: r.store_url,
      sourceName: "playstore",
      category: "app-ranking",
      content: `App: ${r.name} | Category: ${r.category} | Price: ${r.price} | Installs: ${r.installs} | ${r.description}`,
      publishedAt: r.updated_at,
    }));
}

export function createPlayStoreScraper(config?: {
  memoryManager?: MemoryManager;
}): PlayStoreScraper {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function fetchList(
    collection: string,
    listType: string,
    categoryId?: string,
  ): Promise<readonly PlayRankingRow[]> {
    try {
      // Dynamic import to handle CJS module
      const gplay = (await import("google-play-scraper")) as unknown as {
        list: (opts: Record<string, unknown>) => Promise<readonly GPlayApp[]>;
        collection: Record<string, string>;
        category: Record<string, string>;
        sort: Record<string, number>;
      };

      const opts: Record<string, unknown> = {
        collection,
        num: 25,
        country: "us",
        lang: "en",
      };
      if (categoryId) {
        opts.category = categoryId;
      }

      const apps = await gplay.list(opts);
      return apps.map((app, index) => mapAppToRanking(app, index + 1, listType));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn("Failed to fetch Play Store list", { listType, error: msg });
      return [];
    }
  }

  async function fetchReviewsForApp(
    appId: string,
    appName: string,
  ): Promise<readonly PlayReviewRow[]> {
    try {
      const gplay = (await import("google-play-scraper")) as unknown as {
        reviews: (opts: Record<string, unknown>) => Promise<GPlayReviewsResult>;
        sort: Record<string, number>;
      };

      const result = await gplay.reviews({
        appId,
        sort: gplay.sort.NEWEST,
        num: 50,
        country: "us",
        lang: "en",
      });

      const now = Math.floor(Date.now() / 1000);
      return result.data.map((r) => ({
        id: r.id,
        app_id: appId,
        app_name: appName,
        author: r.userName,
        rating: r.score,
        title: r.title ?? "",
        content: r.text ?? "",
        thumbs_up: r.thumbsUp ?? 0,
        version: r.version ?? "",
        first_seen_at: now,
        indexed_at: null,
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn("Failed to fetch Play Store reviews", { appId, appName, error: msg });
      return [];
    }
  }

  async function indexUnindexedReviews(): Promise<void> {
    if (!config?.memoryManager) return;

    try {
      const unindexed = await getUnindexedReviews(200);
      if (unindexed.length === 0) return;

      const forIndex = reviewsToArticlesForIndex(unindexed);
      const ids = unindexed.map((r) => r.id);

      await config.memoryManager.indexArticles(PLAYSTORE_AGENT_ID, forIndex);
      await markReviewsIndexed(ids);

      log.info("Indexed Play Store reviews into memory", { count: ids.length });
    } catch (err) {
      log.error("Failed to index Play Store reviews into RAG", { error: err });
    }
  }

  async function indexUnindexedRankings(): Promise<void> {
    if (!config?.memoryManager) return;

    try {
      const unindexed = await getUnindexedRankings(200);
      if (unindexed.length === 0) return;

      const forIndex = rankingsToArticlesForIndex(unindexed);
      const ids = unindexed.map((r) => r.id);

      await config.memoryManager.indexArticles(PLAYSTORE_AGENT_ID, forIndex);
      await markRankingsIndexed(ids);

      log.info("Indexed Play Store rankings into memory", { count: ids.length });
    } catch (err) {
      log.error("Failed to index Play Store rankings into RAG", { error: err });
    }
  }

  async function scrape(): Promise<ScrapeResult> {
    try {
      const gplay = (await import("google-play-scraper")) as unknown as {
        collection: Record<string, string>;
      };

      const topFreeCollection = gplay.collection.TOP_FREE ?? "topselling_free";
      const topPaidCollection = gplay.collection.TOP_PAID ?? "topselling_paid";

      // Fetch overall top-free and top-paid
      const [freeApps, paidApps] = await Promise.all([
        fetchList(topFreeCollection, "top-free"),
        fetchList(topPaidCollection, "top-paid"),
      ]);

      const overallRankings = [...freeApps, ...paidApps];
      let rankingsCount = await upsertRankings(overallRankings);

      log.info("Upserted overall Play Store rankings", {
        free: freeApps.length,
        paid: paidApps.length,
      });

      // Fetch per-category rankings
      const categoryRankings: PlayRankingRow[] = [];

      for (const cat of PLAY_CATEGORIES) {
        await delay(REQUEST_DELAY_MS);

        const listType = `top-free-${cat.id}`;
        const apps = await fetchList(topFreeCollection, listType, cat.id);
        categoryRankings.push(...apps);

        log.info("Fetched Play Store category rankings", {
          category: cat.name,
          count: apps.length,
        });
      }

      if (categoryRankings.length > 0) {
        const catCount = await upsertRankings(categoryRankings);
        rankingsCount += catCount;
        log.info("Upserted Play Store category rankings", {
          categories: PLAY_CATEGORIES.length,
          total: catCount,
        });
      }

      // Build list of apps to fetch reviews for (top N from each list, deduplicated)
      const appsToReview: PlayRankingRow[] = [
        ...freeApps.slice(0, TOP_APPS_PER_LIST),
        ...paidApps.slice(0, TOP_APPS_PER_LIST),
      ];

      const seenIds = new Set(appsToReview.map((a) => a.id));
      for (const cat of PLAY_CATEGORIES) {
        const listType = `top-free-${cat.id}`;
        const catApps = categoryRankings
          .filter((a) => a.list_type === listType)
          .slice(0, TOP_APPS_PER_LIST);
        for (const app of catApps) {
          if (!seenIds.has(app.id)) {
            seenIds.add(app.id);
            appsToReview.push(app);
          }
        }
      }

      let totalReviews = 0;

      for (const app of appsToReview) {
        if (!app.id) continue;

        await delay(REQUEST_DELAY_MS);

        const reviews = await fetchReviewsForApp(app.id, app.name);
        if (reviews.length > 0) {
          const count = await upsertReviews(reviews);
          totalReviews += count;
        }
      }

      log.info("Upserted Play Store reviews", {
        appsChecked: appsToReview.length,
        reviews: totalReviews,
      });

      await indexUnindexedReviews();
      await indexUnindexedRankings();

      return { ok: true, rankings: rankingsCount, reviews: totalReviews };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("Play Store scrape failed", { error: msg });
      return { ok: false, error: msg };
    }
  }

  async function tick(): Promise<void> {
    if (running) {
      log.info("Play Store scrape already running, skipping");
      return;
    }

    running = true;
    try {
      await scrape();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("Play Store scrape error", { error: msg });
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, TICK_INTERVAL_MS);
      log.info("Play Store scraper started", { tickMs: TICK_INTERVAL_MS });
      tick().catch((err) =>
        log.error("Play Store scraper first tick error", { error: err }),
      );
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
        log.info("Play Store scraper stopped");
      }
    },

    async scrapeNow(): Promise<ScrapeResult> {
      if (running) {
        return { ok: false, error: "Already running" };
      }

      running = true;
      try {
        return await scrape();
      } finally {
        running = false;
      }
    },
  };
}
