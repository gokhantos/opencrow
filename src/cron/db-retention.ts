import { getDb } from "../store/db";
import type { CronStore } from "./store";
import { createLogger } from "../logger";

const log = createLogger("cron:db-retention");

/** Tables and their retention periods (days) */
const RETENTION_RULES: ReadonlyArray<{
  readonly table: string;
  readonly column: string;
  readonly format: "epoch" | "timestamptz";
  readonly days: number;
}> = [
  { table: "session_history", column: "created_at", format: "timestamptz", days: 90 },
  { table: "tool_audit_log", column: "created_at", format: "epoch", days: 60 },
  { table: "user_prompt_log", column: "created_at", format: "timestamptz", days: 90 },
  { table: "subagent_audit_log", column: "created_at", format: "timestamptz", days: 60 },
  { table: "cron_runs", column: "started_at", format: "epoch", days: 30 },
  { table: "messages", column: "created_at", format: "epoch", days: 90 },
  { table: "task_classification", column: "created_at", format: "timestamptz", days: 60 },
  { table: "routing_decisions", column: "created_at", format: "timestamptz", days: 60 },
  { table: "failure_records", column: "created_at", format: "timestamptz", days: 90 },
  { table: "self_reflection_logs", column: "created_at", format: "timestamptz", days: 60 },
  { table: "prediction_records", column: "created_at", format: "timestamptz", days: 60 },
  { table: "workload_history", column: "sampled_at", format: "timestamptz", days: 30 },
  { table: "monitor_alerts", column: "created_at", format: "epoch", days: 90 },
  { table: "tool_stats", column: "updated_at", format: "epoch", days: 90 },
  { table: "agent_messages", column: "created_at", format: "timestamptz", days: 30 },
  { table: "process_logs", column: "created_at", format: "timestamptz", days: 30 },
  { table: "token_usage", column: "created_at", format: "epoch", days: 90 },
  { table: "dead_tasks", column: "dead_at", format: "timestamptz", days: 30 },
];

export interface RetentionResult {
  readonly totalDeleted: number;
  readonly details: ReadonlyArray<{ readonly table: string; readonly deleted: number }>;
}

export async function runDbRetention(): Promise<RetentionResult> {
  const db = getDb();
  const details: Array<{ table: string; deleted: number }> = [];
  let totalDeleted = 0;

  for (const rule of RETENTION_RULES) {
    try {
      const cutoff =
        rule.format === "epoch"
          ? Math.floor(Date.now() / 1000) - rule.days * 86400
          : new Date(Date.now() - rule.days * 86400 * 1000).toISOString();

      const result = await db.unsafe(
        `DELETE FROM ${rule.table} WHERE ${rule.column} < $1`,
        [cutoff],
      );

      const deleted = result.count ?? 0;
      if (deleted > 0) {
        details.push({ table: rule.table, deleted });
        totalDeleted += deleted;
        log.info("Retention cleanup", {
          table: rule.table,
          deleted,
          cutoffDays: rule.days,
        });
      }
    } catch (err) {
      log.warn("Retention cleanup failed for table", {
        table: rule.table,
        error: err,
      });
    }
  }

  // Special: prune completed/failed tasks older than 7 days
  try {
    const taskCutoff = Math.floor(Date.now() / 1000) - 7 * 86400;
    const taskResult = await db.unsafe(
      `DELETE FROM task_queue WHERE status IN ('completed', 'failed') AND enqueued_at < $1`,
      [taskCutoff],
    );
    const taskDeleted = taskResult.count ?? 0;
    if (taskDeleted > 0) {
      details.push({ table: "task_queue", deleted: taskDeleted });
      totalDeleted += taskDeleted;
      log.info("Retention cleanup", { table: "task_queue", deleted: taskDeleted, cutoffDays: 7 });
    }
  } catch (err) {
    log.warn("Retention cleanup failed for table", {
      table: "task_queue",
      error: err,
    });
  }

  // Clean up empty memory sources (sources with zero chunks)
  try {
    const emptyResult = await db`
      DELETE FROM memory_sources
      WHERE id NOT IN (SELECT DISTINCT source_id FROM memory_chunks)
    `;
    const emptyDeleted = emptyResult.count ?? 0;
    if (emptyDeleted > 0) {
      details.push({ table: "memory_sources (empty)", deleted: emptyDeleted });
      totalDeleted += emptyDeleted;
      log.info("Retention cleanup", { table: "memory_sources (empty)", deleted: emptyDeleted });
    }
  } catch (err) {
    log.warn("Retention cleanup failed for table", {
      table: "memory_sources (empty)",
      error: err,
    });
  }

  // Clean up tiny chunks below 50 tokens (semantically meaningless fragments)
  try {
    const tinyResult = await db`
      DELETE FROM memory_chunks WHERE token_count < 50
    `;
    const tinyDeleted = tinyResult.count ?? 0;
    if (tinyDeleted > 0) {
      details.push({ table: "memory_chunks (tiny)", deleted: tinyDeleted });
      totalDeleted += tinyDeleted;
      log.info("Retention cleanup", { table: "memory_chunks (tiny)", deleted: tinyDeleted });
    }
  } catch (err) {
    log.warn("Retention cleanup failed for table", {
      table: "memory_chunks (tiny)",
      error: err,
    });
  }

  // Clean up oversized chunks (>2000 tokens — entire conversations stored as single chunks)
  try {
    const oversizedResult = await db`
      DELETE FROM memory_chunks WHERE token_count > 2000
    `;
    const oversizedDeleted = oversizedResult.count ?? 0;
    if (oversizedDeleted > 0) {
      details.push({ table: "memory_chunks (oversized)", deleted: oversizedDeleted });
      totalDeleted += oversizedDeleted;
      log.info("Retention cleanup", { table: "memory_chunks (oversized)", deleted: oversizedDeleted });
    }
  } catch (err) {
    log.warn("Retention cleanup failed for table", {
      table: "memory_chunks (oversized)",
      error: err,
    });
  }

  log.info("Retention cleanup complete", { totalDeleted, tables: details.length });
  return { totalDeleted, details };
}

const RETENTION_JOB_NAME = "DB Retention Cleanup";

export async function ensureDbRetentionJob(cronStore: CronStore): Promise<void> {
  const jobs = await cronStore.listJobs();
  const existing = jobs.find((j) => j.name === RETENTION_JOB_NAME);
  if (existing) return;

  await cronStore.addJob({
    name: RETENTION_JOB_NAME,
    schedule: { kind: "cron", expr: "0 4 * * *" },
    payload: { kind: "internal", handler: "db-retention" },
    priority: 15,
  });
  log.info("Created DB retention cleanup cron job");
}
