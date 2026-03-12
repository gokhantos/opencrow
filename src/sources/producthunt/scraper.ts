import { createLogger } from "../../logger";
import type { MemoryManager, ProductForIndex } from "../../memory/types";
import {
  upsertProducts,
  getProducts,
  getUnindexedProducts,
  markProductsIndexed,
  type PHProductRow,
} from "./store";
import { scrapePHDaily, type RawPHProduct } from "./ph-scraper";

import { getErrorMessage } from "../../lib/error-serialization";
import { loadScraperIntervalMs } from "../scraper-config";

const log = createLogger("ph-scraper");

const DEFAULT_INTERVAL_MINUTES = 10;

export interface PHScraper {
  start(): void;
  stop(): void;
  scrapeNow(): Promise<ScrapeResult>;
  backfillRag(): Promise<{ indexed: number; error?: string }>;
}

interface ScrapeResult {
  ok: boolean;
  count?: number;
  error?: string;
}

function toEpoch(isoStr: string | null | undefined): number | null {
  if (!isoStr) return null;
  const ms = Date.parse(isoStr);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

function rawToRow(raw: RawPHProduct): PHProductRow {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: String(raw.id),
    slug: raw.slug,
    name: raw.name,
    tagline: raw.tagline,
    description: raw.description,
    url: raw.url,
    website_url: raw.website_url,
    thumbnail_url: raw.thumbnail_url,
    votes_count: raw.metrics.votes_count,
    comments_count: raw.metrics.comments_count,
    is_featured: raw.is_featured,
    rank: raw.rank,
    makers_json: JSON.stringify(raw.makers),
    topics_json: JSON.stringify(raw.topics),
    featured_at: toEpoch(raw.featured_at),
    product_created_at: toEpoch(raw.created_at),
    reviews_count: raw.reviews_count,
    reviews_rating: raw.reviews_rating,
    account_id: null,
    first_seen_at: now,
    updated_at: now,
  };
}

const PH_AGENT_ID = "ph";

function rowsToProductsForIndex(
  rows: readonly PHProductRow[],
): readonly ProductForIndex[] {
  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    tagline: p.tagline,
    description: p.description,
    url: p.url,
    websiteUrl: p.website_url,
    topics: JSON.parse(p.topics_json || "[]") as string[],
    votesCount: p.votes_count,
    commentsCount: p.comments_count,
    rank: p.rank,
    featuredAt: p.featured_at,
    reviewsCount: p.reviews_count,
    reviewsRating: p.reviews_rating,
    makers: (JSON.parse(p.makers_json || "[]") as Array<{ name: string; username: string }>).map(
      (m) => `${m.name} (@${m.username})`,
    ),
  }));
}

export function createPHScraper(config?: {
  memoryManager?: MemoryManager;
}): PHScraper {
  let timer: ReturnType<typeof setInterval> | null = null;
  let isRunning = false;

  async function runScraper(): Promise<
    { ok: true; products: readonly RawPHProduct[] } | { ok: false; error: string }
  > {
    const { getSecret } = await import("../../config/secrets");
    const apiKey = await getSecret("PH_API_TOKEN");
    const apiSecret = await getSecret("PH_API_SECRET");

    if (!apiKey || !apiSecret) {
      return { ok: false, error: "PH_API_TOKEN or PH_API_SECRET not configured" };
    }

    try {
      const products = await scrapePHDaily(apiKey, apiSecret);
      return { ok: true, products };
    } catch (err) {
      const msg = getErrorMessage(err);
      return { ok: false, error: msg };
    }
  }

  async function doScrape(): Promise<ScrapeResult> {
    const result = await runScraper();

    if (!result.ok) {
      log.warn("PH scrape failed", { error: result.error });
      return { ok: false, error: result.error };
    }

    const rows = result.products.map((p) => rawToRow(p));
    const count = await upsertProducts(rows);

    if (config?.memoryManager) {
      const unindexed = await getUnindexedProducts(200);
      if (unindexed.length > 0) {
        const forIndex = rowsToProductsForIndex(unindexed);
        const ids = unindexed.map((p) => p.id);
        config.memoryManager
          .indexProducts(PH_AGENT_ID, forIndex)
          .then(() => markProductsIndexed(ids))
          .catch((err) =>
            log.error("Failed to index PH products into RAG", {
              count: forIndex.length,
              error: err,
            }),
          );
      }
    }

    log.info("PH scrape complete", { products: count });
    return { ok: true, count };
  }

  async function tick(): Promise<void> {
    if (isRunning) {
      log.info("PH scrape already running, skipping tick");
      return;
    }

    log.info("PH scraper tick");
    isRunning = true;
    doScrape()
      .catch((err) => {
        const msg = getErrorMessage(err);
        log.error("PH scrape error", { error: msg });
      })
      .finally(() => {
        isRunning = false;
      });
  }

  async function scrapeNow(): Promise<ScrapeResult> {
    if (isRunning) {
      return { ok: false, error: "Scrape already in progress" };
    }

    isRunning = true;
    try {
      return await doScrape();
    } finally {
      isRunning = false;
    }
  }

  return {
    async start() {
      if (timer) return;
      const intervalMs = await loadScraperIntervalMs("producthunt", DEFAULT_INTERVAL_MINUTES);
      timer = setInterval(tick, intervalMs);
      log.info("PH scraper started", { tickMs: intervalMs });
      tick().catch((err) =>
        log.error("PH scraper first tick error", { error: err }),
      );
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
        log.info("PH scraper stopped");
      }
    },

    scrapeNow,

    async backfillRag(): Promise<{ indexed: number; error?: string }> {
      if (!config?.memoryManager) {
        return { indexed: 0, error: "memoryManager not configured" };
      }

      const BATCH_SIZE = 50;
      let totalIndexed = 0;
      let offset = 0;

      try {
        while (true) {
          const products = await getProducts(BATCH_SIZE, offset);
          if (products.length === 0) break;

          const forIndex = rowsToProductsForIndex(products);
          await config.memoryManager.indexProducts(PH_AGENT_ID, forIndex);
          totalIndexed += forIndex.length;
          offset += BATCH_SIZE;

          log.info("PH RAG backfill batch", {
            batch: Math.ceil(offset / BATCH_SIZE),
            batchSize: forIndex.length,
            totalSoFar: totalIndexed,
          });
        }

        log.info("PH RAG backfill complete", { totalIndexed });
        return { indexed: totalIndexed };
      } catch (err) {
        const msg = getErrorMessage(err);
        log.error("PH RAG backfill failed", { error: msg, totalIndexed });
        return { indexed: totalIndexed, error: msg };
      }
    },
  };
}
