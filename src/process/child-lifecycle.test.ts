import { test, expect, describe, mock, beforeEach, afterEach } from "bun:test";
import {
  createInitialChildState,
  scheduleRestart,
  resetBackoffIfStable,
  pingChildren,
  HUNG_STRIKES_MAX,
  type ChildState,
} from "./child-lifecycle";
import type { ResolvedProcessSpec } from "./manifest";

// ── Test fixtures ──────────────────────────────────────────────────────────

function makeSpec(overrides: Partial<ResolvedProcessSpec> = {}): ResolvedProcessSpec {
  return {
    name: "test-proc",
    entry: "src/entries/test.ts",
    restartPolicy: "always",
    maxRestarts: 3,
    restartWindowSec: 60,
    ...overrides,
  };
}

// Backoff constants mirrored from child-lifecycle.ts for assertion clarity.
const BACKOFF_INITIAL_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

// ── Fake timer harness ─────────────────────────────────────────────────────
// scheduleRestart uses the global setTimeout. We replace it with a capturing
// fake so the restart callback never fires during the synchronous test and we
// can inspect/trigger it deterministically. No real subprocess, no real timer.

interface CapturedTimer {
  readonly fn: () => void;
  readonly delay: number;
}

let capturedTimers: CapturedTimer[];
let realSetTimeout: typeof globalThis.setTimeout;

beforeEach(() => {
  capturedTimers = [];
  realSetTimeout = globalThis.setTimeout;
  // Replace the global timer with a capturing test double (no real timers).
  globalThis.setTimeout = ((fn: () => void, delay: number) => {
    capturedTimers.push({ fn, delay });
    return { ref() {}, unref() {} } as unknown as ReturnType<typeof setTimeout>;
  }) as typeof globalThis.setTimeout;
});

afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
});

// ── scheduleRestart: exponential backoff ───────────────────────────────────

describe("scheduleRestart — exponential backoff", () => {
  test("first restart schedules at the initial backoff and doubles the next", () => {
    const state = createInitialChildState(makeSpec());
    const onSpawn = mock(() => {});

    scheduleRestart(state, () => true, onSpawn);

    // The scheduled delay is the previous backoffMs (initial), and backoffMs
    // is doubled for the *next* restart.
    expect(capturedTimers).toHaveLength(1);
    expect(capturedTimers[0]!.delay).toBe(BACKOFF_INITIAL_MS);
    expect(state.backoffMs).toBe(BACKOFF_INITIAL_MS * 2);
    expect(state.status).toBe("backoff");
    expect(state.restartCount).toBe(1);
    // The timer has not fired yet — onSpawn must not have been called.
    expect(onSpawn).not.toHaveBeenCalled();
  });

  test("backoff doubles on each successive restart", () => {
    const state = createInitialChildState(makeSpec({ maxRestarts: 100 }));
    const onSpawn = mock(() => {});

    scheduleRestart(state, () => true, onSpawn);
    expect(capturedTimers[0]!.delay).toBe(1_000);

    scheduleRestart(state, () => true, onSpawn);
    expect(capturedTimers[1]!.delay).toBe(2_000);

    scheduleRestart(state, () => true, onSpawn);
    expect(capturedTimers[2]!.delay).toBe(4_000);

    scheduleRestart(state, () => true, onSpawn);
    expect(capturedTimers[3]!.delay).toBe(8_000);
  });

  test("backoff is capped at BACKOFF_MAX_MS", () => {
    const state = createInitialChildState(makeSpec({ maxRestarts: 100 }));
    state.backoffMs = BACKOFF_MAX_MS; // already at the ceiling

    scheduleRestart(state, () => true, mock(() => {}));

    expect(capturedTimers[0]!.delay).toBe(BACKOFF_MAX_MS);
    // Doubling is clamped: stays at the max, never overflows past it.
    expect(state.backoffMs).toBe(BACKOFF_MAX_MS);
  });

  test("backoff near the ceiling clamps to BACKOFF_MAX_MS rather than overshooting", () => {
    const state = createInitialChildState(makeSpec({ maxRestarts: 100 }));
    state.backoffMs = 40_000; // 40_000 * 2 = 80_000 > 60_000 cap

    scheduleRestart(state, () => true, mock(() => {}));

    expect(capturedTimers[0]!.delay).toBe(40_000);
    expect(state.backoffMs).toBe(BACKOFF_MAX_MS);
  });

  test("fired timer invokes onSpawn only when still running and not user-stopped", () => {
    const state = createInitialChildState(makeSpec());
    const onSpawn = mock(() => {});

    scheduleRestart(state, () => true, onSpawn);
    capturedTimers[0]!.fn();

    expect(onSpawn).toHaveBeenCalledTimes(1);
    expect(state.backoffTimer).toBeNull();
    expect(state.nextRetryAt).toBeNull();
  });

  test("fired timer does not spawn when no longer running", () => {
    const state = createInitialChildState(makeSpec());
    const onSpawn = mock(() => {});

    scheduleRestart(state, () => false, onSpawn);
    capturedTimers[0]!.fn();

    expect(onSpawn).not.toHaveBeenCalled();
  });

  test("fired timer does not spawn when stopped by user", () => {
    const state = createInitialChildState(makeSpec());
    state.stoppedByUser = true;
    const onSpawn = mock(() => {});

    scheduleRestart(state, () => true, onSpawn);
    capturedTimers[0]!.fn();

    expect(onSpawn).not.toHaveBeenCalled();
  });
});

// ── scheduleRestart: crash-loop detection ──────────────────────────────────

describe("scheduleRestart — crash-loop detection", () => {
  test("gives up after exceeding maxRestarts within the window", () => {
    const state = createInitialChildState(makeSpec({ maxRestarts: 3, restartWindowSec: 60 }));
    const onSpawn = mock(() => {});

    // maxRestarts = 3 → the 4th restart within the window trips the crash-loop.
    scheduleRestart(state, () => true, onSpawn);
    expect(state.status).toBe("backoff");
    scheduleRestart(state, () => true, onSpawn);
    expect(state.status).toBe("backoff");
    scheduleRestart(state, () => true, onSpawn);
    expect(state.status).toBe("backoff");

    scheduleRestart(state, () => true, onSpawn);
    expect(state.status).toBe("crash-loop");
    expect(state.restartsInWindow.length).toBeGreaterThan(state.spec.maxRestarts);
  });

  test("crash-loop short-circuits and schedules no further restart timer", () => {
    const state = createInitialChildState(makeSpec({ maxRestarts: 1, restartWindowSec: 60 }));
    const onSpawn = mock(() => {});

    scheduleRestart(state, () => true, onSpawn); // 1 — ok
    capturedTimers = [];
    scheduleRestart(state, () => true, onSpawn); // 2 — exceeds maxRestarts(1)

    expect(state.status).toBe("crash-loop");
    // No new timer is scheduled once the crash loop is detected.
    expect(capturedTimers).toHaveLength(0);
  });

  test("restarts outside the window are pruned and do not count toward crash-loop", () => {
    const state = createInitialChildState(makeSpec({ maxRestarts: 2, restartWindowSec: 60 }));
    // Seed two stale restart timestamps that are well outside the 60s window.
    const longAgo = Date.now() - 120_000;
    state.restartsInWindow = [longAgo, longAgo];

    scheduleRestart(state, () => true, mock(() => {}));

    // Stale entries pruned → only the fresh one remains; not a crash loop.
    expect(state.restartsInWindow).toHaveLength(1);
    expect(state.status).toBe("backoff");
  });
});

// ── resetBackoffIfStable ───────────────────────────────────────────────────

describe("resetBackoffIfStable", () => {
  test("resets backoff and clears window after sufficient stable uptime", () => {
    const state = createInitialChildState(makeSpec());
    state.status = "running";
    state.backoffMs = 16_000;
    state.restartsInWindow = [Date.now(), Date.now()];
    // Started more than the 5-minute stable threshold ago.
    state.startedAt = Date.now() - 400_000;

    resetBackoffIfStable(state);

    expect(state.backoffMs).toBe(BACKOFF_INITIAL_MS);
    expect(state.restartsInWindow).toEqual([]);
  });

  test("does not reset when uptime is below the stable threshold", () => {
    const state = createInitialChildState(makeSpec());
    state.status = "running";
    state.backoffMs = 16_000;
    state.startedAt = Date.now() - 1_000; // only 1s of uptime

    resetBackoffIfStable(state);

    expect(state.backoffMs).toBe(16_000);
  });

  test("does not reset when the process is not running", () => {
    const state = createInitialChildState(makeSpec());
    state.status = "backoff";
    state.backoffMs = 16_000;
    state.startedAt = Date.now() - 400_000;

    resetBackoffIfStable(state);

    expect(state.backoffMs).toBe(16_000);
  });

  test("is a no-op when backoff is already at the initial value", () => {
    const state = createInitialChildState(makeSpec());
    state.status = "running";
    state.backoffMs = BACKOFF_INITIAL_MS;
    state.restartsInWindow = [Date.now()];
    state.startedAt = Date.now() - 400_000;

    resetBackoffIfStable(state);

    // No change needed → window is left intact (the reset branch is skipped).
    expect(state.backoffMs).toBe(BACKOFF_INITIAL_MS);
    expect(state.restartsInWindow).toHaveLength(1);
  });

  test("does not reset when startedAt is null", () => {
    const state = createInitialChildState(makeSpec());
    state.status = "running";
    state.backoffMs = 8_000;
    state.startedAt = null;

    resetBackoffIfStable(state);

    expect(state.backoffMs).toBe(8_000);
  });
});

// ── pingChildren: hung-strike → SIGKILL ────────────────────────────────────
// We use a fake Subprocess that records send()/kill() calls. The PING_TIMEOUT
// await uses the captured fake setTimeout, which we drain synchronously.

interface FakeProc {
  readonly sent: string[];
  readonly killed: string[];
  readonly send: (m: string) => void;
  readonly kill: (sig: string) => void;
}

function makeFakeProc(): FakeProc {
  const sent: string[] = [];
  const killed: string[] = [];
  return {
    sent,
    killed,
    send(m: string) {
      sent.push(m);
    },
    kill(sig: string) {
      killed.push(sig);
    },
  };
}

function runningChild(spec: ResolvedProcessSpec, proc: FakeProc): ChildState {
  const state = createInitialChildState(spec);
  state.status = "running";
  state.proc = proc as unknown as ChildState["proc"];
  state.pid = 4242;
  return state;
}

// Drains the fake-timer queue: pingChildren awaits a PING_TIMEOUT_MS setTimeout
// to detect a missing pong. Our fake setTimeout captures it without firing, so
// we flush the captured callbacks to let the awaited promise resolve.
function flushFakeTimers(): void {
  while (capturedTimers.length > 0) {
    const next = capturedTimers.shift()!;
    next.fn();
  }
}

describe("pingChildren — hung detection", () => {
  test("sends a ping to running children", async () => {
    const proc = makeFakeProc();
    const state = runningChild(makeSpec(), proc);
    const children = new Map<string, ChildState>([["test-proc", state]]);

    const pending = pingChildren(children, mock(() => {}));
    flushFakeTimers();
    await pending;

    expect(proc.sent).toContain("ping");
  });

  test("first missed pong records a strike without killing", async () => {
    const proc = makeFakeProc();
    const state = runningChild(makeSpec(), proc);
    const children = new Map<string, ChildState>([["test-proc", state]]);

    const pending = pingChildren(children, mock(() => {}));
    flushFakeTimers();
    await pending;

    expect(state.hungStrikes).toBe(1);
    expect(proc.killed).toEqual([]);
  });

  test("reaching HUNG_STRIKES_MAX SIGKILLs the process and schedules a restart", async () => {
    const proc = makeFakeProc();
    const state = runningChild(makeSpec({ restartPolicy: "always" }), proc);
    // Pre-load strikes so this ping pushes it over the threshold.
    state.hungStrikes = HUNG_STRIKES_MAX - 1;
    const children = new Map<string, ChildState>([["test-proc", state]]);
    const onScheduleRestart = mock(() => {});

    const pending = pingChildren(children, onScheduleRestart);
    flushFakeTimers();
    await pending;

    expect(proc.killed).toContain("SIGKILL");
    expect(state.proc).toBeNull();
    expect(state.pid).toBeNull();
    expect(state.hungStrikes).toBe(0);
    expect(onScheduleRestart).toHaveBeenCalledTimes(1);
  });

  test("hung process with restartPolicy never is marked stopped, not restarted", async () => {
    const proc = makeFakeProc();
    const state = runningChild(makeSpec({ restartPolicy: "never" }), proc);
    state.hungStrikes = HUNG_STRIKES_MAX - 1;
    const children = new Map<string, ChildState>([["test-proc", state]]);
    const onScheduleRestart = mock(() => {});

    const pending = pingChildren(children, onScheduleRestart);
    flushFakeTimers();
    await pending;

    expect(proc.killed).toContain("SIGKILL");
    expect(state.status).toBe("stopped");
    expect(onScheduleRestart).not.toHaveBeenCalled();
  });

  test("a pong arriving during the wait clears the strike (no kill)", async () => {
    const proc = makeFakeProc();
    const state = runningChild(makeSpec(), proc);
    const children = new Map<string, ChildState>([["test-proc", state]]);

    const pending = pingChildren(children, mock(() => {}));
    // Simulate the child responding with a pong before the timeout drains.
    state.lastPong = Date.now() + 5;
    flushFakeTimers();
    await pending;

    expect(state.hungStrikes).toBe(0);
    expect(proc.killed).toEqual([]);
  });

  test("skips children that are not running", async () => {
    const proc = makeFakeProc();
    const state = runningChild(makeSpec(), proc);
    state.status = "backoff";
    const children = new Map<string, ChildState>([["test-proc", state]]);

    await pingChildren(children, mock(() => {}));

    expect(proc.sent).toEqual([]);
  });
});
