import { createLogger } from "../../logger";
import type { MemoryManager, AppReviewForIndex, AppRankingForIndex } from "../../memory/types";
import {
  upsertRankings,
  upsertReviews,
  getRankings,
  getAllKnownAppIds,
  getUnindexedReviews,
  markReviewsIndexed,
  getUnindexedRankings,
  markRankingsIndexed,
  type PlayRankingRow,
  type PlayReviewRow,
  type PlayAppRow,
} from "./store";

import { getErrorMessage } from "../../lib/error-serialization";
import { loadScraperIntervalMs } from "../scraper-config";

const log = createLogger("playstore-scraper");

const DEFAULT_INTERVAL_MINUTES = 60;
const REQUEST_DELAY_MS = 4_000; // 4 seconds between API calls
const TOP_APPS_PER_LIST = 5; // fetch reviews for top N from each list/category
const DISCOVERY_LOOKUPS_PER_CYCLE = 3; // discover similar apps for N random seeds per cycle

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
// gplay.list() returns summary (short), gplay.app() returns full description
interface GPlayApp {
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

interface GPlayAppDetail {
  readonly appId: string;
  readonly description: string;
  readonly installs: string;
  readonly genre: string;
  readonly score: number;
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
    id: app.appId ?? "",
    name: app.title ?? "",
    developer: app.developer ?? "",
    category: app.genre ?? "",
    rank,
    list_type: listType,
    icon_url: app.icon ?? "",
    store_url: app.url ?? "",
    description: app.description ?? app.summary ?? "",
    price: app.free || app.price === 0 ? "Free" : `$${app.price}`,
    rating: app.score ?? parseRating(app.scoreText),
    installs: app.installs ?? "",
    updated_at: now,
    indexed_at: null,
  };
}

function reviewsToAppReviewsForIndex(
  reviews: readonly PlayReviewRow[],
): readonly AppReviewForIndex[] {
  return reviews.map((r) => ({
    id: `playstore-review-${r.id}`,
    appName: r.app_name,
    title: r.title,
    content: r.content,
    rating: r.rating,
    store: "playstore" as const,
    firstSeenAt: r.first_seen_at,
  }));
}

function rankingsToAppRankingsForIndex(
  rankings: readonly PlayAppRow[],
): readonly AppRankingForIndex[] {
  return rankings
    .map((r) => ({
      id: `playstore-ranking-${r.id}`,
      name: r.name,
      artist: r.developer,
      category: r.category,
      price: r.price,
      storeUrl: r.store_url,
      description: r.description,
      store: "playstore" as const,
      installs: r.installs,
      updatedAt: r.updated_at,
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
      const gplay = ((await import("google-play-scraper")) as unknown as { default: {
        list: (opts: Record<string, unknown>) => Promise<readonly GPlayApp[]>;
        collection: Record<string, string>;
        category: Record<string, string>;
        sort: Record<string, number>;
      } }).default;

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
      const msg = getErrorMessage(err);
      log.warn("Failed to fetch Play Store list", { listType, error: msg });
      return [];
    }
  }

  async function fetchAppDetail(appId: string): Promise<GPlayAppDetail | null> {
    try {
      const gplay = ((await import("google-play-scraper")) as unknown as { default: {
        app: (opts: Record<string, unknown>) => Promise<GPlayAppDetail>;
      } }).default;

      return await gplay.app({ appId, country: "us", lang: "en" });
    } catch (err) {
      const msg = getErrorMessage(err);
      log.warn("Failed to fetch app detail", { appId, error: msg });
      return null;
    }
  }

  async function fetchReviewsForApp(
    appId: string,
    appName: string,
  ): Promise<readonly PlayReviewRow[]> {
    try {
      const gplay = ((await import("google-play-scraper")) as unknown as { default: {
        reviews: (opts: Record<string, unknown>) => Promise<GPlayReviewsResult>;
        sort: Record<string, number>;
      } }).default;

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
      const msg = getErrorMessage(err);
      log.warn("Failed to fetch Play Store reviews", { appId, appName, error: msg });
      return [];
    }
  }

  async function fetchSimilarApps(appId: string): Promise<readonly PlayRankingRow[]> {
    try {
      const gplay = ((await import("google-play-scraper")) as unknown as { default: {
        similar: (opts: Record<string, unknown>) => Promise<readonly GPlayApp[]>;
      } }).default;

      const apps = await gplay.similar({ appId, num: 20, country: "us", lang: "en" });
      const now = Math.floor(Date.now() / 1000);
      return apps.map((app) => ({
        id: app.appId ?? "",
        name: app.title ?? "",
        developer: app.developer ?? "",
        category: app.genre ?? "",
        rank: 0,
        list_type: "discovered",
        icon_url: app.icon ?? "",
        store_url: app.url ?? "",
        description: app.description ?? app.summary ?? "",
        price: app.free || app.price === 0 ? "Free" : `$${app.price}`,
        rating: app.score ?? parseRating(app.scoreText),
        installs: app.installs ?? "",
        updated_at: now,
        indexed_at: null,
      }));
    } catch (err) {
      const msg = getErrorMessage(err);
      log.warn("Failed to fetch similar apps", { appId, error: msg });
      return [];
    }
  }

  async function indexUnindexedReviews(): Promise<void> {
    if (!config?.memoryManager) return;

    const MAX_ITERATIONS = 10;
    let iterations = 0;

    try {
      while (iterations < MAX_ITERATIONS) {
        const unindexed = await getUnindexedReviews(200);
        if (unindexed.length === 0) break;

        const forIndex = reviewsToAppReviewsForIndex(unindexed);
        const ids = unindexed.map((r) => r.id);

        await config.memoryManager.indexAppReviews(PLAYSTORE_AGENT_ID, forIndex);
        await markReviewsIndexed(ids);

        log.info("Indexed Play Store reviews into memory", { count: ids.length, iteration: iterations + 1 });
        iterations++;
      }
    } catch (err) {
      log.error("Failed to index Play Store reviews into RAG", { error: err });
    }
  }

  async function indexUnindexedRankings(): Promise<void> {
    if (!config?.memoryManager) return;

    const MAX_ITERATIONS = 10;
    let iterations = 0;

    try {
      while (iterations < MAX_ITERATIONS) {
        const unindexed = await getUnindexedRankings(200);
        if (unindexed.length === 0) break;

        const forIndex = rankingsToAppRankingsForIndex(unindexed);
        const ids = unindexed.map((r) => r.id);

        await config.memoryManager.indexAppRankings(PLAYSTORE_AGENT_ID, forIndex);
        await markRankingsIndexed(ids);

        log.info("Indexed Play Store rankings into memory", { count: ids.length, iteration: iterations + 1 });
        iterations++;
      }
    } catch (err) {
      log.error("Failed to index Play Store rankings into RAG", { error: err });
    }
  }

  async function scrape(): Promise<ScrapeResult> {
    try {
      const gplay = ((await import("google-play-scraper")) as unknown as { default: {
        collection: Record<string, string>;
      } }).default;

      const topFreeCollection = gplay.collection.TOP_FREE ?? "topselling_free";
      const topPaidCollection = gplay.collection.TOP_PAID ?? "topselling_paid";

      // Fetch overall top-free and top-paid (sequential to avoid rate limits)
      const freeApps = await fetchList(topFreeCollection, "top-free");
      await delay(REQUEST_DELAY_MS);
      const paidApps = await fetchList(topPaidCollection, "top-paid");

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
        try {
          const apps = await fetchList(topFreeCollection, listType, cat.id);
          categoryRankings.push(...apps);
          log.info("Fetched Play Store category", {
            category: cat.name,
            count: apps.length,
          });
        } catch (err) {
          const msg = getErrorMessage(err);
          log.warn("Play Store category fetch failed", { category: cat.name, error: msg });
        }
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

      // Also include discovered apps in review fetching
      const discoveredApps = await getRankings("discovered", TOP_APPS_PER_LIST);
      for (const app of discoveredApps) {
        if (!seenIds.has(app.id)) {
          seenIds.add(app.id);
          appsToReview.push(app);
        }
      }

      let totalReviews = 0;
      let enrichedCount = 0;

      log.info("Fetching Play Store details & reviews", { appsToReview: appsToReview.length });

      for (const app of appsToReview) {
        if (!app.id) continue;

        // Fetch full app details (description, installs, genre, rating)
        await delay(REQUEST_DELAY_MS);
        try {
          const detail = await fetchAppDetail(app.id);
          if (detail) {
            const enriched: PlayRankingRow = {
              ...app,
              description: detail.description?.slice(0, 2000) ?? app.description,
              installs: detail.installs ?? app.installs,
              category: detail.genre ?? app.category,
              rating: detail.score ?? app.rating,
            };
            await upsertRankings([enriched]);
            enrichedCount++;
          }
        } catch (err) {
          const msg = getErrorMessage(err);
          log.warn("Play Store detail fetch failed", { appId: app.id, error: msg });
        }

        // Fetch reviews
        await delay(REQUEST_DELAY_MS);
        try {
          const reviews = await fetchReviewsForApp(app.id, app.name);
          if (reviews.length > 0) {
            const count = await upsertReviews(reviews);
            totalReviews += count;
          }
        } catch (err) {
          const msg = getErrorMessage(err);
          log.warn("Play Store review fetch failed", { appId: app.id, error: msg });
        }
      }

      log.info("Upserted Play Store reviews & details", {
        appsChecked: appsToReview.length,
        enriched: enrichedCount,
        reviews: totalReviews,
      });

      // Discovery: find similar apps to expand the database
      try {
        const knownIds = await getAllKnownAppIds();
        const allRanked = [...overallRankings, ...categoryRankings].filter((a) => a.id);
        const seeds = allRanked.sort(() => Math.random() - 0.5).slice(0, DISCOVERY_LOOKUPS_PER_CYCLE);
        let discoveredCount = 0;

        for (const seed of seeds) {
          await delay(REQUEST_DELAY_MS);
          const similar = await fetchSimilarApps(seed.id);
          const newApps = similar.filter((a) => a.id && !knownIds.has(a.id));

          if (newApps.length > 0) {
            await upsertRankings(newApps);
            discoveredCount += newApps.length;
            for (const a of newApps) knownIds.add(a.id);
          }
        }

        if (discoveredCount > 0) {
          log.info("Discovered new Play Store apps", { count: discoveredCount, seeds: seeds.length });
        }
      } catch (err) {
        log.warn("Play Store discovery phase failed", { error: getErrorMessage(err) });
      }

      await indexUnindexedReviews();
      await indexUnindexedRankings();

      return { ok: true, rankings: rankingsCount, reviews: totalReviews };
    } catch (err) {
      const msg = getErrorMessage(err);
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
      const msg = getErrorMessage(err);
      log.error("Play Store scrape error", { error: msg });
    } finally {
      running = false;
    }
  }

  return {
    async start() {
      if (timer) return;
      const intervalMs = await loadScraperIntervalMs("playstore", DEFAULT_INTERVAL_MINUTES);
      timer = setInterval(tick, intervalMs);
      log.info("Play Store scraper started", { tickMs: intervalMs });
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
