import type { Subprocess } from "bun";
import type { OpenCrowConfig } from "../config/schema";
import type { AgentRegistry } from "../agents/registry";
import { resolveManifest, type ResolvedProcessSpec } from "./manifest";
import { listProcesses } from "./registry";
import { createLogger } from "../logger";

const log = createLogger("orchestrator");

const RECONCILE_INTERVAL_MS = 5_000;
const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
const BACKOFF_RESET_STABLE_MS = 300_000; // 5 min stable → reset backoff
const GRACEFUL_SHUTDOWN_MS = 10_000;
const PING_TIMEOUT_MS = 2_000;
const PING_INTERVAL_MS = 15_000;
const HUNG_STRIKES_MAX = 2; // miss 2 consecutive pings → hung

interface ChildState {
  readonly spec: ResolvedProcessSpec;
  status: "running" | "backoff" | "crash-loop" | "stopped";
  proc: Subprocess | null;
  pid: number | null;
  startedAt: number | null;
  restartCount: number;
  restartsInWindow: number[]; // timestamps of recent crashes
  backoffMs: number;
  backoffTimer: ReturnType<typeof setTimeout> | null;
  nextRetryAt: number | null;
  stoppedByUser: boolean;
  lastPong: number;
  hungStrikes: number;
}

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

  function spawnChild(state: ChildState): void {
    const { spec } = state;
    const cwd = process.cwd();

    log.info("Spawning child process", { name: spec.name, entry: spec.entry });

    const mergedEnv: Record<string, string | undefined> = {
      ...process.env,
    };
    if (spec.env) {
      for (const [k, v] of Object.entries(spec.env)) {
        mergedEnv[k] = v;
      }
    }

    const proc = Bun.spawn([process.execPath, "run", spec.entry], {
      cwd,
      env: mergedEnv,
      stdout: "inherit",
      stderr: "inherit",
      ipc(message) {
        if (message === "pong") {
          state.lastPong = Date.now();
          state.hungStrikes = 0;
        }
      },
    });

    state.proc = proc;
    state.pid = proc.pid;
    state.startedAt = Date.now();
    state.status = "running";
    state.lastPong = Date.now();
    state.hungStrikes = 0;

    // Handle child exit
    proc.exited.then((exitCode) => {
      if (!running) return; // shutting down, don't restart

      log.warn("Child process exited", {
        name: spec.name,
        pid: proc.pid,
        exitCode,
      });

      state.proc = null;
      state.pid = null;

      if (state.stoppedByUser) {
        state.status = "stopped";
        return;
      }

      if (spec.restartPolicy === "never") {
        state.status = "stopped";
        return;
      }

      if (spec.restartPolicy === "on-failure" && exitCode === 0) {
        state.status = "stopped";
        return;
      }

      scheduleRestart(state);
    });
  }

  function scheduleRestart(state: ChildState): void {
    const { spec } = state;
    const now = Date.now();

    // Track crashes in window
    state.restartsInWindow = [
      ...state.restartsInWindow.filter(
        (t) => now - t < spec.restartWindowSec * 1000,
      ),
      now,
    ];
    state.restartCount += 1;

    // Crash-loop detection
    if (state.restartsInWindow.length > spec.maxRestarts) {
      log.error("Crash-loop detected, stopping restarts", {
        name: spec.name,
        restarts: state.restartsInWindow.length,
        window: spec.restartWindowSec,
      });
      state.status = "crash-loop";
      return;
    }

    // Exponential backoff
    state.status = "backoff";
    const delay = state.backoffMs;
    state.backoffMs = Math.min(state.backoffMs * 2, BACKOFF_MAX_MS);

    log.info("Scheduling restart", {
      name: spec.name,
      delayMs: delay,
      restartCount: state.restartCount,
    });

    state.nextRetryAt = Date.now() + delay;
    state.backoffTimer = setTimeout(() => {
      state.backoffTimer = null;
      state.nextRetryAt = null;
      if (running && !state.stoppedByUser) {
        spawnChild(state);
      }
    }, delay);
  }

  function resetBackoffIfStable(state: ChildState): void {
    if (
      state.status === "running" &&
      state.startedAt &&
      Date.now() - state.startedAt > BACKOFF_RESET_STABLE_MS
    ) {
      if (state.backoffMs !== BACKOFF_INITIAL_MS) {
        state.backoffMs = BACKOFF_INITIAL_MS;
        state.restartsInWindow = [];
        log.info("Backoff reset after stable uptime", {
          name: state.spec.name,
        });
      }
    }
  }

  async function pingChildren(): Promise<void> {
    // Snapshot before any await so concurrent reconcile() mutations to the map
    // don't affect iteration (entries added/removed mid-loop).
    const snapshot = Array.from(children.entries());
    for (const [name, state] of snapshot) {
      if (state.status !== "running" || !state.proc) continue;

      // Send ping via IPC
      try {
        state.proc.send("ping");
      } catch {
        // IPC channel closed — process is dying, reconcile will handle it
        continue;
      }

      // Wait for pong
      const pongBefore = state.lastPong;
      await new Promise((r) => setTimeout(r, PING_TIMEOUT_MS));

      if (state.lastPong === pongBefore && state.status === "running" && state.proc) {
        state.hungStrikes += 1;
        log.warn("Process missed ping/pong", {
          name,
          pid: state.pid,
          strikes: state.hungStrikes,
          maxStrikes: HUNG_STRIKES_MAX,
        });

        if (state.hungStrikes >= HUNG_STRIKES_MAX) {
          log.error("Killing hung process (no pong response)", {
            name,
            pid: state.pid,
            lastPongAgo: Date.now() - state.lastPong,
          });

          try {
            state.proc.kill("SIGKILL");
          } catch {
            // Already dead
          }
          state.proc = null;
          state.pid = null;
          state.hungStrikes = 0;

          // Schedule restart
          if (!state.stoppedByUser && state.spec.restartPolicy !== "never") {
            scheduleRestart(state);
          } else {
            state.status = "stopped";
          }
        }
      }
    }
  }

  async function reconcile(): Promise<void> {
    const desiredSpecs = resolveManifest(config, agentRegistry.agents);
    const desiredNames = new Set(desiredSpecs.map((s) => s.name));

    // Spawn missing processes
    for (const spec of desiredSpecs) {
      const existing = children.get(spec.name);
      if (!existing) {
        const state: ChildState = {
          spec,
          status: "running",
          proc: null,
          pid: null,
          startedAt: null,
          restartCount: 0,
          restartsInWindow: [],
          backoffMs: BACKOFF_INITIAL_MS,
          backoffTimer: null,
          nextRetryAt: null,
          stoppedByUser: false,
          lastPong: Date.now(),
          hungStrikes: 0,
        };
        children.set(spec.name, state);
        spawnChild(state);
      } else {
        // Reset stable backoff
        resetBackoffIfStable(existing);
      }
    }

    // Kill extras (processes no longer in manifest)
    for (const [name, state] of children) {
      if (!desiredNames.has(name)) {
        log.info("Killing extra process not in manifest", { name });
        await killChild(state);
        children.delete(name);
      }
    }
  }

  async function killChild(state: ChildState): Promise<void> {
    if (state.backoffTimer) {
      clearTimeout(state.backoffTimer);
      state.backoffTimer = null;
    }

    if (!state.proc) return;

    const proc = state.proc;
    state.stoppedByUser = true;

    try {
      proc.kill("SIGTERM");

      // Wait for graceful exit or force kill
      const exited = await Promise.race([
        proc.exited,
        new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), GRACEFUL_SHUTDOWN_MS),
        ),
      ]);

      if (exited === "timeout") {
        log.warn("Child did not exit gracefully, sending SIGKILL", {
          name: state.spec.name,
          pid: proc.pid,
        });
        proc.kill("SIGKILL");
      }
    } catch {
      // Process already dead
    }

    state.proc = null;
    state.pid = null;
  }

  async function cleanupOrphans(): Promise<void> {
    try {
      const dbProcesses = await listProcesses();
      const now = Math.floor(Date.now() / 1000);

      for (const rec of dbProcesses) {
        // Skip core itself
        if (rec.name === "core") continue;

        const age = now - rec.lastHeartbeat;
        if (age > 60) {
          // Stale process, try to kill
          try {
            process.kill(rec.pid, 0); // Check if alive
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

    // Send SIGTERM to all
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
        pingChildren().catch((err) => {
          log.error("Ping check failed", { error: err });
        });
      }, PING_INTERVAL_MS);

      // Graceful shutdown handlers — once() prevents accumulation across start/stop cycles
      const shutdown = () => {
        gracefulShutdown().then(() => process.exit(0));
      };
      process.once("SIGTERM", shutdown);
      process.once("SIGINT", shutdown);

      log.info("Orchestrator started", {
        childCount: children.size,
      });
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
      state.backoffMs = BACKOFF_INITIAL_MS;

      if (!state.proc) {
        spawnChild(state);
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
      state.backoffMs = BACKOFF_INITIAL_MS;

      if (state.proc) {
        await killChild(state);
        state.stoppedByUser = false;
        if (running) spawnChild(state);
      } else {
        spawnChild(state);
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
