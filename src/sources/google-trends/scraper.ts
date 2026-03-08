import { createLogger } from "../../logger";
import type { MemoryManager, TrendForIndex } from "../../memory/types";
import {
  upsertTrends,
  getUnindexedTrends,
  markTrendsIndexed,
  type TrendRow,
} from "./store";

import { getErrorMessage } from "../../lib/error-serialization";
const log = createLogger("google-trends-scraper");

const TICK_INTERVAL_MS = 1_800_000; // 30 minutes

const FEEDS = [
  { url: "https://trends.google.com/trending/rss?geo=US", category: "all" },
  { url: "https://trends.google.com/trending/rss?geo=US&category=t", category: "tech" },
  { url: "https://trends.google.com/trending/rss?geo=US&category=b", category: "business" },
  { url: "https://trends.google.com/trending/rss?geo=US&category=e", category: "entertainment" },
  { url: "https://trends.google.com/trending/rss?geo=US&category=m", category: "health" },
] as const;

const GEO = "US";
const AGENT_ID = "google-trends";

export interface GoogleTrendsScraper {
  start(): void;
  stop(): void;
  scrapeNow(): Promise<ScrapeResult>;
  backfillRag(): Promise<{ indexed: number; error?: string }>;
}

interface ScrapeResult {
  readonly ok: boolean;
  readonly count?: number;
  readonly error?: string;
}

function hashId(title: string, date: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(`${title}:${date}`);
  return hasher.digest("hex").slice(0, 32);
}

function extractTagContent(xml: string, tag: string): string {
  const openTag = `<${tag}>`;
  const closeTag = `</${tag}>`;
  const start = xml.indexOf(openTag);
  if (start === -1) return "";
  const contentStart = start + openTag.length;
  const end = xml.indexOf(closeTag, contentStart);
  if (end === -1) return "";
  return xml.slice(contentStart, end).trim();
}

function extractCdataContent(xml: string, tag: string): string {
  const openTag = `<${tag}>`;
  const closeTag = `</${tag}>`;
  const start = xml.indexOf(openTag);
  if (start === -1) return "";
  const contentStart = start + openTag.length;
  const end = xml.indexOf(closeTag, contentStart);
  if (end === -1) return "";
  const raw = xml.slice(contentStart, end).trim();
  // Strip CDATA wrapper if present
  const cdataMatch = raw.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return cdataMatch?.[1] ? cdataMatch[1].trim() : raw;
}

function splitItems(xml: string): readonly string[] {
  const items: string[] = [];
  let searchFrom = 0;

  while (true) {
    const itemStart = xml.indexOf("<item>", searchFrom);
    if (itemStart === -1) break;
    const itemEnd = xml.indexOf("</item>", itemStart);
    if (itemEnd === -1) break;
    items.push(xml.slice(itemStart, itemEnd + 7));
    searchFrom = itemEnd + 7;
  }

  return items;
}

function extractNewsItems(
  itemXml: string,
): readonly { title: string; url: string; source: string; picture: string }[] {
  const results: { title: string; url: string; source: string; picture: string }[] = [];
  let searchFrom = 0;

  while (true) {
    const newsStart = itemXml.indexOf("<ht:news_item>", searchFrom);
    if (newsStart === -1) break;
    const newsEnd = itemXml.indexOf("</ht:news_item>", newsStart);
    if (newsEnd === -1) break;
    const newsBlock = itemXml.slice(newsStart, newsEnd + 16);
    searchFrom = newsEnd + 16;

    const title = extractCdataContent(newsBlock, "ht:news_item_title");
    const url = extractCdataContent(newsBlock, "ht:news_item_url");
    const source = extractCdataContent(newsBlock, "ht:news_item_source");
    const picture = extractCdataContent(newsBlock, "ht:news_item_picture");

    if (title || url) {
      results.push({ title, url, source, picture });
    }
  }

  return results;
}

function parseItem(
  itemXml: string,
  category: string,
): TrendRow | null {
  try {
    const title = extractTagContent(itemXml, "title");
    if (!title) return null;

    const trafficVolume = extractTagContent(itemXml, "ht:approx_traffic");
    const pubDate = extractTagContent(itemXml, "pubDate");

    const newsItems = extractNewsItems(itemXml);
    const firstNews = newsItems[0];

    const description = newsItems.map((n) => n.title).filter(Boolean).join(" | ");
    const source = firstNews?.source ?? "";
    const sourceUrl = firstNews?.url ?? "";

    // Extract related queries from ht:related_queries or build from news items
    const relatedRaw = extractCdataContent(itemXml, "ht:related_queries");
    const relatedQueries = relatedRaw
      ? relatedRaw.split(",").map((q) => q.trim()).filter(Boolean).join(", ")
      : "";

    const pictureUrl = extractTagContent(itemXml, "ht:picture");
    const newsItemsJson = newsItems.length > 0 ? JSON.stringify(newsItems) : null;

    const now = Math.floor(Date.now() / 1000);
    const id = hashId(title, pubDate || String(now));

    return {
      id,
      title,
      traffic_volume: trafficVolume || "",
      description,
      source,
      source_url: sourceUrl,
      related_queries: relatedQueries,
      picture_url: pictureUrl || null,
      news_items_json: newsItemsJson,
      geo: GEO,
      category,
      first_seen_at: now,
      updated_at: now,
      indexed_at: null,
    };
  } catch (err) {
    const msg = getErrorMessage(err);
    log.warn("Failed to parse trend item", { error: msg });
    return null;
  }
}

async function fetchFeed(
  url: string,
  category: string,
): Promise<readonly TrendRow[]> {
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; OpenCrowBot/1.0; +https://opencrow.app)",
      Accept: "application/rss+xml, application/xml, text/xml",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  const xml = await response.text();
  const items = splitItems(xml);

  const rows: TrendRow[] = [];
  for (const itemXml of items) {
    const row = parseItem(itemXml, category);
    if (row) {
      rows.push(row);
    }
  }

  return rows;
}

export function rowsToTrendsForIndex(
  rows: readonly TrendRow[],
): readonly TrendForIndex[] {
  return rows.map((t) => {
    let newsInfo = "";
    if (t.news_items_json) {
      try {
        const items = JSON.parse(t.news_items_json) as { title: string }[];
        const titles = items.map((i) => i.title).filter(Boolean).join("; ");
        newsInfo = titles ? `News: ${titles}` : "";
      } catch {
        newsInfo = "";
      }
    }

    return {
      id: t.id,
      title: t.title,
      description: [t.description, newsInfo].filter(Boolean).join("\n"),
      category: t.category,
      trafficVolume: t.traffic_volume ?? "",
      relatedQueries: t.related_queries ?? "",
      sourceUrl: t.source_url,
      source: t.source || "Google Trends",
      firstSeenAt: t.first_seen_at,
    };
  });
}

export function createGoogleTrendsScraper(config?: {
  memoryManager?: MemoryManager;
}): GoogleTrendsScraper {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function scrape(): Promise<ScrapeResult> {
    const allRows: TrendRow[] = [];

    for (const feed of FEEDS) {
      try {
        const rows = await fetchFeed(feed.url, feed.category);
        allRows.push(...rows);
        log.info("Fetched Google Trends feed", {
          category: feed.category,
          count: rows.length,
        });
      } catch (err) {
        const msg = getErrorMessage(err);
        log.warn("Failed to fetch Google Trends feed", {
          category: feed.category,
          error: msg,
        });
      }
    }

    if (allRows.length === 0) {
      return { ok: false, error: "No trends fetched from any feed" };
    }

    const count = await upsertTrends(allRows);

    if (config?.memoryManager) {
      try {
        const unindexed = await getUnindexedTrends(200);
        if (unindexed.length > 0) {
          const forIndex = rowsToTrendsForIndex(unindexed);
          const ids = unindexed.map((t) => t.id);
          try {
            await config.memoryManager.indexTrends(AGENT_ID, forIndex);
            await markTrendsIndexed(ids);
          } catch (err) {
            log.error("Failed to index Google Trends into RAG", {
              count: forIndex.length,
              error: err,
            });
          }
        }
      } catch (err) {
        const msg = getErrorMessage(err);
        log.error("Failed to get unindexed trends", { error: msg });
      }
    }

    log.info("Google Trends scrape complete", { trends: count });
    return { ok: true, count };
  }

  async function tick(): Promise<void> {
    if (running) {
      log.info("Google Trends scrape already running, skipping");
      return;
    }

    running = true;
    try {
      await scrape();
    } catch (err) {
      const msg = getErrorMessage(err);
      log.error("Google Trends scrape error", { error: msg });
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, TICK_INTERVAL_MS);
      log.info("Google Trends scraper started", { tickMs: TICK_INTERVAL_MS });
      tick().catch((err) =>
        log.error("Google Trends scraper first tick error", { error: err }),
      );
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
        log.info("Google Trends scraper stopped");
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

    async backfillRag(): Promise<{ indexed: number; error?: string }> {
      if (!config?.memoryManager) {
        return { indexed: 0, error: "memoryManager not configured" };
      }

      const BATCH_SIZE = 50;
      let totalIndexed = 0;

      try {
        while (true) {
          const unindexed = await getUnindexedTrends(BATCH_SIZE);
          if (unindexed.length === 0) break;

          const forIndex = rowsToTrendsForIndex(unindexed);
          const ids = unindexed.map((t) => t.id);
          await config.memoryManager.indexTrends(AGENT_ID, forIndex);
          await markTrendsIndexed(ids);
          totalIndexed += forIndex.length;

          log.info("Google Trends RAG backfill batch", {
            batchSize: forIndex.length,
            totalSoFar: totalIndexed,
          });
        }

        log.info("Google Trends RAG backfill complete", { totalIndexed });
        return { indexed: totalIndexed };
      } catch (err) {
        const msg = getErrorMessage(err);
        log.error("Google Trends RAG backfill failed", { error: msg, totalIndexed });
        return { indexed: totalIndexed, error: msg };
      }
    },
  };
}
