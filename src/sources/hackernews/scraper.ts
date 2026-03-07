import { createLogger } from "../../logger";
import type { MemoryManager, StoryForIndex } from "../../memory/types";
import {
  upsertStories,
  getStories,
  getUnindexedStories,
  markStoriesIndexed,
  type HNStoryRow,
} from "./store";
import { scrapeHNFrontPage, type RawStory } from "./hn-scraper";

const log = createLogger("hn-scraper");

const TICK_INTERVAL_MS = 600_000; // 10 minutes

export interface HNScraper {
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

function extractSiteLabel(url: string): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function formatAge(unixTimestamp: number): string {
  if (!unixTimestamp) return "";
  const diffSeconds = Math.floor(Date.now() / 1000) - unixTimestamp;
  if (diffSeconds < 3600) {
    const mins = Math.floor(diffSeconds / 60);
    return `${mins} minute${mins !== 1 ? "s" : ""} ago`;
  }
  if (diffSeconds < 86400) {
    const hours = Math.floor(diffSeconds / 3600);
    return `${hours} hour${hours !== 1 ? "s" : ""} ago`;
  }
  const days = Math.floor(diffSeconds / 86400);
  return `${days} day${days !== 1 ? "s" : ""} ago`;
}

function rawToRow(raw: RawStory): HNStoryRow {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: String(raw.id),
    rank: raw.rank ?? 0,
    title: raw.title ?? "",
    url: raw.url ?? "",
    site_label: extractSiteLabel(raw.url),
    points: raw.points ?? 0,
    author: raw.author ?? "",
    age: formatAge(raw.time),
    comment_count: raw.comment_count ?? 0,
    hn_url: raw.hn_url ?? "",
    feed_type: "front",
    first_seen_at: now,
    updated_at: now,
    description: raw.description ?? "",
    top_comments_json: JSON.stringify(raw.top_comments ?? []),
  };
}

const HN_AGENT_ID = "hn";

function rowsToStoriesForIndex(
  rows: readonly HNStoryRow[],
): readonly StoryForIndex[] {
  return rows.map((s) => ({
    id: s.id,
    title: s.title,
    url: s.url,
    siteLabel: s.site_label,
    points: s.points,
    author: s.author,
    commentCount: s.comment_count,
    hnUrl: s.hn_url,
    rank: s.rank,
    description: s.description || undefined,
    topComments: (() => {
      try {
        return s.top_comments_json
          ? (JSON.parse(s.top_comments_json) as string[])
          : undefined;
      } catch {
        return undefined;
      }
    })(),
  }));
}

export function createHNScraper(config?: {
  memoryManager?: MemoryManager;
}): HNScraper {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function runScraper(): Promise<
    { ok: true; stories: RawStory[] } | { ok: false; error: string }
  > {
    try {
      const stories = await scrapeHNFrontPage();
      return { ok: true, stories: stories as RawStory[] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  }

  async function scrape(): Promise<ScrapeResult> {
    const result = await runScraper();

    if (!result.ok) {
      log.warn("HN scrape failed", { error: result.error });
      return { ok: false, error: result.error };
    }

    const rows = result.stories.map((s) => rawToRow(s));
    const count = await upsertStories(rows);

    if (config?.memoryManager) {
      const unindexed = await getUnindexedStories(200);
      if (unindexed.length > 0) {
        const forIndex = rowsToStoriesForIndex(unindexed);
        const ids = unindexed.map((s) => s.id);
        config.memoryManager
          .indexStories(HN_AGENT_ID, forIndex)
          .then(() => markStoriesIndexed(ids))
          .catch((err) =>
            log.error("Failed to index HN stories into RAG", {
              count: forIndex.length,
              error: err,
            }),
          );
      }
    }

    log.info("HN scrape complete", { stories: count });
    return { ok: true, count };
  }

  async function tick(): Promise<void> {
    if (running) {
      log.info("HN scrape already running, skipping");
      return;
    }

    running = true;
    try {
      await scrape();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("HN scrape error", { error: msg });
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, TICK_INTERVAL_MS);
      log.info("HN scraper started", { tickMs: TICK_INTERVAL_MS });
      tick().catch((err) =>
        log.error("HN scraper first tick error", { error: err }),
      );
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
        log.info("HN scraper stopped");
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
      let offset = 0;

      try {
        while (true) {
          const stories = await getStories(undefined, BATCH_SIZE, offset);
          if (stories.length === 0) break;

          const forIndex = rowsToStoriesForIndex(stories);
          await config.memoryManager.indexStories(HN_AGENT_ID, forIndex);
          totalIndexed += forIndex.length;
          offset += BATCH_SIZE;

          log.info("HN RAG backfill batch", {
            batch: Math.ceil(offset / BATCH_SIZE),
            batchSize: forIndex.length,
            totalSoFar: totalIndexed,
          });
        }

        log.info("HN RAG backfill complete", { totalIndexed });
        return { indexed: totalIndexed };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error("HN RAG backfill failed", { error: msg, totalIndexed });
        return { indexed: totalIndexed, error: msg };
      }
    },
  };
}
