import type { CronJob, CronRunRecord, CronProgressEntry } from "./types";
import type { CronStore } from "./store";
import type { AgentRegistry } from "../agents/registry";
import type { ToolRegistry } from "../tools/registry";
import type { Channel } from "../channels/types";
import type { ResolvedAgent } from "../agents/types";
import type { DeliveryStore } from "./delivery-store";
import type { ProgressEvent } from "../agent/types";
import { runAgentIsolated } from "../agents/runner";
import { computeNextRunAt } from "./schedule";
import { archiveStaleSignals } from "../sources/ideas/signals-store";

import { createLogger } from "../logger";
import { getErrorMessage } from "../lib/error-serialization";

const log = createLogger("cron:executor");

export interface ExecutorDeps {
  readonly cronStore: CronStore;
  readonly agentRegistry: AgentRegistry;
  readonly baseToolRegistry: ToolRegistry | null;
  readonly channels: ReadonlyMap<string, Channel>;
  readonly defaultTimeoutSeconds: number;
  readonly deliveryStore?: DeliveryStore;
  readonly buildRegistryForAgent?: (
    agent: ResolvedAgent,
  ) => ToolRegistry | null;
  readonly buildSystemPrompt?: (
    agent: ResolvedAgent,
    basePrompt: string,
  ) => Promise<string>;
}

const PROGRESS_FLUSH_INTERVAL_MS = 2000;
const MAX_PROGRESS_TEXT_LENGTH = 200;

/**
 * Execute internal handlers (e.g., signal-archival, db-retention) without spawning an agent
 */
async function executeInternalHandler(
  job: CronJob,
  handler: string,
  runId: string,
  startedAt: number,
  startMs: number,
  deps: ExecutorDeps,
): Promise<CronRunRecord> {
  const runningRecord: CronRunRecord = {
    id: runId,
    jobId: job.id,
    status: "running",
    resultSummary: null,
    error: null,
    durationMs: null,
    startedAt,
    endedAt: null,
    progress: null,
  };
  await deps.cronStore.addRun(runningRecord);

  let status: CronRunRecord["status"] = "ok";
  let resultSummary: string | null = null;
  let error: string | null = null;

  try {
    switch (handler) {
      case "signal-archival":
        const archivedCount = await archiveStaleSignals(14);
        resultSummary = `Signal archival: ${archivedCount} stale signals archived`;
        break;
      case "idea-archival": {
        const { archiveStaleIdeas } = await import("../sources/ideas/store");
        const archivedIdeaCount = await archiveStaleIdeas(14);
        resultSummary = `Idea archival: ${archivedIdeaCount} stale ideas archived`;
        break;
      }
      case "db-retention": {
        const { runDbRetention } = await import("./db-retention");
        const retentionResult = await runDbRetention();
        resultSummary = `DB retention: ${retentionResult.totalDeleted} rows deleted across ${retentionResult.details.length} tables`;
        break;
      }
      default:
        throw new Error(`Unknown internal handler: ${handler}`);
    }
  } catch (err) {
    const msg = getErrorMessage(err);
    status = "error";
    error = msg;
    log.error("Internal cron handler failed", {
      jobId: job.id,
      handler,
      error: msg,
    });
  }

  const endedAt = Math.floor(Date.now() / 1000);
  const durationMs = Date.now() - startMs;

  await deps.cronStore.updateRunStatus(
    runId,
    status,
    resultSummary,
    error,
    durationMs,
    endedAt,
  );
  await deps.cronStore.setJobLastRun(job.id, status, error);

  if (job.deleteAfterRun) {
    await deps.cronStore.removeJob(job.id);
    log.info("Internal cron job deleted after run", { jobId: job.id });
  } else {
    const nextRunAt = computeNextRunAt(job.schedule, Date.now());
    await deps.cronStore.setJobNextRun(job.id, nextRunAt ?? null);
  }

  return {
    id: runId,
    jobId: job.id,
    status,
    resultSummary,
    error,
    durationMs,
    startedAt,
    endedAt,
    progress: null,
  };
}

function progressEntryFromEvent(
  event: ProgressEvent,
): CronProgressEntry | null {
  switch (event.type) {
    case "thinking":
      return {
        type: "thinking",
        text: event.summary.slice(0, MAX_PROGRESS_TEXT_LENGTH),
        ts: Date.now(),
      };
    case "tool_start":
      return {
        type: "tool_start",
        text: event.tool.slice(0, MAX_PROGRESS_TEXT_LENGTH),
        ts: Date.now(),
      };
    case "tool_done":
      return {
        type: "tool_done",
        text: (event.result ?? event.tool).slice(0, MAX_PROGRESS_TEXT_LENGTH),
        ts: Date.now(),
      };
    case "iteration":
      if (event.iteration <= 1) return null;
      return {
        type: "iteration",
        text: `Step ${event.iteration}`,
        ts: Date.now(),
      };
    case "subagent_start":
      return {
        type: "subagent_start",
        text: `${event.childAgent}: ${event.task}`.slice(
          0,
          MAX_PROGRESS_TEXT_LENGTH,
        ),
        ts: Date.now(),
      };
    case "subagent_done":
      return {
        type: "subagent_done",
        text: event.childAgent.slice(0, MAX_PROGRESS_TEXT_LENGTH),
        ts: Date.now(),
      };
    default:
      return null;
  }
}

export async function executeCronJob(
  job: CronJob,
  deps: ExecutorDeps,
): Promise<CronRunRecord> {
  const startedAt = Math.floor(Date.now() / 1000);
  const startMs = Date.now();
  const runId = crypto.randomUUID();

  log.info("Executing cron job", { jobId: job.id, name: job.name, runId });

  // Check if this is an internal handler
  if (job.payload.kind === "internal" && job.payload.handler) {
    return await executeInternalHandler(
      job,
      job.payload.handler,
      runId,
      startedAt,
      startMs,
      deps,
    );
  }

  const agentId = job.payload.agentId ?? deps.agentRegistry.getDefault().id;

  // 1. Create a 'running' record BEFORE execution
  const runningRecord: CronRunRecord = {
    id: runId,
    jobId: job.id,
    status: "running",
    resultSummary: null,
    error: null,
    durationMs: null,
    startedAt,
    endedAt: null,
    progress: null,
  };
  await deps.cronStore.addRun(runningRecord);

  // 2. Build progress collector with periodic DB flush
  const progressEntries: CronProgressEntry[] = [];
  let flushTimer: ReturnType<typeof setInterval> | null = null;
  let lastFlushedLength = 0;

  async function flushProgress(): Promise<void> {
    if (progressEntries.length === lastFlushedLength) return;
    lastFlushedLength = progressEntries.length;
    try {
      await deps.cronStore.updateRunProgress(
        runId,
        JSON.stringify(progressEntries),
      );
    } catch (err) {
      log.warn("Failed to flush cron progress", { runId, err });
    }
  }

  function onProgress(event: ProgressEvent): void {
    const entry = progressEntryFromEvent(event);
    if (entry) {
      progressEntries.push(entry);
    }
  }

  flushTimer = setInterval(flushProgress, PROGRESS_FLUSH_INTERVAL_MS);

  let status: CronRunRecord["status"] = "ok";
  let resultSummary: string | null = null;
  let error: string | null = null;

  const task = job.payload.message ?? "";

  try {
    const result = await runAgentIsolated({
      agentRegistry: deps.agentRegistry,
      baseToolRegistry: deps.baseToolRegistry,
      agentId,
      task,
      buildRegistryForAgent: deps.buildRegistryForAgent,
      buildSystemPrompt: deps.buildSystemPrompt,
      onProgress,
      usageContext: {
        channel: "cron",
        chatId: job.id,
        source: "cron" as const,
      },
    });

    resultSummary = result.text.slice(0, 2000);

    const deliveryText = result.text;

    if (
      job.delivery.mode === "announce" &&
      job.delivery.channel &&
      job.delivery.chatId
    ) {
      const channel = deps.channels.get(job.delivery.channel);
      const locallyAvailable = channel && channel.isConnected();

      if (locallyAvailable) {
        await deliverResult(
          job.delivery.channel,
          job.delivery.chatId,
          job.name,
          deliveryText,
          deps.channels,
        );
      } else if (deps.deliveryStore) {
        await deps.deliveryStore.enqueue({
          channel: job.delivery.channel,
          chatId: job.delivery.chatId,
          jobName: job.name,
          text: deliveryText,
          preformatted: false,
        });
        log.info("Queued cron delivery for remote channel", {
          channel: job.delivery.channel,
          chatId: job.delivery.chatId,
          jobName: job.name,
        });
      } else {
        log.warn(
          "Cannot deliver cron result: channel not available and no delivery store",
          {
            channel: job.delivery.channel,
          },
        );
      }
    }
  } catch (err) {
    const msg = getErrorMessage(err);

    if (msg.includes("timed out")) {
      status = "timeout";
      error = msg;
    } else {
      status = "error";
      error = msg;
    }

    log.error("Cron job failed", { jobId: job.id, error: msg });
  } finally {
    if (flushTimer) clearInterval(flushTimer);
  }

  // 3. Final flush + update completed status
  const endedAt = Math.floor(Date.now() / 1000);
  const durationMs = Date.now() - startMs;

  await flushProgress();
  await deps.cronStore.updateRunStatus(
    runId,
    status,
    resultSummary,
    error,
    durationMs,
    endedAt,
  );
  await deps.cronStore.setJobLastRun(job.id, status, error);

  if (job.deleteAfterRun) {
    await deps.cronStore.removeJob(job.id);
    log.info("Cron job deleted after run", { jobId: job.id });
  } else {
    const nextRunAt = computeNextRunAt(job.schedule, Date.now());
    await deps.cronStore.setJobNextRun(job.id, nextRunAt ?? null);
  }

  return {
    id: runId,
    jobId: job.id,
    status,
    resultSummary,
    error,
    durationMs,
    startedAt,
    endedAt,
    progress: progressEntries.length > 0 ? progressEntries : null,
  };
}

async function deliverResult(
  channelName: string,
  chatId: string,
  jobName: string,
  text: string,
  channels: ReadonlyMap<string, Channel>,
): Promise<void> {
  const channel = channels.get(channelName);
  if (!channel) {
    log.warn("Delivery channel not found", { channelName });
    return;
  }

  if (!channel.isConnected()) {
    log.warn("Delivery channel not connected", { channelName });
    return;
  }

  const truncated =
    text.length > 3000 ? text.slice(0, 3000) + "\n\n[Truncated]" : text;
  const message = `[Cron: ${jobName}]\n\n${truncated}`;

  try {
    await channel.sendMessage(chatId, { text: message });
  } catch (error) {
    log.warn("Failed to deliver cron result", { channelName, chatId, error });
  }
}
