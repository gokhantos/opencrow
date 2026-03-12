import type { OpenCrowConfig } from "../config/schema";
import type { AgentRegistry } from "../agents/registry";
import { resolveManifest } from "./manifest";
import { listProcesses } from "./registry";
import { createLogger } from "../logger";
import {
  type ChildState,
  createInitialChildState,
  spawnChild,
  scheduleRestart,
  resetBackoffIfStable,
  killChild,
  pingChildren,
} from "./child-lifecycle";

const log = createLogger("orchestrator");

const RECONCILE_INTERVAL_MS = 5_000;
const PING_INTERVAL_MS = 15_000;

export interface OrchestratorProcessView {
  readonly name: string;
  readonly desired: boolean;
  readonly status:
    | "running"
    | "starting"
    | "backoff"
    | "crash-loop"
    | "stopped";
  readonly syncStatus:
    | "synced"
    | "starting"
    | "restarting"
    | "crash-loop"
    | "stopped";
  readonly pid: number | null;
  readonly restartCount: number;
  readonly uptimeSeconds: number | null;
  readonly backoffMs: number;
  readonly nextRetryAt: number | null;
}

export interface Orchestrator {
  start(): Promise<void>;
  stop(): Promise<void>;
  getState(): readonly OrchestratorProcessView[];
  stopProcess(name: string): Promise<void>;
  startProcess(name: string): void;
  restartProcess(name: string): Promise<void>;
  refreshManifest(): Promise<void>;
  updateConfig(config: OpenCrowConfig): void;
}

export function createOrchestrator(
  initialConfig: OpenCrowConfig,
  agentRegistry: AgentRegistry,
): Orchestrator {
  const children = new Map<string, ChildState>();
  let reconcileTimer: ReturnType<typeof setInterval> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let config = initialConfig;

  // Bind lifecycle callbacks to local closure
  const isRunning = () => running;

  const doSpawn = (state: ChildState) =>
    spawnChild(state, isRunning, doScheduleRestart);

  const doScheduleRestart = (state: ChildState) =>
    scheduleRestart(state, isRunning, doSpawn);

  async function reconcile(): Promise<void> {
    const desiredSpecs = resolveManifest(config, agentRegistry.agents);
    const desiredNames = new Set(desiredSpecs.map((s) => s.name));

    for (const spec of desiredSpecs) {
      const existing = children.get(spec.name);
      if (!existing) {
        const state = createInitialChildState(spec);
        children.set(spec.name, state);
        doSpawn(state);
      } else {
        resetBackoffIfStable(existing);
      }
    }

    for (const [name, state] of children) {
      if (!desiredNames.has(name)) {
        log.info("Killing extra process not in manifest", { name });
        await killChild(state);
        children.delete(name);
      }
    }
  }

  async function cleanupOrphans(): Promise<void> {
    try {
      const dbProcesses = await listProcesses();
      const now = Math.floor(Date.now() / 1000);

      for (const rec of dbProcesses) {
        if (rec.name === "core") continue;

        const age = now - rec.lastHeartbeat;
        if (age > 60) {
          try {
            process.kill(rec.pid, 0);
            log.warn("Killing orphaned process", {
              name: rec.name,
              pid: rec.pid,
              staleSec: age,
            });
            process.kill(rec.pid, "SIGTERM");
          } catch {
            // Process already dead, ignore
          }
        }
      }
    } catch (err) {
      log.error("Orphan cleanup failed", { error: err });
    }
  }

  async function gracefulShutdown(): Promise<void> {
    if (!running) return;
    running = false;

    log.info("Orchestrator shutting down, stopping all children");

    if (reconcileTimer) {
      clearInterval(reconcileTimer);
      reconcileTimer = null;
    }
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }

    const killPromises: Promise<void>[] = [];
    for (const [, state] of children) {
      if (state.proc) {
        state.stoppedByUser = true;
        killPromises.push(killChild(state));
      }
      if (state.backoffTimer) {
        clearTimeout(state.backoffTimer);
        state.backoffTimer = null;
      }
    }

    await Promise.allSettled(killPromises);
    children.clear();
    log.info("Orchestrator shutdown complete");
  }

  function getView(state: ChildState): OrchestratorProcessView {
    const nowMs = Date.now();
    const uptimeSeconds =
      state.startedAt && state.status === "running"
        ? Math.floor((nowMs - state.startedAt) / 1000)
        : null;

    let syncStatus: OrchestratorProcessView["syncStatus"];
    switch (state.status) {
      case "running":
        syncStatus = "synced";
        break;
      case "backoff":
        syncStatus = state.restartCount > 0 ? "restarting" : "starting";
        break;
      case "crash-loop":
        syncStatus = "crash-loop";
        break;
      case "stopped":
        syncStatus = "stopped";
        break;
      default:
        syncStatus = "starting";
    }

    return {
      name: state.spec.name,
      desired: !state.stoppedByUser,
      status: state.status === "running" ? "running" : state.status,
      syncStatus,
      pid: state.pid,
      restartCount: state.restartCount,
      uptimeSeconds,
      backoffMs: state.backoffMs,
      nextRetryAt: state.nextRetryAt,
    };
  }

  return {
    async start(): Promise<void> {
      if (running) return;
      running = true;

      log.info("Orchestrator starting");

      await cleanupOrphans();
      await reconcile();

      reconcileTimer = setInterval(() => {
        reconcile().catch((err) => {
          log.error("Reconciliation failed", { error: err });
        });
      }, RECONCILE_INTERVAL_MS);

      pingTimer = setInterval(() => {
        pingChildren(children, doScheduleRestart).catch((err) => {
          log.error("Ping check failed", { error: err });
        });
      }, PING_INTERVAL_MS);

      // Graceful shutdown handlers — once() prevents accumulation across start/stop cycles
      const shutdown = () => {
        gracefulShutdown().then(() => process.exit(0));
      };
      process.once("SIGTERM", shutdown);
      process.once("SIGINT", shutdown);

      log.info("Orchestrator started", { childCount: children.size });
    },

    async stop(): Promise<void> {
      await gracefulShutdown();
    },

    getState(): readonly OrchestratorProcessView[] {
      return Array.from(children.values()).map(getView);
    },

    async stopProcess(name: string): Promise<void> {
      const state = children.get(name);
      if (!state) {
        log.warn("stopProcess: unknown process", { name });
        return;
      }

      state.stoppedByUser = true;
      if (state.backoffTimer) {
        clearTimeout(state.backoffTimer);
        state.backoffTimer = null;
      }

      if (state.proc) {
        await killChild(state);
      }
      state.status = "stopped";
    },

    startProcess(name: string): void {
      const state = children.get(name);
      if (!state) {
        log.warn("startProcess: unknown process", { name });
        return;
      }

      state.stoppedByUser = false;
      state.restartCount = 0;
      state.restartsInWindow = [];
      state.backoffMs = 1_000;

      if (!state.proc) {
        doSpawn(state);
      }
    },

    async restartProcess(name: string): Promise<void> {
      const state = children.get(name);
      if (!state) {
        log.warn("restartProcess: unknown process", { name });
        return;
      }

      state.stoppedByUser = false;
      state.restartCount = 0;
      state.restartsInWindow = [];
      state.backoffMs = 1_000;

      if (state.proc) {
        await killChild(state);
        state.stoppedByUser = false;
        if (running) doSpawn(state);
      } else {
        doSpawn(state);
      }
    },

    async refreshManifest(): Promise<void> {
      if (running) {
        await reconcile();
      }
    },

    updateConfig(newConfig: OpenCrowConfig): void {
      config = newConfig;
    },
  };
}
