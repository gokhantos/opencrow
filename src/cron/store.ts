import { getDb } from "../store/db";
import { computeNextRunAt } from "./schedule";
import type {
  CronJob,
  CronJobCreate,
  CronJobPatch,
  CronRunRecord,
  CronProgressEntry,
  CronSchedule,
  CronPayload,
  CronDelivery,
} from "./types";
import { createLogger } from "../logger";

const log = createLogger("cron:store");

export interface CronStore {
  addJob(input: CronJobCreate): Promise<CronJob>;
  updateJob(id: string, patch: CronJobPatch): Promise<CronJob | null>;
  removeJob(id: string): Promise<boolean>;
  getJob(id: string): Promise<CronJob | null>;
  listJobs(): Promise<readonly CronJob[]>;
  getDueJobs(nowMs: number): Promise<readonly CronJob[]>;
  setJobNextRun(id: string, nextRunAt: number | null): Promise<void>;
  setJobLastRun(
    id: string,
    status: string,
    error: string | null,
  ): Promise<void>;
  addRun(run: CronRunRecord): Promise<void>;
  updateRunStatus(
    runId: string,
    status: CronRunRecord["status"],
    resultSummary: string | null,
    error: string | null,
    durationMs: number,
    endedAt: number,
  ): Promise<void>;
  updateRunProgress(runId: string, progressJson: string): Promise<void>;
  getActiveRuns(): Promise<readonly CronRunRecord[]>;
  cleanupStaleRuns(): Promise<number>;
  getRunsForJob(
    jobId: string,
    limit?: number,
  ): Promise<readonly CronRunRecord[]>;
}

export function createCronStore(): CronStore {
  return {
    async addJob(input: CronJobCreate): Promise<CronJob> {
      const id = crypto.randomUUID();
      const now = Math.floor(Date.now() / 1000);
      const nowMs = Date.now();
      const nextRunAt = computeNextRunAt(input.schedule, nowMs);
      const delivery = input.delivery ?? { mode: "none" };
      const enabled = input.enabled ?? true;
      const deleteAfterRun = input.deleteAfterRun ?? false;
      const priority = input.priority ?? 10;

      const db = getDb();
      await db`
        INSERT INTO cron_jobs
          (id, name, enabled, delete_after_run, priority, schedule_json, payload_json, delivery_json, next_run_at, created_at, updated_at)
        VALUES (${id}, ${input.name}, ${enabled}, ${deleteAfterRun}, ${priority}, ${JSON.stringify(input.schedule)}, ${JSON.stringify(input.payload)}, ${JSON.stringify(delivery)}, ${nextRunAt ? Math.floor(nextRunAt / 1000) : null}, ${now}, ${now})
      `;

      log.info("Cron job created", { id, name: input.name });

      const job = await this.getJob(id);
      if (!job) throw new Error(`Failed to retrieve created cron job: ${id}`);
      return job;
    },

    async updateJob(id: string, patch: CronJobPatch): Promise<CronJob | null> {
      const existing = await this.getJob(id);
      if (!existing) return null;

      const now = Math.floor(Date.now() / 1000);
      const setClauses: string[] = [];
      const params: (string | number | boolean | null)[] = [];
      let paramIdx = 1;

      if (patch.name !== undefined) {
        setClauses.push(`name = $${paramIdx++}`);
        params.push(patch.name);
      }
      if (patch.enabled !== undefined) {
        setClauses.push(`enabled = $${paramIdx++}`);
        params.push(patch.enabled);
      }
      if (patch.deleteAfterRun !== undefined) {
        setClauses.push(`delete_after_run = $${paramIdx++}`);
        params.push(patch.deleteAfterRun);
      }
      if (patch.priority !== undefined) {
        setClauses.push(`priority = $${paramIdx++}`);
        params.push(patch.priority);
      }
      if (patch.schedule !== undefined) {
        setClauses.push(`schedule_json = $${paramIdx++}`);
        params.push(JSON.stringify(patch.schedule));
        const nextRunAt = computeNextRunAt(patch.schedule, Date.now());
        setClauses.push(`next_run_at = $${paramIdx++}`);
        params.push(nextRunAt ? Math.floor(nextRunAt / 1000) : null);
      }
      if (patch.payload !== undefined) {
        setClauses.push(`payload_json = $${paramIdx++}`);
        params.push(JSON.stringify(patch.payload));
      }
      if (patch.delivery !== undefined) {
        setClauses.push(`delivery_json = $${paramIdx++}`);
        params.push(JSON.stringify(patch.delivery));
      }

      if (setClauses.length === 0) return existing;

      setClauses.push(`updated_at = $${paramIdx++}`);
      params.push(now);
      params.push(id);

      const db = getDb();
      await db.unsafe(
        `UPDATE cron_jobs SET ${setClauses.join(", ")} WHERE id = $${paramIdx}`,
        params,
      );

      return this.getJob(id);
    },

    async removeJob(id: string): Promise<boolean> {
      const db = getDb();
      const result = await db`DELETE FROM cron_jobs WHERE id = ${id}`;
      return (result.count ?? 0) > 0;
    },

    async getJob(id: string): Promise<CronJob | null> {
      const db = getDb();
      const [row] = await db`SELECT * FROM cron_jobs WHERE id = ${id}`;
      return row ? rowToJob(row as Record<string, unknown>) : null;
    },

    async listJobs(): Promise<readonly CronJob[]> {
      const db = getDb();
      const rows = await db`SELECT * FROM cron_jobs ORDER BY created_at DESC`;
      return (rows as Record<string, unknown>[]).map(rowToJob);
    },

    async getDueJobs(nowMs: number): Promise<readonly CronJob[]> {
      const nowSec = Math.floor(nowMs / 1000);
      const db = getDb();
      const rows = await db`
        SELECT * FROM cron_jobs
        WHERE enabled = TRUE AND next_run_at IS NOT NULL AND next_run_at <= ${nowSec}
        ORDER BY priority ASC, next_run_at ASC
      `;
      return (rows as Record<string, unknown>[]).map(rowToJob);
    },

    async setJobNextRun(id: string, nextRunAt: number | null): Promise<void> {
      const db = getDb();
      const now = Math.floor(Date.now() / 1000);
      const nextSec = nextRunAt ? Math.floor(nextRunAt / 1000) : null;
      await db`
        UPDATE cron_jobs SET next_run_at = ${nextSec}, updated_at = ${now} WHERE id = ${id}
      `;
    },

    async setJobLastRun(
      id: string,
      status: string,
      error: string | null,
    ): Promise<void> {
      const now = Math.floor(Date.now() / 1000);
      const db = getDb();
      await db`
        UPDATE cron_jobs SET last_run_at = ${now}, last_status = ${status}, last_error = ${error}, updated_at = ${now} WHERE id = ${id}
      `;
    },

    async addRun(run: CronRunRecord): Promise<void> {
      const db = getDb();
      const progressJson = run.progress ? JSON.stringify(run.progress) : null;
      await db`
        INSERT INTO cron_runs (id, job_id, status, result_summary, error, duration_ms, started_at, ended_at, progress_json)
        VALUES (${run.id}, ${run.jobId}, ${run.status}, ${run.resultSummary}, ${run.error}, ${run.durationMs}, ${run.startedAt}, ${run.endedAt}, ${progressJson})
      `;
    },

    async updateRunStatus(
      runId: string,
      status: CronRunRecord["status"],
      resultSummary: string | null,
      error: string | null,
      durationMs: number,
      endedAt: number,
    ): Promise<void> {
      const db = getDb();
      await db`
        UPDATE cron_runs
        SET status = ${status}, result_summary = ${resultSummary}, error = ${error},
            duration_ms = ${durationMs}, ended_at = ${endedAt}
        WHERE id = ${runId}
      `;
    },

    async updateRunProgress(
      runId: string,
      progressJson: string,
    ): Promise<void> {
      const db = getDb();
      await db`
        UPDATE cron_runs SET progress_json = ${progressJson} WHERE id = ${runId}
      `;
    },

    async getActiveRuns(): Promise<readonly CronRunRecord[]> {
      const db = getDb();
      const rows = await db`
        SELECT * FROM cron_runs WHERE status = 'running' ORDER BY started_at DESC
      `;
      return (rows as Record<string, unknown>[]).map(rowToRun);
    },

    async cleanupStaleRuns(): Promise<number> {
      const db = getDb();
      const now = Math.floor(Date.now() / 1000);
      const result = await db`
        UPDATE cron_runs
        SET status = 'error', error = 'Interrupted by restart', ended_at = ${now},
            duration_ms = (${now} - started_at) * 1000
        WHERE status = 'running'
      `;
      const count = result.count ?? 0;
      if (count > 0) {
        log.warn("Cleaned up stale running cron runs", { count });
      }
      return count;
    },

    async getRunsForJob(
      jobId: string,
      limit = 20,
    ): Promise<readonly CronRunRecord[]> {
      const db = getDb();
      const rows = await db`
        SELECT * FROM cron_runs WHERE job_id = ${jobId} ORDER BY started_at DESC LIMIT ${limit}
      `;
      return (rows as Record<string, unknown>[]).map(rowToRun);
    },
  };
}

function rowToJob(row: Record<string, unknown>): CronJob {
  return {
    id: row.id as string,
    name: row.name as string,
    enabled: row.enabled !== false && row.enabled !== 0,
    deleteAfterRun: Boolean(row.delete_after_run),
    priority: (row.priority as number) ?? 10,
    schedule: JSON.parse(row.schedule_json as string) as CronSchedule,
    payload: JSON.parse(row.payload_json as string) as CronPayload,
    delivery: JSON.parse(row.delivery_json as string) as CronDelivery,
    nextRunAt: row.next_run_at as number | null,
    lastRunAt: row.last_run_at as number | null,
    lastStatus: row.last_status as string | null,
    lastError: row.last_error as string | null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function rowToRun(row: Record<string, unknown>): CronRunRecord {
  let progress: readonly CronProgressEntry[] | null = null;
  if (typeof row.progress_json === "string") {
    try {
      progress = JSON.parse(row.progress_json) as CronProgressEntry[];
    } catch {
      progress = null;
    }
  }

  return {
    id: row.id as string,
    jobId: row.job_id as string,
    status: row.status as CronRunRecord["status"],
    resultSummary: (row.result_summary as string) ?? null,
    error: (row.error as string) ?? null,
    durationMs: (row.duration_ms as number) ?? null,
    startedAt: row.started_at as number,
    endedAt: (row.ended_at as number) ?? null,
    progress,
  };
}
