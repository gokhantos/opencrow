/**
 * Child-side parent-death watchdog.
 *
 * The orchestrator spawns every child `detached` (POSIX `setsid()`), so each
 * child leads its own process group and does NOT receive SIGHUP/SIGKILL when the
 * core dies. Worse, when the core is SIGKILLed (a crash, or
 * `launchctl kickstart -k`) NO graceful teardown runs at all — the orchestrator's
 * `killChild` path never executes. The result is orphaned children reparented to
 * init/launchd (ppid 1) that outlive the core indefinitely. For the web child
 * this is actively harmful: stale listeners keep binding the port and split
 * incoming traffic with the live child.
 *
 * The standard fix is a child-side watchdog: poll our own parent pid and
 * self-terminate the moment it changes from the core that spawned us. This is
 * the ONLY mechanism that survives a SIGKILL of the core (nothing else can — the
 * core is gone before any of its own cleanup could run).
 *
 * This module is intentionally free of any process-global side effects at import
 * time so it stays unit-testable: the decision (`isOrphaned`) is pure and the
 * watchdog factory takes injectable ppid/timer/exit dependencies. The convenience
 * `armParentWatchdog()` wires real dependencies and is called from exactly one
 * shared place — the child bootstrap (`src/process/bootstrap.ts`) — so every
 * spawned child (web, cron, agent, scraper, sige, ingestion) inherits it without
 * per-entry copy-paste.
 */
import { createLogger } from "../logger";

const log = createLogger("parent-watchdog");

/**
 * How often a child checks whether its parent (the core) is still alive. A few
 * seconds is plenty: this bounds orphan lifetime, and the ppid read is a cheap
 * in-process property access (no syscall). NOT a restart/backoff constant — it
 * only governs orphan-detection latency.
 */
export const PARENT_WATCHDOG_INTERVAL_MS = 3_000;

/**
 * Pure orphan decision. `currentPpid` is this process's live parent pid;
 * `initialParentPid` is the pid of the core captured at arm time.
 *
 * A change means the original parent is gone: on POSIX an orphan is reparented
 * to init/launchd (pid 1), but we compare against the captured pid rather than
 * only checking `=== 1` so we also catch subreaper setups where the new parent
 * is some pid other than 1. `currentPpid <= 1` is treated as orphaned even in
 * the degenerate case where the captured pid was somehow invalid.
 */
export function isOrphaned(currentPpid: number, initialParentPid: number): boolean {
  return currentPpid !== initialParentPid || currentPpid <= 1;
}

export interface ParentWatchdogConfig {
  /** The core's pid, captured when the watchdog is armed. Must be > 1. */
  readonly initialParentPid: number;
  /** Poll cadence. Defaults to PARENT_WATCHDOG_INTERVAL_MS. */
  readonly intervalMs?: number;
}

export interface ParentWatchdogDeps {
  /** Live parent-pid source. Defaults to `() => process.ppid`. */
  readonly getPpid?: () => number;
  /** Called exactly once when orphaning is detected. Defaults to a clean exit. */
  readonly onOrphaned?: (currentPpid: number) => void;
  /** Injectable for tests. Defaults to global setInterval. */
  readonly setIntervalFn?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  /** Injectable for tests. Defaults to global clearInterval. */
  readonly clearIntervalFn?: (handle: ReturnType<typeof setInterval>) => void;
}

export interface ParentWatchdog {
  start(): void;
  stop(): void;
  /**
   * Run a single check. Returns true if orphaning was detected (and
   * `onOrphaned` was fired). Exposed so tests can drive checks deterministically
   * without real timers. Fires `onOrphaned` at most once across the lifetime.
   */
  check(): boolean;
}

/**
 * Create a parent-death watchdog. Does nothing until `start()`. `onOrphaned`
 * fires at most once. The internal timer is `unref()`d so it never keeps an
 * otherwise-idle event loop alive.
 */
export function createParentWatchdog(
  config: ParentWatchdogConfig,
  deps: ParentWatchdogDeps = {},
): ParentWatchdog {
  const intervalMs = config.intervalMs ?? PARENT_WATCHDOG_INTERVAL_MS;
  const getPpid = deps.getPpid ?? (() => process.ppid);
  const onOrphaned =
    deps.onOrphaned ??
    ((currentPpid: number) => {
      // Parent is gone — there is nothing left to coordinate with, so exit
      // cleanly. The OS reclaims the process's sockets/DB connections; the new
      // core will re-spawn a fresh child for this slot. A clean exit(0) keeps
      // the supervisor's restart accounting from treating this as a failure.
      log.warn("Parent (core) died — self-terminating orphaned child", {
        pid: process.pid,
        currentPpid,
        initialParentPid: config.initialParentPid,
      });
      process.exit(0);
    });
  const setIntervalFn: (fn: () => void, ms: number) => ReturnType<typeof setInterval> =
    deps.setIntervalFn ??
    ((fn, ms) => setInterval(fn, ms) as ReturnType<typeof setInterval>);
  const clearIntervalFn = deps.clearIntervalFn ?? clearInterval;

  let handle: ReturnType<typeof setInterval> | null = null;
  let fired = false;

  function check(): boolean {
    if (fired) return true;
    const currentPpid = getPpid();
    if (!isOrphaned(currentPpid, config.initialParentPid)) return false;
    fired = true;
    onOrphaned(currentPpid);
    return true;
  }

  return {
    start(): void {
      if (handle) return;
      handle = setIntervalFn(check, intervalMs);
      // Never let the watchdog timer alone keep the process alive.
      (handle as { unref?: () => void }).unref?.();
    },
    stop(): void {
      if (!handle) return;
      clearIntervalFn(handle);
      handle = null;
    },
    check,
  };
}

// Module-level singleton guard: armParentWatchdog() is idempotent so calling it
// from multiple shared entry points (or twice during a reload) never installs a
// second timer.
let armed: ParentWatchdog | null = null;

/**
 * Arm the parent-death watchdog for the current process, if and only if this
 * process is an orchestrator-spawned child. Idempotent — safe to call more than
 * once.
 *
 * Gating (both must hold, else this is a no-op):
 *  - `process.send` is a function → the orchestrator spawned us with an IPC
 *    channel. This excludes the core itself (launched by launchd, no IPC) and
 *    monolith/dev or test processes that have no orchestrator parent.
 *  - the captured parent pid is > 1 → we have a real parent to watch.
 */
export function armParentWatchdog(deps: ParentWatchdogDeps = {}): ParentWatchdog | null {
  if (armed) return armed;

  if (typeof process.send !== "function") {
    // Not an orchestrator child (core, monolith, tests) — nothing to watch.
    return null;
  }

  const initialParentPid = process.ppid;
  if (initialParentPid <= 1) {
    // Already orphaned at arm time, or no meaningful parent — do not arm a
    // watchdog that would fire immediately on a bogus baseline.
    log.warn("Parent pid <= 1 at arm time; not arming watchdog", {
      pid: process.pid,
      initialParentPid,
    });
    return null;
  }

  const watchdog = createParentWatchdog({ initialParentPid }, deps);
  watchdog.start();
  armed = watchdog;
  log.info("Parent-death watchdog armed", {
    pid: process.pid,
    initialParentPid,
    intervalMs: PARENT_WATCHDOG_INTERVAL_MS,
  });
  return watchdog;
}
