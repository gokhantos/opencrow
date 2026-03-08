import { createLogger } from "../../../logger";
import type { AutolikeOutcome } from "./types";
import {
  getDueAutolikeJobs,
  getAccountCredentials,
  getLikedTweetIds,
  insertScrapedTweets,
  insertLikedTweets,
  updateJobAfterSuccess,
  updateJobAfterError,
  stopAutolikeJob,
  getAutolikeJob,
} from "./store";

import { getErrorMessage } from "../../../lib/error-serialization";
const log = createLogger("x-autolikes");

const TICK_INTERVAL_MS = 30_000;

/** Add ±20% random jitter to an interval (in seconds). */
function jitter(seconds: number): number {
  const factor = 0.8 + Math.random() * 0.4;
  return Math.round(seconds * factor);
}

export interface AutolikeProcessor {
  start(): void;
  stop(): void;
  runNow(accountId: string): Promise<AutolikeOutcome>;
}

export function createAutolikeProcessor(): AutolikeProcessor {
  let timer: ReturnType<typeof setInterval> | null = null;
  const running = new Set<string>();

  async function runScript(
    authToken: string,
    ct0: string,
    maxLikes: number,
    alreadyLikedIds: string[],
    languages: string | null = null,
  ): Promise<AutolikeOutcome> {
    const { autoLike } = await import("../actions/auto-like");
    return autoLike(authToken, ct0, maxLikes, alreadyLikedIds, languages);
  }

  async function processJob(accountId: string): Promise<void> {
    if (running.has(accountId)) return;
    running.add(accountId);

    try {
      const creds = await getAccountCredentials(accountId);
      if (!creds) {
        log.warn("Account not found or inactive, stopping job", {
          accountId,
        });
        await stopAutolikeJob(accountId);
        return;
      }

      const job = await getAutolikeJob(accountId);
      const maxLikes = job?.max_likes_per_run ?? 5;
      const intervalMin = job?.interval_minutes ?? 15;
      const languages = job?.languages ?? null;

      const alreadyLiked = await getLikedTweetIds(accountId);
      log.info("Running autolike", {
        accountId,
        maxLikes,
        languages,
        alreadyLikedCount: alreadyLiked.length,
      });

      const result = await runScript(
        creds.auth_token,
        creds.ct0,
        maxLikes,
        alreadyLiked,
        languages,
      );

      if (result.ok) {
        if (result.scraped.length > 0) {
          await insertScrapedTweets(accountId, result.scraped);
        }
        if (result.liked.length > 0) {
          await insertLikedTweets(accountId, result.liked);
        }

        const now = Math.floor(Date.now() / 1000);
        const nextIn = jitter(intervalMin * 60);
        await updateJobAfterSuccess(
          accountId,
          result.scraped.length,
          result.liked.length,
          now + nextIn,
        );
        log.info("Autolike run complete", {
          accountId,
          scraped: result.scraped.length,
          liked: result.liked.length,
          nextInSec: nextIn,
        });
      } else {
        const detail = result.detail ?? "Unknown error";
        log.warn("Autolike failed", { accountId, detail });
        const now = Math.floor(Date.now() / 1000);
        const nextIn = jitter(intervalMin * 60);
        await updateJobAfterError(accountId, detail, now + nextIn);
      }
    } catch (err) {
      const msg = getErrorMessage(err);
      log.error("Autolike processor error", { accountId, error: msg });
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
      const dueJobs = await getDueAutolikeJobs();
      for (const job of dueJobs) {
        processJob(job.account_id).catch((err) =>
          log.error("Unhandled autolike job error", { error: err }),
        );
      }
    } catch (err) {
      log.error("Autolike processor tick error", { error: err });
    }
  }

  async function runNow(accountId: string): Promise<AutolikeOutcome> {
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
      const job = await getAutolikeJob(accountId);
      const maxLikes = job?.max_likes_per_run ?? 5;
      const languages = job?.languages ?? null;
      const alreadyLiked = await getLikedTweetIds(accountId);

      const result = await runScript(
        creds.auth_token,
        creds.ct0,
        maxLikes,
        alreadyLiked,
        languages,
      );

      if (result.ok) {
        if (result.scraped.length > 0) {
          await insertScrapedTweets(accountId, result.scraped);
        }
        if (result.liked.length > 0) {
          await insertLikedTweets(accountId, result.liked);
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
      log.info("Autolike processor started", { tickMs: TICK_INTERVAL_MS });
      tick().catch((err) => log.error("First tick error", { error: err }));
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
        log.info("Autolike processor stopped");
      }
    },

    runNow,
  };
}
