import type { Subprocess } from "bun";
import type { ResolvedProcessSpec } from "./manifest";
import { createLogger } from "../logger";
import { clearProcessCrashLoop, markProcessCrashLoop } from "./registry";
import type { ProcessName } from "./types";

const log = createLogger("orchestrator");

const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
const BACKOFF_RESET_STABLE_MS = 300_000; // 5 min stable → reset backoff
const GRACEFUL_SHUTDOWN_MS = 10_000;
const PING_TIMEOUT_MS = 2_000;

export const HUNG_STRIKES_MAX = 2; // miss 2 consecutive pings → hung

export interface ChildState {
  readonly spec: ResolvedProcessSpec;
  status: "running" | "backoff" | "crash-loop" | "stopped";
  proc: Subprocess | null;
  pid: number | null;
  startedAt: number | null;
  restartCount: number;
  restartsInWindow: number[];
  backoffMs: number;
  backoffTimer: ReturnType<typeof setTimeout> | null;
  nextRetryAt: number | null;
  stoppedByUser: boolean;
  lastPong: number;
  hungStrikes: number;
}

export function createInitialChildState(spec: ResolvedProcessSpec): ChildState {
  return {
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
}

export function spawnChild(
  state: ChildState,
  running: () => boolean,
  onScheduleRestart: (state: ChildState) => void,
): void {
  const { spec } = state;
  const cwd = process.cwd();

  log.info("Spawning child process", { name: spec.name, entry: spec.entry });

  const mergedEnv: Record<string, string | undefined> = { ...process.env };
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

  // A fresh spawn means we are no longer crash-looping; clear any persisted
  // marker so the monitor's crash-loop alert resolves. Fire-and-forget.
  clearProcessCrashLoop(spec.name as ProcessName).catch((err) => {
    log.error("Failed to clear crash-loop marker", {
      name: spec.name,
      error: err,
    });
  });

  proc.exited.then((exitCode) => {
    if (!running()) return;

    // Identity guard: only this spawn's own exit may mutate shared state. If a
    // newer spawn has already replaced state.proc (e.g. restartProcess killed
    // this proc and spawned a fresh one before this handler ran), this is a
    // stale exit event — ignore it so we don't null out the live child or
    // double-schedule a restart. This replaces the previous reliance on flag
    // timing (stoppedByUser being reset between kill and respawn).
    if (state.proc !== proc) {
      log.debug("Ignoring exit of superseded child process", {
        name: spec.name,
        pid: proc.pid,
        exitCode,
      });
      return;
    }

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

    onScheduleRestart(state);
  });
}

export function scheduleRestart(
  state: ChildState,
  running: () => boolean,
  onSpawn: (state: ChildState) => void,
): void {
  const { spec } = state;
  const now = Date.now();

  state.restartsInWindow = [
    ...state.restartsInWindow.filter(
      (t) => now - t < spec.restartWindowSec * 1000,
    ),
    now,
  ];
  state.restartCount += 1;

  if (state.restartsInWindow.length > spec.maxRestarts) {
    log.error("Crash-loop detected, stopping restarts", {
      name: spec.name,
      restarts: state.restartsInWindow.length,
      window: spec.restartWindowSec,
    });
    state.status = "crash-loop";
    // Persist the terminal transition so the monitor (a separate process) can
    // raise a critical alert. Fire-and-forget: a DB hiccup must not block the
    // lifecycle state machine, and the in-memory status is already authoritative.
    markProcessCrashLoop(spec.name as ProcessName).catch((err) => {
      log.error("Failed to persist crash-loop marker", {
        name: spec.name,
        error: err,
      });
    });
    return;
  }

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
    if (running() && !state.stoppedByUser) {
      onSpawn(state);
    }
  }, delay);
}

export function resetBackoffIfStable(state: ChildState): void {
  if (
    state.status === "running" &&
    state.startedAt &&
    Date.now() - state.startedAt > BACKOFF_RESET_STABLE_MS
  ) {
    if (state.backoffMs !== BACKOFF_INITIAL_MS) {
      state.backoffMs = BACKOFF_INITIAL_MS;
      state.restartsInWindow = [];
      log.info("Backoff reset after stable uptime", { name: state.spec.name });
    }
  }
}

export async function killChild(
  state: ChildState,
  gracefulMs = GRACEFUL_SHUTDOWN_MS,
): Promise<void> {
  if (state.backoffTimer) {
    clearTimeout(state.backoffTimer);
    state.backoffTimer = null;
  }

  if (!state.proc) return;

  const proc = state.proc;
  state.stoppedByUser = true;

  try {
    proc.kill("SIGTERM");

    const exited = await Promise.race([
      proc.exited,
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), gracefulMs),
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

export async function pingChildren(
  children: Map<string, ChildState>,
  onScheduleRestart: (state: ChildState) => void,
): Promise<void> {
  // Phase 1: fire all pings at once and snapshot each child's lastPong. We key
  // by the live Subprocess identity so a child that gets killed/respawned during
  // the wait window is not mis-evaluated against a different process.
  const pinged: Array<{
    name: string;
    state: ChildState;
    proc: Subprocess;
    pongBefore: number;
  }> = [];

  for (const [name, state] of children) {
    if (state.status !== "running" || !state.proc) continue;

    const proc = state.proc;
    try {
      proc.send("ping");
    } catch {
      // IPC channel closed — process is dying, reconcile will handle it
      continue;
    }

    pinged.push({ name, state, proc, pongBefore: state.lastPong });
  }

  if (pinged.length === 0) return;

  // Phase 2: wait a SINGLE timeout window for all pongs (O(1) wall-clock instead
  // of O(children) × PING_TIMEOUT_MS), then evaluate everyone.
  await new Promise((r) => setTimeout(r, PING_TIMEOUT_MS));

  for (const { name, state, proc, pongBefore } of pinged) {
    // Skip if this child was replaced or torn down during the wait.
    if (state.proc !== proc || state.status !== "running") continue;
    if (state.lastPong !== pongBefore) continue;

    state.hungStrikes += 1;
    log.warn("Process missed ping/pong", {
      name,
      pid: state.pid,
      strikes: state.hungStrikes,
      maxStrikes: HUNG_STRIKES_MAX,
    });

    if (state.hungStrikes < HUNG_STRIKES_MAX) continue;

    log.error("Killing hung process (no pong response)", {
      name,
      pid: state.pid,
      lastPongAgo: Date.now() - state.lastPong,
    });

    try {
      proc.kill("SIGKILL");
    } catch {
      // Already dead
    }
    state.proc = null;
    state.pid = null;
    state.hungStrikes = 0;

    if (!state.stoppedByUser && state.spec.restartPolicy !== "never") {
      onScheduleRestart(state);
    } else {
      state.status = "stopped";
    }
  }
}
