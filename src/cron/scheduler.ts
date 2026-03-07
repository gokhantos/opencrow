import type { CronStore } from "./store";
import type { CronConfig, ToolsConfig } from "../config/schema";
import type { AgentRegistry } from "../agents/registry";
import type { ToolRegistry } from "../tools/registry";
import type { Channel } from "../channels/types";
import type { ResolvedAgent } from "../agents/types";
import type { DeliveryStore } from "./delivery-store";
import { executeCronJob } from "./executor";
import {
  consumePendingCommands,
  acknowledgeCommand,
} from "../process/commands";
import { createLogger } from "../logger";

const log = createLogger("cron:scheduler");

const DEFAULT_MAX_CONCURRENCY = 4;

export interface CronSchedulerDeps {
  readonly cronStore: CronStore;
  readonly agentRegistry: AgentRegistry;
  readonly baseToolRegistry: ToolRegistry | null;
  readonly channels: ReadonlyMap<string, Channel>;
  readonly config: CronConfig;
  readonly toolsConfig: ToolsConfig;
  readonly buildRegistryForAgent?: (
    agent: ResolvedAgent,
  ) => ToolRegistry | null;
  readonly buildSystemPrompt?: (
    agent: ResolvedAgent,
    basePrompt: string,
  ) => Promise<string>;
  readonly deliveryStore?: DeliveryStore;
}

export interface CronScheduler {
  start(): void;
  stop(): void;
  runJobNow(jobId: string): Promise<void>;
  getStatus(): Promise<CronSchedulerStatus>;
}

export interface CronSchedulerStatus {
  readonly running: boolean;
  readonly jobCount: number;
  readonly nextDueAt: number | null;
}

export function createCronScheduler(deps: CronSchedulerDeps): CronScheduler {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let ticking = false;

  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;

    try {
      const dueJobs = await deps.cronStore.getDueJobs(Date.now());
      const maxConcurrency = deps.config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;

      // Run jobs concurrently (ordered by priority from getDueJobs)
      const executing = new Set<Promise<unknown>>();
      for (const job of dueJobs) {
        const task = executeCronJob(job, {
          cronStore: deps.cronStore,
          agentRegistry: deps.agentRegistry,
          baseToolRegistry: deps.baseToolRegistry,
          channels: deps.channels,
          defaultTimeoutSeconds: deps.config.defaultTimeoutSeconds,
          buildRegistryForAgent: deps.buildRegistryForAgent,
          buildSystemPrompt: deps.buildSystemPrompt,
          deliveryStore: deps.deliveryStore,
        }).catch((error) => {
          log.error("Cron job execution failed", { jobId: job.id, error });
        });
        executing.add(task);
        task.finally(() => executing.delete(task));
        if (executing.size >= maxConcurrency) {
          await Promise.race(executing);
        }
      }
      await Promise.all(executing);

      // Process "run now" commands from other processes (web UI)
      const commands = await consumePendingCommands("cron");
      for (const cmd of commands) {
        if (cmd.action !== "cron:run_job") continue;
        await acknowledgeCommand(cmd.id);
        const jobId = cmd.payload.jobId as string;
        if (!jobId) continue;
        const job = await deps.cronStore.getJob(jobId);
        if (!job) {
          log.warn("cron:run_job command for unknown job", { jobId });
          continue;
        }
        log.info("Running job via command", { jobId, jobName: job.name });
        executeCronJob(job, {
          cronStore: deps.cronStore,
          agentRegistry: deps.agentRegistry,
          baseToolRegistry: deps.baseToolRegistry,
          channels: deps.channels,
          defaultTimeoutSeconds: deps.config.defaultTimeoutSeconds,
          buildRegistryForAgent: deps.buildRegistryForAgent,
          buildSystemPrompt: deps.buildSystemPrompt,
          deliveryStore: deps.deliveryStore,
        }).catch((error) => {
          log.error("Manual cron job execution failed", { jobId, error });
        });
      }
    } catch (error) {
      log.error("Cron tick error", error);
    } finally {
      ticking = false;
    }
  }

  return {
    start(): void {
      if (running) return;
      running = true;

      // Mark orphaned 'running' records from a previous crash as error
      deps.cronStore.cleanupStaleRuns().catch((err) => {
        log.error("Failed to cleanup stale cron runs", { err });
      });

      timer = setInterval(tick, deps.config.tickIntervalMs);
      log.info("Cron scheduler started", {
        tickIntervalMs: deps.config.tickIntervalMs,
      });
    },

    stop(): void {
      if (!running) return;
      running = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      log.info("Cron scheduler stopped");
    },

    async runJobNow(jobId: string): Promise<void> {
      const job = await deps.cronStore.getJob(jobId);
      if (!job) {
        throw new Error(`Cron job not found: ${jobId}`);
      }

      // Fire-and-forget: don't block the HTTP response on agent execution
      executeCronJob(job, {
        cronStore: deps.cronStore,
        agentRegistry: deps.agentRegistry,
        baseToolRegistry: deps.baseToolRegistry,
        channels: deps.channels,
        defaultTimeoutSeconds: deps.config.defaultTimeoutSeconds,
        buildRegistryForAgent: deps.buildRegistryForAgent,
        buildSystemPrompt: deps.buildSystemPrompt,
        deliveryStore: deps.deliveryStore,
      }).catch((error) => {
        log.error("Manual cron job execution failed", { jobId, error });
      });
    },

    async getStatus(): Promise<CronSchedulerStatus> {
      const jobs = await deps.cronStore.listJobs();
      const enabledJobs = jobs.filter((j) => j.enabled && j.nextRunAt !== null);
      const nextDueAt =
        enabledJobs.length > 0
          ? Math.min(...enabledJobs.map((j) => j.nextRunAt!))
          : null;

      return {
        running,
        jobCount: jobs.length,
        nextDueAt,
      };
    },
  };
}
