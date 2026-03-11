import { createLogger } from "../../logger";
import type { MemoryManager, RedditPostForIndex } from "../../memory/types";
import {
  getActiveAccounts,
  upsertPosts,
  updateLastScrape,
  getPosts,
  getUnindexedPosts,
  markPostsIndexed,
  type RedditPostRow,
} from "./store";
import { scrapeRedditFeed, type RawRedditPost } from "./reddit-scraper";
import { getErrorMessage } from "../../lib/error-serialization";
import { loadScraperIntervalMs } from "../scraper-config";

const log = createLogger("reddit-scraper");

const DEFAULT_INTERVAL_MINUTES = 30;

export interface RedditScraper {
  start(): void;
  stop(): void;
  scrapeNow(accountId: string): Promise<ScrapeResult>;
  backfillRag(): Promise<{ indexed: number; error?: string }>;
}

interface ScrapeResult {
  ok: boolean;
  count?: number;
  error?: string;
}

type RawPost = RawRedditPost;

function rawToRow(raw: RawPost): RedditPostRow {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: String(raw.id),
    subreddit: raw.subreddit ?? "",
    title: raw.title ?? "",
    url: raw.url ?? "",
    selftext: raw.selftext ?? "",
    author: raw.author ?? "",
    score: raw.score ?? 0,
    num_comments: raw.num_comments ?? 0,
    permalink: raw.permalink ?? "",
    post_type: raw.post_type ?? "link",
    feed_source: raw.feed_source ?? "home",
    domain: raw.domain ?? "",
    upvote_ratio: raw.upvote_ratio ?? 0,
    created_utc: raw.created_utc ?? 0,
    first_seen_at: now,
    updated_at: now,
    top_comments_json:
      raw.top_comments && raw.top_comments.length > 0
        ? JSON.stringify(raw.top_comments)
        : null,
    flair: raw.flair ?? null,
    thumbnail_url: raw.thumbnail_url ?? null,
  };
}

const REDDIT_AGENT_ID = "reddit";

function rowsToPostsForIndex(
  rows: readonly RedditPostRow[],
): readonly RedditPostForIndex[] {
  return rows.map((p) => ({
    id: p.id,
    title: p.title,
    subreddit: p.subreddit,
    url: p.url,
    selftext: p.selftext,
    author: p.author,
    score: p.score,
    numComments: p.num_comments,
    permalink: p.permalink,
    flair: p.flair ?? undefined,
    topComments: p.top_comments_json
      ? (JSON.parse(p.top_comments_json) as string[])
      : undefined,
  }));
}

export function createRedditScraper(config?: {
  memoryManager?: MemoryManager;
}): RedditScraper {
  let timer: ReturnType<typeof setInterval> | null = null;
  const running = new Set<string>();

  async function runScraper(
    cookiesJson: string,
  ): Promise<{ ok: true; posts: RawPost[] } | { ok: false; error: string }> {
    try {
      const posts = await scrapeRedditFeed(cookiesJson);
      return { ok: true, posts: posts as RawPost[] };
    } catch (err) {
      const msg = getErrorMessage(err);
      return { ok: false, error: msg };
    }
  }

  async function scrapeAccount(
    accountId: string,
    cookiesJson: string,
  ): Promise<ScrapeResult> {
    const result = await runScraper(cookiesJson);

    if (!result.ok) {
      log.warn("Reddit scrape failed", { accountId, error: result.error });
      return { ok: false, error: result.error };
    }

    const rows = result.posts.map((p) => rawToRow(p));
    const count = await upsertPosts(rows);
    await updateLastScrape(accountId, count);

    if (config?.memoryManager) {
      const unindexed = await getUnindexedPosts(200);
      if (unindexed.length > 0) {
        const forIndex = rowsToPostsForIndex(unindexed);
        const ids = unindexed.map((p) => p.id);
        config.memoryManager
          .indexRedditPosts(REDDIT_AGENT_ID, forIndex)
          .then(() => markPostsIndexed(ids))
          .catch((err) =>
            log.error("Failed to index Reddit posts into RAG", {
              count: forIndex.length,
              error: err,
            }),
          );
      }
    }

    log.info("Reddit scrape complete", { accountId, posts: count });
    return { ok: true, count };
  }

  async function tick(): Promise<void> {
    try {
      const accounts = await getActiveAccounts();
      if (accounts.length === 0) {
        log.warn("Reddit scraper tick: no active accounts found, skipping");
        return;
      }

      log.info("Reddit scraper tick", { accounts: accounts.length });

      for (const account of accounts) {
        if (running.has(account.id)) {
          log.info("Reddit scrape already running, skipping", {
            accountId: account.id,
          });
          continue;
        }

        running.add(account.id);
        scrapeAccount(account.id, account.cookies_json)
          .catch((err) => {
            const msg = getErrorMessage(err);
            log.error("Reddit scrape error", {
              accountId: account.id,
              error: msg,
            });
          })
          .finally(() => {
            running.delete(account.id);
          });
      }
    } catch (err) {
      log.error("Reddit scraper tick error", { error: err });
    }
  }

  async function scrapeNow(accountId: string): Promise<ScrapeResult> {
    if (running.has(accountId)) {
      return { ok: false, error: "Already running for this account" };
    }

    const accounts = await getActiveAccounts();
    const account = accounts.find((a) => a.id === accountId);
    if (!account) {
      return { ok: false, error: "Account not found or inactive" };
    }

    running.add(accountId);
    try {
      return await scrapeAccount(accountId, account.cookies_json);
    } finally {
      running.delete(accountId);
    }
  }

  return {
    async start() {
      if (timer) return;
      const intervalMs = await loadScraperIntervalMs("reddit", DEFAULT_INTERVAL_MINUTES);
      timer = setInterval(tick, intervalMs);
      log.info("Reddit scraper started", { tickMs: intervalMs });
      tick().catch((err) =>
        log.error("Reddit scraper first tick error", { error: err }),
      );
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
        log.info("Reddit scraper stopped");
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
          const posts = await getPosts(undefined, BATCH_SIZE, offset);
          if (posts.length === 0) break;

          const forIndex = rowsToPostsForIndex(posts);
          await config.memoryManager.indexRedditPosts(
            REDDIT_AGENT_ID,
            forIndex,
          );
          totalIndexed += forIndex.length;
          offset += BATCH_SIZE;

          log.info("Reddit RAG backfill batch", {
            batch: Math.ceil(offset / BATCH_SIZE),
            batchSize: forIndex.length,
            totalSoFar: totalIndexed,
          });
        }

        log.info("Reddit RAG backfill complete", { totalIndexed });
        return { indexed: totalIndexed };
      } catch (err) {
        const msg = getErrorMessage(err);
        log.error("Reddit RAG backfill failed", { error: msg, totalIndexed });
        return { indexed: totalIndexed, error: msg };
      }
    },
  };
}
