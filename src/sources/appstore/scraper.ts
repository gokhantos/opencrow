import { loadConfig } from "../../config/loader";
import type { AppstoreSyncListType } from "../../config/schema";
import { createLogger } from "../../logger";
import type { MemoryManager, AppReviewForIndex, AppRankingForIndex } from "../../memory/types";
import { runKeywordSweep } from "./keyword-gaps";
import { mineKeywords } from "./keyword-miner";
import {
  upsertRankings,
  upsertReviews,
  getRankings,
  getDiscoveredAppIds,
  getUnindexedReviews,
  markReviewsIndexed,
  getUnindexedRankings,
  markRankingsIndexed,
  type AppRankingRow,
  type AppReviewRow,
  type AppRow,
} from "./store";

import { getErrorMessage } from "../../lib/error-serialization";
import { loadScraperIntervalMs } from "../scraper-config";
import { fetchWithTimeout } from "../shared/fetch-with-timeout";

const log = createLogger("appstore-scraper");

const DEFAULT_INTERVAL_MINUTES = 60;
const REQUEST_TIMEOUT_MS = 20_000;
const REQUEST_DELAY_MS = 2_000; // 2 seconds between API calls
const TOP_APPS_PER_LIST = 5; // fetch reviews for top N from each list/category
const DISCOVERY_LOOKUPS_PER_CYCLE = 3; // discover related apps for N random seeds per cycle
const KEYWORD_MINING_SCAN_LIMIT = 3000; // ranking rows scanned for keyword candidates per cycle

const APPSTORE_AGENT_ID = "appstore";

// NOTE: genre 6026 was previously mislabeled "Travel" in this list — verified
// live against the iTunes RSS feed, 6026 actually returns Developer Tools
// (e.g. TestFlight). Corrected below; the real Travel genre id is 6003
// (verified separately, added as a new entry).
//
// Every id below was verified live (curl against
// itunes.apple.com/us/rss/topfreeapplications/.../genre=<id>/json) to return
// non-empty, correctly-labeled entries before being trusted here.
const ITUNES_CATEGORIES: ReadonlyArray<{
  readonly id: number;
  readonly name: string;
}> = [
  { id: 6000, name: "Business" },
  { id: 6001, name: "Weather" },
  { id: 6002, name: "Utilities" },
  { id: 6003, name: "Travel" },
  { id: 6004, name: "Sports" },
  { id: 6005, name: "Social Networking" },
  { id: 6006, name: "Reference" },
  { id: 6007, name: "Productivity" },
  { id: 6008, name: "Photo & Video" },
  { id: 6009, name: "News" },
  { id: 6010, name: "Navigation" },
  { id: 6011, name: "Music" },
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
  { id: 6026, name: "Developer Tools" },
];

// Maps a sync list type to its iTunes RSS URL segment. All three verified
// live to return distinct, non-empty per-genre rankings.
const ITUNES_LIST_TYPE_URL_SEGMENT: Record<AppstoreSyncListType, string> = {
  "top-free": "topfreeapplications",
  "top-paid": "toppaidapplications",
  "top-grossing": "topgrossingapplications",
};

/** Pure URL builder for a per-category (genre) iTunes RSS chart request. */
export function buildCategoryRankingUrl(
  genreId: number,
  listType: AppstoreSyncListType,
  limit: number,
): string {
  const segment = ITUNES_LIST_TYPE_URL_SEGMENT[listType];
  return `https://itunes.apple.com/us/rss/${segment}/limit=${limit}/genre=${genreId}/json`;
}

/** The `list_type` tag stored/queried for a given genre + sync list type. */
export function categoryListTypeTag(genreId: number, listType: AppstoreSyncListType): string {
  return `${listType}-${genreId}`;
}

/**
 * Pure URL builder for the GLOBAL (cross-category) top-free/top-paid feed,
 * served by rss.applemarketingtools.com — a different API from the
 * per-category iTunes RSS above. That API hard-errors (HTTP 500) above
 * limit=100 (verified live); callers must clamp `limit` accordingly.
 */
export function buildGlobalTopAppsUrl(
  listType: "top-free" | "top-paid",
  limit: number,
): string {
  return `https://rss.applemarketingtools.com/api/v2/us/apps/${listType}/${limit}/apps.json`;
}

/**
 * Drops duplicate (app id, list_type) pairs, keeping the first occurrence.
 * Cheap defensive dedup for a single scrape cycle's accumulated rankings —
 * an app can legitimately appear in many different list_types (e.g. once per
 * genre/list-type it charts in), but should only be upserted once per
 * distinct list_type per cycle.
 */
export function dedupeRankingsByListKey(
  rows: readonly AppRankingRow[],
): readonly AppRankingRow[] {
  const seen = new Set<string>();
  const result: AppRankingRow[] = [];
  for (const row of rows) {
    if (!row.id) continue;
    const key = `${row.id}|${row.list_type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(row);
  }
  return result;
}

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
  const response = await fetchWithTimeout(
    url,
    {
      headers: {
        "User-Agent": "OpenCrow/1.0 (App Store Scraper)",
        Accept: "application/json",
      },
    },
    REQUEST_TIMEOUT_MS,
  );

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
  rankings: readonly AppRow[],
): readonly AppRankingForIndex[] {
  return rankings
    .map((r) => ({
      id: `appstore-ranking-${r.id}`,
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
  // Independent timer for the keyword-gap sweep — decoupled from the
  // ~hourly ranking `timer`/`tick` above so it can run on its own, much
  // faster cadence (`appstoreKeywordGap.scanIntervalMs`, default 5 min).
  let keywordSweepTimer: ReturnType<typeof setInterval> | null = null;
  let keywordSweepRunning = false;

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

  function parseItunesResult(r: Record<string, unknown>): AppRankingRow {
    const now = Math.floor(Date.now() / 1000);
    return {
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
    };
  }

  async function fetchRelatedApps(appId: string): Promise<readonly AppRankingRow[]> {
    try {
      // Step 1: Look up the seed app to get its artistId and genre
      const lookupData = await fetchJson(
        `https://itunes.apple.com/lookup?id=${appId}`,
      ) as { results?: readonly Record<string, unknown>[] };

      const seedApp = (lookupData.results ?? [])[0];
      if (!seedApp) return [];

      const artistId = seedApp.artistId as number | undefined;
      const genre = seedApp.primaryGenreName as string | undefined;
      const discovered: AppRankingRow[] = [];

      // Step 2: Fetch other apps by the same developer
      if (artistId) {
        await delay(REQUEST_DELAY_MS);
        const artistData = await fetchJson(
          `https://itunes.apple.com/lookup?id=${artistId}&entity=software&limit=25`,
        ) as { results?: readonly Record<string, unknown>[] };

        const artistResults = (artistData.results ?? [])
          .filter((r) => r.wrapperType === "software" && String(r.trackId ?? "") !== appId);

        for (const r of artistResults) {
          if (r.trackId) discovered.push(parseItunesResult(r));
        }
      }

      // Step 3: Search for apps in the same genre
      if (genre) {
        await delay(REQUEST_DELAY_MS);
        const term = encodeURIComponent(genre);
        const searchData = await fetchJson(
          `https://itunes.apple.com/search?term=${term}&entity=software&limit=25&country=us`,
        ) as { results?: readonly Record<string, unknown>[] };

        const seenIds = new Set(discovered.map((d) => d.id));
        seenIds.add(appId);

        for (const r of searchData.results ?? []) {
          const trackId = String(r.trackId ?? "");
          if (trackId && !seenIds.has(trackId)) {
            seenIds.add(trackId);
            discovered.push(parseItunesResult(r));
          }
        }
      }

      return discovered;
    } catch (err) {
      const msg = getErrorMessage(err);
      log.warn("Failed to fetch related apps", { appId, error: msg });
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

        await config.memoryManager.indexAppReviews(APPSTORE_AGENT_ID, forIndex);
        await markReviewsIndexed(ids);

        log.info("Indexed reviews into memory", { count: ids.length, iteration: iterations + 1 });
        iterations++;
      }
    } catch (err) {
      log.error("Failed to index reviews into RAG", { error: err });
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

        await config.memoryManager.indexAppRankings(APPSTORE_AGENT_ID, forIndex);
        await markRankingsIndexed(ids);

        log.info("Indexed rankings into memory", { count: ids.length, iteration: iterations + 1 });
        iterations++;
      }
    } catch (err) {
      log.error("Failed to index rankings into RAG", { error: err });
    }
  }

  async function scrape(): Promise<ScrapeResult> {
    try {
      const syncCfg = loadConfig().appstoreSync;

      // Fetch overall top-free and top-paid from Apple Marketing Tools API.
      // NOTE: this is a different API from the per-category iTunes RSS below
      // and hard-errors (HTTP 500) above limit=100 (verified live) — clamped
      // via appstoreSync.globalLimit's own z.number().max(100).
      const [freeApps, paidApps] = await Promise.all([
        fetchTopApps(buildGlobalTopAppsUrl("top-free", syncCfg.globalLimit), "top-free"),
        fetchTopApps(buildGlobalTopAppsUrl("top-paid", syncCfg.globalLimit), "top-paid"),
      ]);

      const overallRankings = [...freeApps, ...paidApps];
      let rankingsCount = await upsertRankings(overallRankings);

      log.info("Upserted overall app rankings", {
        free: freeApps.length,
        paid: paidApps.length,
      });

      // Fetch per-category rankings from iTunes RSS API (richer data) across
      // every configured list type (top-free/top-paid/top-grossing by
      // default) — this is the main breadth lever for the app corpus that
      // feeds the keyword miner. Logged as a single summary (not per fetch)
      // since this loop now runs categories.length * listTypes.length
      // requests per cycle.
      const categoryRankingsRaw: AppRankingRow[] = [];
      let categoryFetchFailures = 0;

      for (const cat of ITUNES_CATEGORIES) {
        for (const listType of syncCfg.listTypes) {
          await delay(REQUEST_DELAY_MS);

          const itunesUrl = buildCategoryRankingUrl(cat.id, listType, syncCfg.perCategoryLimit);
          const listTypeTag = categoryListTypeTag(cat.id, listType);

          try {
            const data = await fetchJson(itunesUrl);
            const apps = parseTopAppsItunes(data, listTypeTag);
            categoryRankingsRaw.push(...apps);
          } catch (err) {
            categoryFetchFailures++;
            const msg = getErrorMessage(err);
            log.warn("Failed to fetch iTunes category rankings", {
              category: cat.name,
              listType,
              error: msg,
            });
          }
        }
      }

      const categoryRankings = dedupeRankingsByListKey(categoryRankingsRaw);

      log.info("Fetched iTunes category rankings", {
        categories: ITUNES_CATEGORIES.length,
        listTypes: syncCfg.listTypes.length,
        requests: ITUNES_CATEGORIES.length * syncCfg.listTypes.length,
        failures: categoryFetchFailures,
        apps: categoryRankings.length,
      });

      if (categoryRankings.length > 0) {
        const catCount = await upsertRankings(categoryRankings);
        rankingsCount += catCount;
        log.info("Upserted category rankings", {
          categories: ITUNES_CATEGORIES.length,
          total: catCount,
        });
      }

      // Build list of apps to fetch reviews for:
      // top N from overall lists + top N from each category's top-free list.
      // Reviews are an expensive, separate path (one iTunes reviews-endpoint
      // call per app) — deliberately NOT multiplied by the new top-paid/
      // top-grossing list types added above; only ranking breadth grows.
      const appsToReview: AppRankingRow[] = [
        ...freeApps.slice(0, TOP_APPS_PER_LIST),
        ...paidApps.slice(0, TOP_APPS_PER_LIST),
      ];

      // Add top N from each category's top-free list (deduplicate by app id)
      const seenIds = new Set(appsToReview.map((a) => a.id));
      for (const cat of ITUNES_CATEGORIES) {
        const listTypeTag = categoryListTypeTag(cat.id, "top-free");
        const catApps = categoryRankings
          .filter((a) => a.list_type === listTypeTag)
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
        const knownIds = await getDiscoveredAppIds();
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

      // Keyword-gap sweep now runs on its own independent timer
      // (`keywordSweepTimer` below), decoupled from this ~hourly ranking
      // tick — see `keywordSweepTick()`.

      // Keyword-corpus discovery: mine new candidate keywords from the App
      // Store ranking data this scrape cycle already fetched (top-chart app
      // names + categories — see keyword-miner.ts), instead of the retired
      // Apple search-suggest ("autocomplete") expansion, whose MZSearchHints
      // endpoint now just echoes the query back and can never find new
      // terms. No extra network calls — purely reads what's already in the
      // DB — so it's kept on this ~hourly ranking tick (not the faster
      // keyword-sweep timer) simply to run once per scrape rather than
      // every sweep cycle. Gated by its own `corpusDiscovery.enabled` flag
      // and never allowed to break the rest of the scrape cycle — a failure
      // here is logged and swallowed.
      try {
        const cfg = loadConfig().appstoreKeywordGap;
        if (cfg.corpusDiscovery.enabled) {
          const result = await mineKeywords({
            rankingsLimit: KEYWORD_MINING_SCAN_LIMIT,
            maxNew: cfg.corpusDiscovery.maxMinedPerCycle,
          });
          log.info("[appstore] Keyword mining", { added: result.added, scanned: result.scanned });
        }
      } catch (err) {
        log.warn("Keyword-corpus mining failed", { error: getErrorMessage(err) });
      }

      return { ok: true, rankings: rankingsCount, reviews: totalReviews };
    } catch (err) {
      const msg = getErrorMessage(err);
      log.error("App Store scrape failed", { error: msg });
      return { ok: false, error: msg };
    }
  }

  // Runs the keyword-gap sweep on its own timer. Scans the globally stalest
  // `keywordsPerSweep` keywords across the whole corpus each cycle; gated by
  // `enabled` and internally rate-limited by the `dailyKeywordBudget`
  // rolling-24h ceiling in `runKeywordSweep`. Never allowed to break the
  // scraper — a failure is logged and swallowed here, mirroring `tick()`.
  async function keywordSweepTick(): Promise<void> {
    if (keywordSweepRunning) {
      log.debug("Keyword-gap sweep already running, skipping");
      return;
    }

    keywordSweepRunning = true;
    try {
      const cfg = loadConfig().appstoreKeywordGap;
      if (!cfg.enabled) {
        log.debug("Keyword-gap sweep skipped — feature disabled");
        return;
      }

      const result = await runKeywordSweep({
        limit: cfg.keywordsPerSweep,
        delayMs: REQUEST_DELAY_MS,
      });

      if (result.skipped) {
        log.debug("Keyword-gap sweep skipped this cycle — rolling 24h budget reached");
      } else {
        log.info("Keyword-gap sweep complete", {
          scanned: result.scanned,
          failed: result.failed,
        });
      }
    } catch (err) {
      log.warn("Keyword-gap sweep failed", { error: getErrorMessage(err) });
    } finally {
      keywordSweepRunning = false;
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

      if (!keywordSweepTimer) {
        const sweepIntervalMs = loadConfig().appstoreKeywordGap.scanIntervalMs;
        keywordSweepTimer = setInterval(keywordSweepTick, sweepIntervalMs);
        log.info("Keyword-gap sweep timer started", { sweepIntervalMs });
        keywordSweepTick().catch((err) =>
          log.error("Keyword-gap sweep first tick error", { error: err }),
        );
      }
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
        log.info("App Store scraper stopped");
      }
      if (keywordSweepTimer) {
        clearInterval(keywordSweepTimer);
        keywordSweepTimer = null;
        log.info("Keyword-gap sweep timer stopped");
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
