import { createLogger } from "../../../logger";
import type { TimelineScrapeOutcome, TimelineTweetFromPython } from "./types";
import type { MemoryManager, TweetForIndex } from "../../../memory/types";
import {
  getDueTimelineScrapeJobs,
  getTimelineScrapeJob,
  insertTimelineTweets,
  getAllTimelineTweets,
  getUnindexedTweets,
  markTweetsIndexed,
  stopTimelineScrapeJob,
  updateTimelineJobAfterError,
  updateTimelineJobAfterSuccess,
} from "./store";
import { getAccountCredentials } from "../interactions/store";

import { getErrorMessage } from "../../../lib/error-serialization";
const log = createLogger("x-timeline");

const TICK_INTERVAL_MS = 30_000;

function jitter(seconds: number): number {
  const factor = 0.8 + Math.random() * 0.4;
  return Math.round(seconds * factor);
}

const TIMELINE_AGENT_ID = "x-timeline";

function tweetsToIndexFormat(
  tweets: readonly TimelineTweetFromPython[],
): readonly TweetForIndex[] {
  return tweets.map((t) => ({
    id: t.tweet_id,
    text: t.text,
    authorHandle: t.author_username,
    tweetTimestamp: t.tweet_created_at
      ? new Date(t.tweet_created_at * 1000).toISOString()
      : new Date().toISOString(),
  }));
}

export interface TimelineScrapeProcessor {
  start(): void;
  stop(): void;
  runNow(accountId: string): Promise<TimelineScrapeOutcome>;
  backfillRag(): Promise<{ indexed: number; error?: string }>;
}

export function createTimelineScrapeProcessor(config?: {
  memoryManager?: MemoryManager;
}): TimelineScrapeProcessor {
  let timer: ReturnType<typeof setInterval> | null = null;
  const running = new Set<string>();

  async function runScript(
    authToken: string,
    ct0: string,
    maxPages: number,
    sources: string,
    languages: string | null,
  ): Promise<TimelineScrapeOutcome> {
    const { scrapeTimeline } = await import("../actions/scrape-timeline");
    return scrapeTimeline(authToken, ct0, maxPages, sources, languages);
  }

  async function processJob(accountId: string): Promise<void> {
    if (running.has(accountId)) return;
    running.add(accountId);

    try {
      const creds = await getAccountCredentials(accountId);
      if (!creds) {
        log.warn("Account not found or inactive, stopping job", { accountId });
        await stopTimelineScrapeJob(accountId);
        return;
      }

      const job = await getTimelineScrapeJob(accountId);
      const maxPages = job?.max_pages ?? 3;
      const sources = job?.sources ?? "home,top_posts";
      const languages = job?.languages ?? null;
      const intervalMin = job?.interval_minutes ?? 120;

      log.info("Running timeline scrape", { accountId, maxPages, sources, languages });

      const result = await runScript(
        creds.auth_token,
        creds.ct0,
        maxPages,
        sources,
        languages,
      );

      if (result.ok) {
        if (result.tweets.length > 0) {
          await insertTimelineTweets(accountId, result.tweets);

          if (config?.memoryManager) {
            const unindexed = await getUnindexedTweets(200);
            if (unindexed.length > 0) {
              const forIndex: TweetForIndex[] = unindexed.map((t) => ({
                id: t.tweet_id,
                text: t.text,
                authorHandle: t.author_username,
                tweetTimestamp: t.tweet_created_at
                  ? new Date(t.tweet_created_at * 1000).toISOString()
                  : "",
              }));
              const ids = unindexed.map((t) => t.id);
              config.memoryManager
                .indexTweets(TIMELINE_AGENT_ID, forIndex)
                .then(() => markTweetsIndexed(ids))
                .catch((err) =>
                  log.error("Failed to index timeline tweets into RAG", {
                    count: forIndex.length,
                    error: err,
                  }),
                );
            }
          }
        }

        const now = Math.floor(Date.now() / 1000);
        const nextIn = jitter(intervalMin * 60);
        await updateTimelineJobAfterSuccess(
          accountId,
          result.tweets.length,
          now + nextIn,
        );
        log.info("Timeline scrape complete", {
          accountId,
          tweets: result.tweets.length,
          nextInSec: nextIn,
        });
      } else {
        const detail = result.detail ?? "Unknown error";
        log.warn("Timeline scrape failed", { accountId, detail });
        const now = Math.floor(Date.now() / 1000);
        const nextIn = jitter(intervalMin * 60);
        await updateTimelineJobAfterError(accountId, detail, now + nextIn);
      }
    } catch (err) {
      const msg = getErrorMessage(err);
      log.error("Timeline scrape processor error", { accountId, error: msg });
      try {
        const now = Math.floor(Date.now() / 1000);
        await updateTimelineJobAfterError(
          accountId,
          msg,
          now + jitter(120 * 60),
        );
      } catch {
        // ignore secondary error
      }
    } finally {
      running.delete(accountId);
    }
  }

  async function tick(): Promise<void> {
    try {
      const dueJobs = await getDueTimelineScrapeJobs();
      for (const job of dueJobs) {
        processJob(job.account_id).catch((err) =>
          log.error("Unhandled timeline scrape job error", { error: err }),
        );
      }
    } catch (err) {
      log.error("Timeline scrape processor tick error", { error: err });
    }
  }

  async function runNow(accountId: string): Promise<TimelineScrapeOutcome> {
    if (running.has(accountId)) {
      return {
        ok: false,
        reason: "error",
        detail: "Already running for this account",
      };
    }

    const creds = await getAccountCredentials(accountId);
    if (!creds) {
      return {
        ok: false,
        reason: "error",
        detail: "Account not found or inactive",
      };
    }

    running.add(accountId);
    try {
      const job = await getTimelineScrapeJob(accountId);
      const maxPages = job?.max_pages ?? 3;
      const sources = job?.sources ?? "home,top_posts";
      const languages = job?.languages ?? null;

      const result = await runScript(
        creds.auth_token,
        creds.ct0,
        maxPages,
        sources,
        languages,
      );

      if (result.ok && result.tweets.length > 0) {
        await insertTimelineTweets(accountId, result.tweets);

        if (config?.memoryManager) {
          const unindexed = await getUnindexedTweets(200);
          if (unindexed.length > 0) {
            const forIndex: TweetForIndex[] = unindexed.map((t) => ({
              id: t.tweet_id,
              text: t.text,
              authorHandle: t.author_username,
              tweetTimestamp: t.tweet_created_at
                ? new Date(t.tweet_created_at * 1000).toISOString()
                : "",
            }));
            const ids = unindexed.map((t) => t.id);
            config.memoryManager
              .indexTweets(TIMELINE_AGENT_ID, forIndex)
              .then(() => markTweetsIndexed(ids))
              .catch((err) =>
                log.error("Failed to index timeline tweets into RAG", {
                  count: forIndex.length,
                  error: err,
                }),
              );
          }
        }
      }

      return result;
    } finally {
      running.delete(accountId);
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(tick, TICK_INTERVAL_MS);
      log.info("Timeline scrape processor started", {
        tickMs: TICK_INTERVAL_MS,
      });
      tick().catch((err) => log.error("First tick error", { error: err }));
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
        log.info("Timeline scrape processor stopped");
      }
    },

    runNow,

    async backfillRag(): Promise<{ indexed: number; error?: string }> {
      if (!config?.memoryManager) {
        return { indexed: 0, error: "memoryManager not configured" };
      }

      const BATCH_SIZE = 50;
      let totalIndexed = 0;
      let offset = 0;

      try {
        while (true) {
          const tweets = await getAllTimelineTweets(BATCH_SIZE, offset);
          if (tweets.length === 0) break;

          const forIndex: readonly TweetForIndex[] = tweets.map((t) => ({
            id: t.tweet_id,
            text: t.text,
            authorHandle: t.author_username,
            tweetTimestamp: t.tweet_created_at
              ? new Date(t.tweet_created_at * 1000).toISOString()
              : new Date(t.scraped_at * 1000).toISOString(),
          }));

          await config.memoryManager.indexTweets(TIMELINE_AGENT_ID, forIndex);
          totalIndexed += forIndex.length;
          offset += BATCH_SIZE;

          log.info("Timeline RAG backfill batch", {
            batch: Math.ceil(offset / BATCH_SIZE),
            batchSize: forIndex.length,
            totalSoFar: totalIndexed,
          });
        }

        log.info("Timeline RAG backfill complete", { totalIndexed });
        return { indexed: totalIndexed };
      } catch (err) {
        const msg = getErrorMessage(err);
        log.error("Timeline RAG backfill failed", {
          error: msg,
          totalIndexed,
        });
        return { indexed: totalIndexed, error: msg };
      }
    },
  };
}
