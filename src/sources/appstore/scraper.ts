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
  type AppRankingRow,
  type AppReviewRow,
} from "./store";

import { getErrorMessage } from "../../lib/error-serialization";
import { loadScraperIntervalMs } from "../scraper-config";

const log = createLogger("appstore-scraper");

const DEFAULT_INTERVAL_MINUTES = 60;
const REQUEST_DELAY_MS = 2_000; // 2 seconds between API calls
const TOP_APPS_PER_LIST = 5; // fetch reviews for top N from each list/category
const DISCOVERY_LOOKUPS_PER_CYCLE = 3; // discover related apps for N random seeds per cycle

const APPSTORE_AGENT_ID = "appstore";

const TOP_FREE_URL =
  "https://rss.applemarketingtools.com/api/v2/us/apps/top-free/25/apps.json";
const TOP_PAID_URL =
  "https://rss.applemarketingtools.com/api/v2/us/apps/top-paid/25/apps.json";

const ITUNES_CATEGORIES: ReadonlyArray<{
  readonly id: number;
  readonly name: string;
}> = [
  { id: 6000, name: "Business" },
  { id: 6002, name: "Utilities" },
  { id: 6005, name: "Social Networking" },
  { id: 6007, name: "Productivity" },
  { id: 6012, name: "Lifestyle" },
  { id: 6013, name: "Health & Fitness" },
  { id: 6014, name: "Games" },
  { id: 6015, name: "Finance" },
  { id: 6016, name: "Entertainment" },
  { id: 6017, name: "Education" },
  { id: 6018, name: "Book" },
  { id: 6020, name: "Medical" },
  { id: 6023, name: "Food & Drink" },
  { id: 6024, name: "Shopping" },
  { id: 6026, name: "Travel" },
];

function reviewsUrl(appId: string): string {
  return `https://itunes.apple.com/us/rss/customerreviews/id=${appId}/sortBy=mostRecent/json`;
}

export interface AppStoreScraper {
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

interface RssAppEntry {
  readonly id?: {
    readonly label?: string;
    readonly attributes?: {
      readonly "im:id"?: string;
      readonly "im:bundleId"?: string;
    };
  };
  readonly "im:name"?: { readonly label?: string };
  readonly "im:artist"?: { readonly label?: string };
  readonly category?: {
    readonly attributes?: { readonly label?: string };
  };
  readonly "im:image"?: ReadonlyArray<{ readonly label?: string }>;
  readonly link?:
    | { readonly attributes?: { readonly href?: string } }
    | ReadonlyArray<{ readonly attributes?: { readonly href?: string } }>;
  readonly summary?: { readonly label?: string };
  readonly "im:price"?: {
    readonly attributes?: { readonly amount?: string };
  };
  readonly "im:releaseDate"?: {
    readonly attributes?: { readonly label?: string };
  };
}

interface RssReviewEntry {
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

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "OpenCrow/1.0 (App Store Scraper)",
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  return response.json();
}

interface RssV2App {
  readonly id?: string;
  readonly name?: string;
  readonly artistName?: string;
  readonly genres?: ReadonlyArray<{ readonly name?: string }>;
  readonly artworkUrl100?: string;
  readonly url?: string;
}

function parseTopAppsV2(
  data: unknown,
  listType: string,
): readonly AppRankingRow[] {
  const feed = (data as Record<string, unknown>)?.feed as
    | Record<string, unknown>
    | undefined;
  const results = (feed?.results ?? []) as readonly RssV2App[];
  const now = Math.floor(Date.now() / 1000);

  return results.map((app, index) => ({
    id: app.id ?? "",
    name: app.name ?? "",
    artist: app.artistName ?? "",
    category:
      (app.genres as ReadonlyArray<{ name?: string }> | undefined)?.[0]
        ?.name ?? "",
    rank: index + 1,
    list_type: listType,
    icon_url: app.artworkUrl100 ?? "",
    store_url: app.url ?? "",
    description: "",
    price: "",
    bundle_id: "",
    release_date: "",
    updated_at: now,
    indexed_at: null,
  }));
}

function itunesLinkHref(
  link:
    | { readonly attributes?: { readonly href?: string } }
    | ReadonlyArray<{ readonly attributes?: { readonly href?: string } }>
    | undefined,
): string {
  if (!link) return "";
  if (Array.isArray(link)) {
    return (link as ReadonlyArray<{ attributes?: { href?: string } }>)[0]
      ?.attributes?.href ?? "";
  }
  return (link as { attributes?: { href?: string } }).attributes?.href ?? "";
}

function parseTopAppsItunes(
  data: unknown,
  listType: string,
): readonly AppRankingRow[] {
  const feed = (data as Record<string, unknown>)?.feed as
    | Record<string, unknown>
    | undefined;
  if (!feed) return [];

  const rawEntries = feed.entry;
  if (!rawEntries) return [];

  const entries = (
    Array.isArray(rawEntries) ? rawEntries : [rawEntries]
  ) as readonly RssAppEntry[];

  const now = Math.floor(Date.now() / 1000);

  return entries.map((entry, index) => {
    const appId = entry.id?.attributes?.["im:id"] ?? "";
    const rawPrice = entry["im:price"]?.attributes?.amount ?? "";
    const price =
      rawPrice === "0" || rawPrice === "0.00000" ? "Free" : rawPrice;
    const images = entry["im:image"] ?? [];
    const iconUrl = images[images.length - 1]?.label ?? "";

    return {
      id: appId,
      name: entry["im:name"]?.label ?? "",
      artist: entry["im:artist"]?.label ?? "",
      category: entry.category?.attributes?.label ?? "",
      rank: index + 1,
      list_type: listType,
      icon_url: iconUrl,
      store_url: itunesLinkHref(entry.link),
      description: entry.summary?.label ?? "",
      price,
      bundle_id: entry.id?.attributes?.["im:bundleId"] ?? "",
      release_date: entry["im:releaseDate"]?.attributes?.label ?? "",
      updated_at: now,
      indexed_at: null,
    };
  });
}

function parseReviews(
  data: unknown,
  appId: string,
  appName: string,
): readonly AppReviewRow[] {
  const feed = (data as Record<string, unknown>)?.feed as
    | Record<string, unknown>
    | undefined;
  if (!feed) return [];

  const entries = (feed.entry ?? []) as readonly RssReviewEntry[];
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

function reviewsToAppReviewsForIndex(
  reviews: readonly AppReviewRow[],
): readonly AppReviewForIndex[] {
  return reviews.map((r) => ({
    id: `appstore-review-${r.id}`,
    appName: r.app_name,
    title: r.title,
    content: r.content,
    rating: r.rating,
    store: "appstore" as const,
    firstSeenAt: r.first_seen_at,
  }));
}

function rankingsToAppRankingsForIndex(
  rankings: readonly AppRankingRow[],
): readonly AppRankingForIndex[] {
  return rankings
    .filter((r) => r.description)
    .map((r) => ({
      id: `appstore-ranking-${r.id}-${r.list_type}`,
      name: r.name,
      artist: r.artist,
      category: r.category,
      price:
        r.price === "0.00000" || r.price === "0" || r.price === "Free"
          ? "Free"
          : "$" + r.price,
      storeUrl: r.store_url,
      description: r.description,
      store: "appstore" as const,
      updatedAt: r.updated_at,
    }));
}

export function createAppStoreScraper(config?: {
  memoryManager?: MemoryManager;
}): AppStoreScraper {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function fetchTopApps(
    url: string,
    listType: string,
  ): Promise<readonly AppRankingRow[]> {
    try {
      const data = await fetchJson(url);
      return parseTopAppsV2(data, listType);
    } catch (err) {
      const msg = getErrorMessage(err);
      log.warn("Failed to fetch top apps", { listType, error: msg });
      return [];
    }
  }

  async function fetchReviewsForApp(
    appId: string,
    appName: string,
  ): Promise<readonly AppReviewRow[]> {
    try {
      const data = await fetchJson(reviewsUrl(appId));
      return parseReviews(data, appId, appName);
    } catch (err) {
      const msg = getErrorMessage(err);
      log.warn("Failed to fetch reviews", { appId, appName, error: msg });
      return [];
    }
  }

  async function fetchRelatedApps(appId: string): Promise<readonly AppRankingRow[]> {
    try {
      const data = await fetchJson(
        `https://itunes.apple.com/lookup?id=${appId}&entity=software&limit=25`,
      ) as { results?: readonly Record<string, unknown>[] };

      const results = data.results ?? [];
      // First result is the app itself, rest are related
      const related = results.slice(1);
      const now = Math.floor(Date.now() / 1000);

      return related
        .filter((r) => r.trackId)
        .map((r) => ({
          id: String(r.trackId ?? ""),
          name: String(r.trackName ?? ""),
          artist: String(r.artistName ?? ""),
          category: String(r.primaryGenreName ?? ""),
          rank: 0,
          list_type: "discovered",
          icon_url: String(r.artworkUrl100 ?? ""),
          store_url: String(r.trackViewUrl ?? ""),
          description: String(r.description ?? "").slice(0, 2000),
          price: r.price === 0 ? "Free" : `$${r.price ?? 0}`,
          bundle_id: String(r.bundleId ?? ""),
          release_date: String(r.releaseDate ?? ""),
          updated_at: now,
          indexed_at: null,
        }));
    } catch (err) {
      const msg = getErrorMessage(err);
      log.warn("Failed to fetch related apps", { appId, error: msg });
      return [];
    }
  }

  async function indexUnindexedReviews(): Promise<void> {
    if (!config?.memoryManager) return;

    try {
      const unindexed = await getUnindexedReviews(200);
      if (unindexed.length === 0) return;

      const forIndex = reviewsToAppReviewsForIndex(unindexed);
      const ids = unindexed.map((r) => r.id);

      await config.memoryManager.indexAppReviews(APPSTORE_AGENT_ID, forIndex);
      await markReviewsIndexed(ids);

      log.info("Indexed reviews into memory", { count: ids.length });
    } catch (err) {
      log.error("Failed to index reviews into RAG", { error: err });
    }
  }

  async function indexUnindexedRankings(): Promise<void> {
    if (!config?.memoryManager) return;

    try {
      const unindexed = await getUnindexedRankings(200);
      if (unindexed.length === 0) return;

      const forIndex = rankingsToAppRankingsForIndex(unindexed);
      const ids = unindexed.map((r) => r.id);

      await config.memoryManager.indexAppRankings(APPSTORE_AGENT_ID, forIndex);
      await markRankingsIndexed(ids);

      log.info("Indexed rankings into memory", { count: ids.length });
    } catch (err) {
      log.error("Failed to index rankings into RAG", { error: err });
    }
  }

  async function scrape(): Promise<ScrapeResult> {
    try {
      // Fetch overall top-free and top-paid from Apple Marketing Tools API
      const [freeApps, paidApps] = await Promise.all([
        fetchTopApps(TOP_FREE_URL, "top-free"),
        fetchTopApps(TOP_PAID_URL, "top-paid"),
      ]);

      const overallRankings = [...freeApps, ...paidApps];
      let rankingsCount = await upsertRankings(overallRankings);

      log.info("Upserted overall app rankings", {
        free: freeApps.length,
        paid: paidApps.length,
      });

      // Fetch per-category rankings from iTunes RSS API (richer data)
      const categoryRankings: AppRankingRow[] = [];

      for (const cat of ITUNES_CATEGORIES) {
        await delay(REQUEST_DELAY_MS);

        const itunesUrl = `https://itunes.apple.com/us/rss/topfreeapplications/limit=25/genre=${cat.id}/json`;
        const listType = `top-free-${cat.id}`;

        try {
          const data = await fetchJson(itunesUrl);
          const apps = parseTopAppsItunes(data, listType);
          categoryRankings.push(...apps);
          log.info("Fetched iTunes category rankings", {
            category: cat.name,
            count: apps.length,
          });
        } catch (err) {
          const msg = getErrorMessage(err);
          log.warn("Failed to fetch iTunes category rankings", {
            category: cat.name,
            error: msg,
          });
        }
      }

      if (categoryRankings.length > 0) {
        const catCount = await upsertRankings(categoryRankings);
        rankingsCount += catCount;
        log.info("Upserted category rankings", {
          categories: ITUNES_CATEGORIES.length,
          total: catCount,
        });
      }

      // Build list of apps to fetch reviews for:
      // top N from overall lists + top N from each category
      const appsToReview: AppRankingRow[] = [
        ...freeApps.slice(0, TOP_APPS_PER_LIST),
        ...paidApps.slice(0, TOP_APPS_PER_LIST),
      ];

      // Add top N from each category (deduplicate by app id)
      const seenIds = new Set(appsToReview.map((a) => a.id));
      for (const cat of ITUNES_CATEGORIES) {
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

      for (const app of appsToReview) {
        if (!app.id) continue;

        await delay(REQUEST_DELAY_MS);

        const reviews = await fetchReviewsForApp(app.id, app.name);
        if (reviews.length > 0) {
          const count = await upsertReviews(reviews);
          totalReviews += count;
        }
      }

      log.info("Upserted app reviews", {
        appsChecked: appsToReview.length,
        reviews: totalReviews,
      });

      // Discovery: find related apps to expand the database
      try {
        const knownIds = await getAllKnownAppIds();
        const allRanked = [...freeApps, ...paidApps, ...categoryRankings].filter((a) => a.id);
        const seeds = allRanked.sort(() => Math.random() - 0.5).slice(0, DISCOVERY_LOOKUPS_PER_CYCLE);
        let discoveredCount = 0;

        for (const seed of seeds) {
          await delay(REQUEST_DELAY_MS);
          const related = await fetchRelatedApps(seed.id);
          const newApps = related.filter((a) => a.id && !knownIds.has(a.id));

          if (newApps.length > 0) {
            await upsertRankings(newApps);
            discoveredCount += newApps.length;
            for (const a of newApps) knownIds.add(a.id);
          }
        }

        if (discoveredCount > 0) {
          log.info("Discovered new App Store apps", { count: discoveredCount, seeds: seeds.length });
        }
      } catch (err) {
        log.warn("App Store discovery phase failed", { error: getErrorMessage(err) });
      }

      // Index unindexed content into memory
      await indexUnindexedReviews();
      await indexUnindexedRankings();

      return { ok: true, rankings: rankingsCount, reviews: totalReviews };
    } catch (err) {
      const msg = getErrorMessage(err);
      log.error("App Store scrape failed", { error: msg });
      return { ok: false, error: msg };
    }
  }

  async function tick(): Promise<void> {
    if (running) {
      log.info("App Store scrape already running, skipping");
      return;
    }

    running = true;
    try {
      await scrape();
    } catch (err) {
      const msg = getErrorMessage(err);
      log.error("App Store scrape error", { error: msg });
    } finally {
      running = false;
    }
  }

  return {
    async start() {
      if (timer) return;
      const intervalMs = await loadScraperIntervalMs("appstore", DEFAULT_INTERVAL_MINUTES);
      timer = setInterval(tick, intervalMs);
      log.info("App Store scraper started", { tickMs: intervalMs });
      tick().catch((err) =>
        log.error("App Store scraper first tick error", { error: err }),
      );
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
        log.info("App Store scraper stopped");
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
