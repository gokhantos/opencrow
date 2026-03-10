import type { ToolDefinition, ToolCategory } from "./types";
import type { CronStore } from "../cron/store";
import { createCronStore } from "../cron/store";
import type {
  CronJobCreate,
  CronJobPatch,
  CronSchedule,
  CronPayload,
  CronDelivery,
} from "../cron/types";
import { formatSchedule, computeNextRunAt } from "../cron/schedule";
import { sendCommand } from "../process/commands";
import { createLogger } from "../logger";
import { getDb } from "../store/db";
import { Cron } from "croner";

const log = createLogger("tool:cron");

export interface CronToolConfig {
  readonly currentAgentId?: string;
}

let _store: CronStore | null = null;
function getStore(): CronStore {
  if (!_store) _store = createCronStore();
  return _store;
}

export function createCronTool(config: CronToolConfig): ToolDefinition {
  return {
    name: "cron",
    description: `Manage scheduled/recurring tasks. Actions:
- status: Show scheduler status
- list: List all cron jobs
- add: Create a new cron job (requires: name, schedule_kind, message; optional: every_ms, cron_expr, at, agent_id, timeout_seconds, deliver_channel, deliver_chat_id, delete_after_run, mode)
- update: Update a job (requires: job_id; optional: name, enabled, schedule fields, message)
- remove: Delete a job (requires: job_id)
- run: Run a job immediately (requires: job_id)
- runs: Show recent runs for a job (requires: job_id)`,
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "status",
            "list",
            "add",
            "update",
            "remove",
            "run",
            "runs",
            "status_all",
          ],
          description:
            "The action to perform. status_all shows aggregate success/failure rates.",
        },
        job_id: {
          type: "string",
          description: "Job ID (for update/remove/run/runs).",
        },
        name: { type: "string", description: "Job name (for add/update)." },
        schedule_kind: {
          type: "string",
          enum: ["at", "every", "cron"],
          description: "Schedule type (for add).",
        },
        at: {
          type: "string",
          description: "ISO datetime for one-time schedule.",
        },
        every_ms: {
          type: "number",
          description: "Interval in milliseconds for repeating.",
        },
        cron_expr: {
          type: "string",
          description: 'Cron expression (e.g. "0 * * * *").',
        },
        tz: {
          type: "string",
          description: 'Timezone for cron (e.g. "America/New_York").',
        },
        message: {
          type: "string",
          description: "Task message for the agent.",
        },
        agent_id: {
          type: "string",
          description: "Agent to run the task (default: current).",
        },
        timeout_seconds: {
          type: "number",
          description: "Timeout in seconds.",
        },
        deliver_channel: {
          type: "string",
          description: "Channel for result delivery.",
        },
        deliver_chat_id: {
          type: "string",
          description: "Chat ID for result delivery.",
        },
        enabled: {
          type: "boolean",
          description: "Enable/disable job (for update).",
        },
        delete_after_run: {
          type: "boolean",
          description: "Delete job after first run.",
        },
      },
      required: ["action"],
    },
    categories: ["system"] as readonly ToolCategory[],
    async execute(input): Promise<{ output: string; isError: boolean }> {
      const action = input.action as string;

      try {
        switch (action) {
          case "status":
            return await handleStatus(config);

          case "list":
            return await handleList(config);

          case "add":
            return await handleAdd(input, config);

          case "update":
            return await handleUpdate(input, config);

          case "remove":
            return await handleRemove(input, config);

          case "run":
            return await handleRun(input, config);

          case "runs":
            return await handleRuns(input, config);

          case "status_all":
            return await handleStatusAll(config);

          default:
            return { output: `Unknown action: ${action}`, isError: true };
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error("Cron tool error", { action, error: msg });
        return { output: `Error: ${msg}`, isError: true };
      }
    },
  };
}

async function handleStatus(
  _config: CronToolConfig,
): Promise<{ output: string; isError: boolean }> {
  const store = getStore();
  const jobs = await store.listJobs();
  const enabled = jobs.filter((j) => j.enabled);
  const nextDue = enabled
    .filter((j) => j.nextRunAt)
    .sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0))[0];
  return {
    output: JSON.stringify(
      {
        jobCount: jobs.length,
        enabledCount: enabled.length,
        nextDueAt: nextDue?.nextRunAt
          ? new Date(nextDue.nextRunAt * 1000).toISOString()
          : null,
        nextDueJob: nextDue?.name ?? null,
      },
      null,
      2,
    ),
    isError: false,
  };
}

async function handleList(
  _config: CronToolConfig,
): Promise<{ output: string; isError: boolean }> {
  const store = getStore();
  const jobs = await store.listJobs();
  const summary = jobs.map((j) => ({
    id: j.id,
    name: j.name,
    enabled: j.enabled,
    schedule: formatSchedule(j.schedule),
    nextRunAt: j.nextRunAt ? new Date(j.nextRunAt * 1000).toISOString() : null,
    lastStatus: j.lastStatus,
  }));
  return { output: JSON.stringify(summary, null, 2), isError: false };
}

async function handleAdd(
  input: Record<string, unknown>,
  config: CronToolConfig,
): Promise<{ output: string; isError: boolean }> {
  const name = input.name as string;
  const scheduleKind = input.schedule_kind as string;
  const message = input.message as string;

  if (!name || !scheduleKind || !message) {
    return {
      output: "Error: name, schedule_kind, and message are required",
      isError: true,
    };
  }

  const store = getStore();
  const existing = await store.listJobs();
  if (existing.length >= 50) {
    return { output: "Error: maximum 50 cron jobs reached", isError: true };
  }

  const schedule = buildSchedule(input);
  if (!schedule) {
    return { output: "Error: invalid schedule parameters", isError: true };
  }

  const nextRunAt = computeNextRunAt(schedule, Date.now());
  if (!nextRunAt && schedule.kind !== "at") {
    return { output: "Error: could not compute next run time", isError: true };
  }

  const payload: CronPayload = {
    kind: "agentTurn",
    message,
    agentId: (input.agent_id as string) ?? config.currentAgentId,
    timeoutSeconds: (input.timeout_seconds as number) ?? undefined,
  };

  const delivery: CronDelivery = input.deliver_channel
    ? {
        mode: "announce",
        channel: input.deliver_channel as string,
        chatId: input.deliver_chat_id as string,
      }
    : { mode: "none" };

  const jobInput: CronJobCreate = {
    name,
    schedule,
    payload,
    delivery,
    deleteAfterRun: (input.delete_after_run as boolean) ?? false,
  };

  const job = await store.addJob(jobInput);

  return {
    output: JSON.stringify(
      {
        created: true,
        id: job.id,
        name: job.name,
        schedule: formatSchedule(job.schedule),
        nextRunAt: job.nextRunAt
          ? new Date(job.nextRunAt * 1000).toISOString()
          : null,
      },
      null,
      2,
    ),
    isError: false,
  };
}

async function handleUpdate(
  input: Record<string, unknown>,
  _config: CronToolConfig,
): Promise<{ output: string; isError: boolean }> {
  const jobId = input.job_id as string;
  if (!jobId) return { output: "Error: job_id is required", isError: true };

  const store = getStore();
  const existing = await store.getJob(jobId);
  if (!existing) return { output: `Error: job not found: ${jobId}`, isError: true };

  const existingPayload = existing.payload;
  const patch: CronJobPatch = {
    name: input.name as string | undefined,
    enabled: input.enabled as boolean | undefined,
    schedule: input.schedule_kind
      ? (buildSchedule(input) ?? undefined)
      : undefined,
    payload: (input.message || input.agent_id || input.timeout_seconds)
      ? {
          kind: "agentTurn",
          message: (input.message as string | undefined) ?? existingPayload?.message ?? "",
          agentId: (input.agent_id as string | undefined) ?? existingPayload?.agentId,
          timeoutSeconds: (input.timeout_seconds as number | undefined) ?? existingPayload?.timeoutSeconds,
        }
      : undefined,
  };

  const job = await store.updateJob(jobId, patch);
  if (!job) return { output: `Error: job not found: ${jobId}`, isError: true };

  return {
    output: JSON.stringify(
      { updated: true, id: job.id, name: job.name, enabled: job.enabled },
      null,
      2,
    ),
    isError: false,
  };
}

async function handleRemove(
  input: Record<string, unknown>,
  _config: CronToolConfig,
): Promise<{ output: string; isError: boolean }> {
  const jobId = input.job_id as string;
  if (!jobId) return { output: "Error: job_id is required", isError: true };

  const store = getStore();
  const removed = await store.removeJob(jobId);
  return {
    output: removed ? `Job ${jobId} removed.` : `Job ${jobId} not found.`,
    isError: !removed,
  };
}

async function handleRun(
  input: Record<string, unknown>,
  _config: CronToolConfig,
): Promise<{ output: string; isError: boolean }> {
  const jobId = input.job_id as string;
  if (!jobId) return { output: "Error: job_id is required", isError: true };

  await sendCommand("cron", "cron:run_job", { jobId });
  return { output: `Job ${jobId} triggered.`, isError: false };
}

async function handleRuns(
  input: Record<string, unknown>,
  _config: CronToolConfig,
): Promise<{ output: string; isError: boolean }> {
  const jobId = input.job_id as string;
  if (!jobId) return { output: "Error: job_id is required", isError: true };

  const store = getStore();
  const runs = await store.getRunsForJob(jobId, 20);
  const summary = runs.map((r) => ({
    id: r.id,
    status: r.status,
    durationMs: r.durationMs,
    startedAt: new Date(r.startedAt * 1000).toISOString(),
    error: r.error,
    resultPreview: r.resultSummary?.slice(0, 200) ?? null,
  }));
  return { output: JSON.stringify(summary, null, 2), isError: false };
}

async function handleStatusAll(
  _config: CronToolConfig,
): Promise<{ output: string; isError: boolean }> {
  const db = getDb();

  try {
    // Get all jobs with their stats
    const store = getStore();
    const jobs = await store.listJobs();

    // Get run stats
    const runStats = await db`
      SELECT
        job_id,
        status,
        COUNT(*) as count,
        AVG(duration_ms) as avg_duration
      FROM cron_runs
      WHERE started_at >= ${Math.floor(Date.now() / 1000) - 30 * 86400}
      GROUP BY job_id, status
    `;

    // Get delivery stats
    const deliveryStats = await db`
      SELECT
        job_name,
        COUNT(*) as total,
        COUNT(delivered_at) as delivered
      FROM cron_deliveries
      WHERE created_at >= ${Math.floor(Date.now() / 1000) - 30 * 86400}
      GROUP BY job_name
    `;

    // Calculate aggregate stats
    let totalRuns = 0;
    let successCount = 0;
    let errorCount = 0;
    let timeoutCount = 0;

    for (const r of runStats) {
      totalRuns += Number(r.count);
      if (r.status === "ok") successCount += Number(r.count);
      else if (r.status === "error") errorCount += Number(r.count);
      else if (r.status === "timeout") timeoutCount += Number(r.count);
    }

    const successRate =
      totalRuns > 0 ? ((successCount / totalRuns) * 100).toFixed(1) : "0";

    const lines: string[] = [];

    // Jobs overview
    lines.push("=== Cron Jobs ===");
    for (const job of jobs) {
      const nextRun = job.nextRunAt
        ? new Date(job.nextRunAt * 1000).toLocaleString()
        : "not scheduled";
      const lastStatus = job.lastStatus || "never";
      lines.push(
        `${job.name}: ${job.enabled ? "enabled" : "disabled"} | Next: ${nextRun} | Last: ${lastStatus}`,
      );
    }

    // Run stats
    lines.push(`\n=== Run Stats (30 days) ===`);
    lines.push(`Total runs: ${totalRuns}`);
    lines.push(`Success: ${successCount} (${successRate}%)`);
    lines.push(`Errors: ${errorCount}`);
    lines.push(`Timeouts: ${timeoutCount}`);

    // Delivery stats
    if (deliveryStats.length > 0) {
      lines.push(`\n=== Delivery Stats (30 days) ===`);
      for (const d of deliveryStats) {
        const rate =
          Number(d.total) > 0
            ? (Number(d.delivered) / Number(d.total)) * 100
            : 0;
        lines.push(
          `${d.job_name}: ${d.delivered}/${d.total} delivered (${rate.toFixed(1)}%)`,
        );
      }
    }

    return { output: lines.join("\n"), isError: false };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { output: `Error getting cron status: ${msg}`, isError: true };
  }
}

function buildSchedule(input: Record<string, unknown>): CronSchedule | null {
  const kind = input.schedule_kind as string;

  if (kind === "at") {
    const at = input.at as string;
    if (!at) return null;
    const ts = new Date(at).getTime();
    if (isNaN(ts) || ts <= Date.now()) return null;
    return { kind: "at", at };
  }

  if (kind === "every") {
    const everyMs = input.every_ms as number;
    if (!everyMs || everyMs < 300_000) return null;
    return { kind: "every", everyMs };
  }

  if (kind === "cron") {
    const expr = input.cron_expr as string;
    if (!expr) return null;
    try {
      new Cron(expr);
    } catch {
      return null;
    }
    return { kind: "cron", expr, tz: (input.tz as string) ?? undefined };
  }

  return null;
}
