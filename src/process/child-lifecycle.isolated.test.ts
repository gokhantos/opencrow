/**
 * Isolated tests for child-lifecycle behaviors that require mock.module.
 *
 * Lane: isolated (own Bun process) because mock.module is used to replace the
 * registry module. Without isolation, the mock would leak into the unit lane's
 * child-lifecycle.test.ts and corrupt its child-process behaviours.
 *
 * Tests:
 *  (a) pingChildren identity guard — a child whose state.proc was replaced
 *      during the PING_TIMEOUT_MS wait is NOT killed / restarted.
 *  (b) crash-loop transition calls markProcessCrashLoop with the process name.
 *
 * The fake-timer harness (fake setTimeout) is the same pattern used in
 * child-lifecycle.test.ts so the PING_TIMEOUT_MS await is drained
 * synchronously.
 */
import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

// ── Stub the registry module BEFORE importing child-lifecycle ─────────────

const mockMarkProcessCrashLoop = mock(async (_name: string) => {});
const mockClearProcessCrashLoop = mock(async (_name: string) => {});

mock.module("./registry", () => ({
  markProcessCrashLoop: mockMarkProcessCrashLoop,
  clearProcessCrashLoop: mockClearProcessCrashLoop,
  CRASH_LOOP_KEY: "crashLoopAt",
}));

// Import under test after mocks are installed.
const {
  createInitialChildState,
  pingChildren,
  scheduleRestart,
  HUNG_STRIKES_MAX,
} = await import("./child-lifecycle");
import type { ChildState } from "./child-lifecycle";
import type { ResolvedProcessSpec } from "./manifest";

// ── Fake timer harness ────────────────────────────────────────────────────

interface CapturedTimer {
  readonly fn: () => void;
  readonly delay: number;
}

let capturedTimers: CapturedTimer[];
let realSetTimeout: typeof globalThis.setTimeout;

beforeEach(() => {
  capturedTimers = [];
  realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void, delay: number) => {
    capturedTimers.push({ fn, delay });
    return { ref() {}, unref() {} } as unknown as ReturnType<typeof setTimeout>;
  }) as typeof globalThis.setTimeout;

  mockMarkProcessCrashLoop.mockClear();
  mockClearProcessCrashLoop.mockClear();
});

afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
});

// ── Fixtures ──────────────────────────────────────────────────────────────

function makeSpec(overrides: Partial<ResolvedProcessSpec> = {}): ResolvedProcessSpec {
  return {
    name: "cron",
    entry: "src/entries/cron.ts",
    restartPolicy: "always",
    maxRestarts: 3,
    restartWindowSec: 60,
    ...overrides,
  };
}

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
    send(m: string) { sent.push(m); },
    kill(sig: string) { killed.push(sig); },
  };
}

function runningChild(spec: ResolvedProcessSpec, proc: FakeProc): ChildState {
  const state = createInitialChildState(spec);
  state.status = "running";
  state.proc = proc as unknown as ChildState["proc"];
  state.pid = 9999;
  return state;
}

function flushFakeTimers(): void {
  while (capturedTimers.length > 0) {
    const next = capturedTimers.shift()!;
    next.fn();
  }
}

// ── (a) pingChildren — identity guard ─────────────────────────────────────

describe("pingChildren — identity guard", () => {
  test("a child whose proc was replaced during the wait is NOT killed or restarted", async () => {
    const originalProc = makeFakeProc();
    const state = runningChild(makeSpec(), originalProc);
    // Load up strikes so the next miss would trigger a kill.
    state.hungStrikes = HUNG_STRIKES_MAX - 1;

    const children = new Map<string, ChildState>([["cron", state]]);
    const onScheduleRestart = mock(() => {});

    const pending = pingChildren(children, onScheduleRestart);

    // Simulate a new spawn replacing state.proc before the timeout drains —
    // this is the race the identity guard defends against.
    const replacementProc = makeFakeProc();
    state.proc = replacementProc as unknown as ChildState["proc"];

    flushFakeTimers();
    await pending;

    // The original proc must NOT have been killed.
    expect(originalProc.killed).toEqual([]);
    // The replacement proc must NOT have been killed either.
    expect(replacementProc.killed).toEqual([]);
    // No restart should have been scheduled.
    expect(onScheduleRestart).not.toHaveBeenCalled();
  });

  test("a child whose status changed to non-running during the wait is skipped", async () => {
    const proc = makeFakeProc();
    const state = runningChild(makeSpec(), proc);
    state.hungStrikes = HUNG_STRIKES_MAX - 1;

    const children = new Map<string, ChildState>([["cron", state]]);
    const onScheduleRestart = mock(() => {});

    const pending = pingChildren(children, onScheduleRestart);

    // Transition to backoff while waiting.
    state.status = "backoff";

    flushFakeTimers();
    await pending;

    expect(proc.killed).toEqual([]);
    expect(onScheduleRestart).not.toHaveBeenCalled();
  });
});

// ── (b) crash-loop transition → markProcessCrashLoop ─────────────────────

describe("scheduleRestart — crash-loop calls markProcessCrashLoop", () => {
  test("marks the process name in the registry when crash-loop is detected", () => {
    const spec = makeSpec({ name: "cron", maxRestarts: 1, restartWindowSec: 60 });
    const state = createInitialChildState(spec);
    const onSpawn = mock(() => {});

    scheduleRestart(state, () => true, onSpawn); // 1st — ok, backoff
    scheduleRestart(state, () => true, onSpawn); // 2nd — exceeds maxRestarts

    expect(state.status).toBe("crash-loop");

    // markProcessCrashLoop must have been called; it's fire-and-forget so we
    // assert the mock received the call (the promise itself is not awaited by
    // the caller — it's discarded — but the mock captures the invocation).
    expect(mockMarkProcessCrashLoop).toHaveBeenCalledTimes(1);
    expect(mockMarkProcessCrashLoop).toHaveBeenCalledWith("cron");
  });

  test("does not call markProcessCrashLoop when crash-loop threshold is not yet reached", () => {
    const spec = makeSpec({ name: "cron", maxRestarts: 5, restartWindowSec: 60 });
    const state = createInitialChildState(spec);

    scheduleRestart(state, () => true, mock(() => {}));

    expect(state.status).toBe("backoff");
    expect(mockMarkProcessCrashLoop).not.toHaveBeenCalled();
  });
});
