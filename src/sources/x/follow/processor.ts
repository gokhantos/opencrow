import { createLogger } from "../../../logger";
import type { AutofollowOutcome } from "./types";
import {
  getDueAutofollowJobs,
  getAccountCredentials,
  getFollowCandidates,
  getAlreadyFollowedUsernames,
  insertFollowedUsers,
  updateFollowJobAfterSuccess,
  updateFollowJobAfterError,
  stopAutofollowJob,
  getAutofollowJob,
} from "./store";

import { getErrorMessage } from "../../../lib/error-serialization";
const log = createLogger("x-autofollow");

const TICK_INTERVAL_MS = 30_000;

/** Add +/-20% random jitter to an interval (in seconds). */
function jitter(seconds: number): number {
  const factor = 0.8 + Math.random() * 0.4;
  return Math.round(seconds * factor);
}

export interface AutofollowProcessor {
  start(): void;
  stop(): void;
  runNow(accountId: string): Promise<AutofollowOutcome>;
}

export function createAutofollowProcessor(): AutofollowProcessor {
  let timer: ReturnType<typeof setInterval> | null = null;
  const running = new Set<string>();

  async function runScript(
    authToken: string,
    ct0: string,
    maxFollows: number,
    usernames: string[],
    alreadyFollowed: string[],
    languages: string | null = null,
  ): Promise<AutofollowOutcome> {
    const { autoFollow } = await import("../actions/auto-follow");
    return autoFollow(authToken, ct0, maxFollows, usernames, alreadyFollowed, languages);
  }

  async function processJob(accountId: string): Promise<void> {
    if (running.has(accountId)) return;
    running.add(accountId);

    try {
      const creds = await getAccountCredentials(accountId);
      if (!creds) {
        log.warn("Account not found or inactive, stopping job", { accountId });
        await stopAutofollowJob(accountId);
        return;
      }

      const job = await getAutofollowJob(accountId);
      const maxFollows = job?.max_follows_per_run ?? 3;
      const intervalMin = job?.interval_minutes ?? 60;
      const languages = job?.languages ?? null;

      const candidates = await getFollowCandidates(accountId, maxFollows);
      if (candidates.length === 0) {
        log.info("No follow candidates available", { accountId });
        const now = Math.floor(Date.now() / 1000);
        const nextIn = jitter(intervalMin * 60);
        await updateFollowJobAfterSuccess(accountId, 0, now + nextIn);
        return;
      }

      const alreadyFollowed = await getAlreadyFollowedUsernames(accountId);
      log.info("Running autofollow", {
        accountId,
        maxFollows,
        candidates: candidates.length,
        languages,
        alreadyFollowedCount: alreadyFollowed.length,
      });

      const result = await runScript(
        creds.auth_token,
        creds.ct0,
        maxFollows,
        candidates,
        alreadyFollowed,
        languages,
      );

      if (result.ok) {
        if (result.followed.length > 0) {
          await insertFollowedUsers(accountId, result.followed);
        }

        const now = Math.floor(Date.now() / 1000);
        const nextIn = jitter(intervalMin * 60);
        await updateFollowJobAfterSuccess(
          accountId,
          result.followed.length,
          now + nextIn,
        );
        log.info("Autofollow run complete", {
          accountId,
          followed: result.followed.length,
          nextInSec: nextIn,
        });
      } else {
        const detail = result.detail ?? "Unknown error";
        log.warn("Autofollow failed", { accountId, detail });
        const now = Math.floor(Date.now() / 1000);
        const nextIn = jitter(intervalMin * 60);
        await updateFollowJobAfterError(accountId, detail, now + nextIn);
      }
    } catch (err) {
      const msg = getErrorMessage(err);
      log.error("Autofollow processor error", { accountId, error: msg });
      try {
        const now = Math.floor(Date.now() / 1000);
        await updateFollowJobAfterError(accountId, msg, now + jitter(15 * 60));
      } catch {
        // ignore secondary error
      }
    } finally {
      running.delete(accountId);
    }
  }

  async function tick(): Promise<void> {
    try {
      const dueJobs = await getDueAutofollowJobs();
      for (const job of dueJobs) {
        processJob(job.account_id).catch((err) =>
          log.error("Unhandled autofollow job error", { error: err }),
        );
      }
    } catch (err) {
      log.error("Autofollow processor tick error", { error: err });
    }
  }

  async function runNow(accountId: string): Promise<AutofollowOutcome> {
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
      const job = await getAutofollowJob(accountId);
      const maxFollows = job?.max_follows_per_run ?? 3;
      const languages = job?.languages ?? null;

      const candidates = await getFollowCandidates(accountId, maxFollows);
      if (candidates.length === 0) {
        return {
          ok: true,
          followed: [],
        };
      }

      const alreadyFollowed = await getAlreadyFollowedUsernames(accountId);
      const result = await runScript(
        creds.auth_token,
        creds.ct0,
        maxFollows,
        candidates,
        alreadyFollowed,
        languages,
      );

      if (result.ok && result.followed.length > 0) {
        await insertFollowedUsers(accountId, result.followed);
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
      log.info("Autofollow processor started", { tickMs: TICK_INTERVAL_MS });
      tick().catch((err) => log.error("First tick error", { error: err }));
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
        log.info("Autofollow processor stopped");
      }
    },

    runNow,
  };
}
