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

/**
 * Default time to wait for a pong before counting a missed ping.
 *
 * 2 s was unreasonably tight: any Bun process briefly busy under load (a GC
 * pause, a burst of synchronous work) can blow a 2 s window and get falsely
 * flagged. 6 s gives a comfortable margin for normal processes while still
 * detecting a truly wedged event loop within ~2 cycles. Override per-process
 * via ResolvedProcessSpec.heartbeat.pingTimeoutMs.
 */
export const PING_TIMEOUT_MS = 6_000;

// Miss this many consecutive pings → hung. Override per-process via
// ResolvedProcessSpec.heartbeat.hungStrikesMax.
export const HUNG_STRIKES_MAX = 2;

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

/**
 * Best-effort kill of an entire process group.
 *
 * Children are spawned `detached` (POSIX `setsid()`), so each child is the
 * leader of its own process group whose PGID equals the child PID. Signalling
 * the negative PID delivers to every member of that group — including the
 * agent-SDK CLI grandchildren that would otherwise be orphaned and leak ~300MB
 * each. We always also signal the leader directly (some platforms/processes
 * ignore the group signal), and fall back to a single-process kill if the
 * negative-pid group signal is rejected (group already gone, EPERM, or the
 * platform does not support it).
 */
function killProcessGroup(
  proc: Subprocess,
  name: string,
  signal: NodeJS.Signals = "SIGKILL",
): void {
  const pid = proc.pid;
  let groupKilled = false;
  if (typeof pid === "number" && pid > 1) {
    // PID-reuse guard: only signal the GROUP if the leader is still alive. A
    // child can exit-and-be-reaped before its `proc.exited` handler nulls
    // state.proc, after which the kernel may recycle its PID (== its PGID) to an
    // unrelated same-uid process group — `process.kill(-pid)` would then kill
    // that innocent group. `kill(pid, 0)` throws ESRCH once the PID is free, so
    // we skip the group signal in that window. (Same precheck the orchestrator's
    // orphan reaper uses before SIGTERM.) The direct `proc.kill` below is a
    // safe no-op on a reaped Bun Subprocess, so liveness still degrades cleanly.
    let leaderAlive = false;
    try {
      process.kill(pid, 0);
      leaderAlive = true;
    } catch {
      // ESRCH (already reaped) / EPERM — do not risk signalling a reused group.
    }
    if (leaderAlive) {
      try {
        // Negative pid → deliver to the whole process group (descendants too).
        process.kill(-pid, signal);
        groupKilled = true;
      } catch {
        // No such group / EPERM / unsupported — fall back to the proc itself.
      }
    }
  }
  // Always signal the leader directly: as a fallback when the group signal
  // failed, and otherwise in case the leader ignored the group-delivered signal.
  try {
    proc.kill(signal);
  } catch {
    // Already dead.
  }
  log.debug("Killed process group", { name, pid, signal, groupKilled });
}

export function spawnChild(
  state: ChildState,
  running: () => boolean,
  onScheduleRestart: (state: ChildState) => void,
): void {
  const { spec } = state;
  const cwd = process.cwd();

  // Idempotency guard: never silently overwrite a live `state.proc`. A duplicate
  // spawn trigger (overlapping pingChildren + proc.exited + reconcile) must NOT
  // leak the previous process. Kill the existing tree first, then re-spawn. This
  // enforces the hard invariant: at most ONE live process per child spec.
  if (state.proc) {
    log.warn("spawnChild called while a process is already live; killing the existing tree first", {
      name: spec.name,
      pid: state.pid,
    });
    killProcessGroup(state.proc, spec.name, "SIGKILL");
    state.proc = null;
    state.pid = null;
  }

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
    // Own process group (setsid) so killChild can reap the whole subtree —
    // including agent-SDK CLI grandchildren — via a negative-pid group signal.
    detached: true,
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

  // Dedup: if a respawn is already armed for this state, do nothing. Multiple
  // concurrent triggers (overlapping pingChildren, the proc.exited handler, a
  // reconcile tick) for the SAME death must not each arm a setTimeout respawn —
  // every extra armed timer would later fire onSpawn and spawn an additional
  // live process for the same spec (the duplicate-process leak). We key the
  // guard on a live backoff timer, not on `status === "backoff"`: a process
  // genuinely cycling through crashes clears its timer when it fires (see the
  // setTimeout callback below) and re-enters with backoffTimer === null, so
  // legitimate crash-loop accounting still accrues; only a second trigger that
  // arrives while a timer is still pending is suppressed.
  if (state.backoffTimer != null) {
    log.debug("Restart already pending; ignoring duplicate trigger", {
      name: spec.name,
      status: state.status,
    });
    return;
  }

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
    // Graceful: SIGTERM the whole group so descendants get a chance to drain.
    killProcessGroup(proc, state.spec.name, "SIGTERM");

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
      // Force-kill the entire group so no agent-SDK grandchild is orphaned.
      killProcessGroup(proc, state.spec.name, "SIGKILL");
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
  // the wait window is not mis-evaluated against a different process. Each child
  // carries its own per-spec liveness budget (heartbeat.{pingTimeoutMs,
  // hungStrikesMax}); children that opt out (heartbeat.enabled === false) are
  // never pinged or hung-killed — their stuck calls are bounded elsewhere.
  const pinged: Array<{
    name: string;
    state: ChildState;
    proc: Subprocess;
    pongBefore: number;
    pingTimeoutMs: number;
    hungStrikesMax: number;
  }> = [];

  for (const [name, state] of children) {
    if (state.status !== "running" || !state.proc) continue;

    const heartbeat = state.spec.heartbeat;
    // Opt-out: never ping or hung-kill processes that disable IPC liveness.
    if (heartbeat?.enabled === false) continue;

    const pingTimeoutMs = heartbeat?.pingTimeoutMs ?? PING_TIMEOUT_MS;
    const hungStrikesMax = heartbeat?.hungStrikesMax ?? HUNG_STRIKES_MAX;

    const proc = state.proc;
    try {
      proc.send("ping");
    } catch {
      // IPC channel closed — process is dying, reconcile will handle it
      continue;
    }

    pinged.push({
      name,
      state,
      proc,
      pongBefore: state.lastPong,
      pingTimeoutMs,
      hungStrikesMax,
    });
  }

  if (pinged.length === 0) return;

  // Phase 2: wait a SINGLE window for all pongs (O(1) wall-clock instead of
  // O(children) × timeout serial waits). All pings were fired simultaneously, so
  // waiting the MAX per-spec budget guarantees every child has had at least its
  // own pingTimeoutMs to respond before we evaluate it against its own threshold.
  const maxWaitMs = pinged.reduce((max, p) => Math.max(max, p.pingTimeoutMs), 0);
  await new Promise((r) => setTimeout(r, maxWaitMs));

  for (const { name, state, proc, pongBefore, hungStrikesMax } of pinged) {
    // Skip if this child was replaced or torn down during the wait.
    if (state.proc !== proc || state.status !== "running") continue;
    if (state.lastPong !== pongBefore) continue;

    state.hungStrikes += 1;
    log.warn("Process missed ping/pong", {
      name,
      pid: state.pid,
      strikes: state.hungStrikes,
      maxStrikes: hungStrikesMax,
    });

    if (state.hungStrikes < hungStrikesMax) continue;

    log.error("Killing hung process (no pong response)", {
      name,
      pid: state.pid,
      lastPongAgo: Date.now() - state.lastPong,
    });

    // Tree-kill so agent-SDK grandchildren of a hung child are not orphaned.
    killProcessGroup(proc, name, "SIGKILL");
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
