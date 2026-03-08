import { createLogger } from "../../../logger";
import type { ShareOutcome } from "./types";
import {
  getDueJobs,
  getAccountCredentials,
  getSharedVideoIds,
  insertSharedVideo,
  updateJobAfterSuccess,
  updateJobAfterError,
  stopJob,
} from "./store";

import { getErrorMessage } from "../../../lib/error-serialization";
const log = createLogger("x-bookmarks");

const TICK_INTERVAL_MS = 30_000;

/** Add ±20% random jitter to an interval (in seconds). */
function jitter(seconds: number): number {
  const factor = 0.8 + Math.random() * 0.4; // 0.8 – 1.2
  return Math.round(seconds * factor);
}

export interface BookmarkProcessor {
  start(): void;
  stop(): void;
  shareNow(accountId: string): Promise<ShareOutcome>;
}

export function createBookmarkProcessor(): BookmarkProcessor {
  let timer: ReturnType<typeof setInterval> | null = null;
  const running = new Set<string>();

  async function runScript(
    authToken: string,
    ct0: string,
    skipIds: string[],
  ): Promise<ShareOutcome> {
    const { shareBookmark } = await import("../actions/share-bookmark");
    return shareBookmark(authToken, ct0, skipIds);
  }

  async function processJob(accountId: string): Promise<void> {
    if (running.has(accountId)) return;
    running.add(accountId);

    try {
      const creds = await getAccountCredentials(accountId);
      if (!creds) {
        log.warn("Account not found or inactive, stopping job", { accountId });
        await stopJob(accountId);
        return;
      }

      const skipIds = await getSharedVideoIds(accountId);
      log.info("Running bookmark share", {
        accountId,
        skipCount: skipIds.length,
      });

      const result = await runScript(
        creds.auth_token,
        creds.ct0,
        skipIds,
      );

      if (result.ok) {
        await insertSharedVideo(
          accountId,
          result.tweet_id,
          result.author,
          result.url,
        );
        const now = Math.floor(Date.now() / 1000);
        // Fetch job to get interval
        const { getBookmarkJob } = await import("./store");
        const job = await getBookmarkJob(accountId);
        const interval = job?.interval_minutes ?? 15;
        const nextIn = jitter(interval * 60);
        await updateJobAfterSuccess(accountId, now + nextIn);
        log.info("Bookmark shared", {
          accountId,
          tweetId: result.tweet_id,
          author: result.author,
        });
      } else if (result.reason === "no_video_bookmarks") {
        log.info("No video bookmarks left, stopping job", { accountId });
        await stopJob(accountId);
      } else {
        const detail = result.detail ?? "Unknown error";
        log.warn("Bookmark share failed", { accountId, detail });
        const now = Math.floor(Date.now() / 1000);
        const { getBookmarkJob } = await import("./store");
        const job = await getBookmarkJob(accountId);
        const interval = job?.interval_minutes ?? 15;
        const nextIn = jitter(interval * 60);
        await updateJobAfterError(accountId, detail, now + nextIn);
      }
    } catch (err) {
      const msg = getErrorMessage(err);
      log.error("Bookmark processor error", { accountId, error: msg });
      try {
        const now = Math.floor(Date.now() / 1000);
        await updateJobAfterError(accountId, msg, now + jitter(15 * 60));
      } catch {
        // ignore secondary error
      }
    } finally {
      running.delete(accountId);
    }
  }

  async function tick(): Promise<void> {
    try {
      const dueJobs = await getDueJobs();
      for (const job of dueJobs) {
        // Fire and forget — processJob guards concurrency via `running` set
        processJob(job.account_id).catch((err) =>
          log.error("Unhandled job error", { error: err }),
        );
      }
    } catch (err) {
      log.error("Bookmark processor tick error", { error: err });
    }
  }

  async function shareNow(accountId: string): Promise<ShareOutcome> {
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
      const skipIds = await getSharedVideoIds(accountId);
      const result = await runScript(
        creds.auth_token,
        creds.ct0,
        skipIds,
      );

      if (result.ok) {
        await insertSharedVideo(
          accountId,
          result.tweet_id,
          result.author,
          result.url,
        );
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
      log.info("Bookmark processor started", { tickMs: TICK_INTERVAL_MS });
      // Run first tick immediately
      tick().catch((err) => log.error("First tick error", { error: err }));
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
        log.info("Bookmark processor stopped");
      }
    },

    shareNow,
  };
}
