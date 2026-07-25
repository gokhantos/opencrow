/**
 * ideas-pipeline-job.ts — registers (and keeps in sync) the ONE cron job that
 * drives the ideas pipeline on a schedule.
 *
 * Idempotent-ensure, following `monitor/deep-check.ts`'s `ensureDeepHealthCheckJob`
 * pattern: find the job by its stable name, create it if absent, and PATCH it
 * when the desired schedule/payload has drifted from config. Called from
 * `src/entries/cron.ts` on every cron-process start, so a config change to
 * `pipelines.ideas.schedule` takes effect on the next restart without an
 * operator having to hand-edit `cron_jobs`.
 *
 * `delivery.mode` is `"none"`: a `pipelineRun` cron run only reports "started
 * run X" (the pipeline itself takes ~14 minutes and finishes long after the
 * cron record closes), so announcing that string to Telegram every day would be
 * noise. The messages that actually matter come from the pipeline's own
 * zero-yield alarm (`pipelines/ideas/zero-yield-notify.ts`), which fires only
 * when a run produces nothing.
 */

import type { CronJob, CronJobCreate, CronPayload, CronSchedule } from "./types";
import type { CronStore } from "./store";
import { createLogger } from "../logger";

const log = createLogger("cron:ideas-pipeline-job");

/** Stable job name — the identity used to find/patch the job across restarts. */
export const IDEAS_PIPELINE_JOB_NAME = "ideas-pipeline-scheduled-run";

export interface IdeasScheduleSettings {
  readonly enabled: boolean;
  readonly pipelineId: string;
  readonly cronExpr: string;
  readonly tz?: string;
}

/** Build the desired schedule + payload for a given config. Pure. */
export function buildIdeasPipelineJob(settings: IdeasScheduleSettings): CronJobCreate {
  const schedule: CronSchedule = {
    kind: "cron",
    expr: settings.cronExpr,
    ...(settings.tz !== undefined ? { tz: settings.tz } : {}),
  };
  const payload: CronPayload = {
    kind: "pipelineRun",
    pipelineId: settings.pipelineId,
  };
  return {
    name: IDEAS_PIPELINE_JOB_NAME,
    schedule,
    payload,
    delivery: { mode: "none" },
    enabled: settings.enabled,
    deleteAfterRun: false,
  };
}

/**
 * Whether an existing job already matches the desired shape. Pure — compares
 * only the fields this seeder owns (schedule, payload, enabled), never the
 * bookkeeping ones (`nextRunAt`, `lastStatus`, …) which change on every run.
 */
export function ideasPipelineJobMatches(
  existing: CronJob,
  desired: CronJobCreate,
): boolean {
  if (existing.enabled !== desired.enabled) return false;
  if (existing.payload.kind !== "pipelineRun" || desired.payload.kind !== "pipelineRun") {
    return false;
  }
  if (existing.payload.pipelineId !== desired.payload.pipelineId) return false;
  if (existing.schedule.kind !== desired.schedule.kind) return false;
  if (existing.schedule.kind === "cron" && desired.schedule.kind === "cron") {
    return (
      existing.schedule.expr === desired.schedule.expr &&
      (existing.schedule.tz ?? null) === (desired.schedule.tz ?? null)
    );
  }
  return true;
}

export type EnsureIdeasPipelineJobResult = "created" | "updated" | "unchanged" | "disabled";

/**
 * Create or reconcile the scheduled ideas-pipeline cron job. Returns what it
 * did, for logging/tests. Never throws — a seeding failure must not stop the
 * cron process from starting.
 */
export async function ensureIdeasPipelineJob(
  cronStore: CronStore,
  settings: IdeasScheduleSettings,
): Promise<EnsureIdeasPipelineJobResult> {
  const desired = buildIdeasPipelineJob(settings);
  const jobs = await cronStore.listJobs();
  const existing = jobs.find((j) => j.name === IDEAS_PIPELINE_JOB_NAME);

  if (!settings.enabled) {
    // Config-gated OFF: disable an existing job rather than deleting it, so its
    // run history survives and re-enabling is a one-line config change.
    if (existing && existing.enabled) {
      await cronStore.updateJob(existing.id, { enabled: false });
      log.info("Scheduled ideas-pipeline job disabled by config", { jobId: existing.id });
    }
    return "disabled";
  }

  if (!existing) {
    const created = await cronStore.addJob(desired);
    log.info("Created scheduled ideas-pipeline cron job", {
      jobId: created.id,
      pipelineId: settings.pipelineId,
      cronExpr: settings.cronExpr,
      tz: settings.tz ?? "local",
    });
    return "created";
  }

  if (ideasPipelineJobMatches(existing, desired)) {
    log.info("Scheduled ideas-pipeline cron job already up to date", { jobId: existing.id });
    return "unchanged";
  }

  await cronStore.updateJob(existing.id, {
    schedule: desired.schedule,
    payload: desired.payload,
    enabled: true,
  });
  log.info("Reconciled scheduled ideas-pipeline cron job with config", {
    jobId: existing.id,
    pipelineId: settings.pipelineId,
    cronExpr: settings.cronExpr,
  });
  return "updated";
}
