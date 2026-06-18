import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Mocks the global setTimeout (and process.kill) at the module level → isolated
// lane. Pins the per-spec heartbeat tunables introduced to stop false hung-kills
// of the heavy LLM `sige` process:
//   1. heartbeat.enabled === false  → NEVER pinged or hung-killed, however many
//      missed pongs.
//   2. per-spec pingTimeoutMs / hungStrikesMax are honoured.
//   3. a spec with no heartbeat override keeps the global default behaviour.
//
// Reconciled with master's O(1) parallel pingChildren (commit 53883cb): pings
// fire simultaneously and the cycle waits a SINGLE window = max(per-spec
// pingTimeoutMs), then evaluates each child against its own hungStrikesMax.

// Stub the registry so fire-and-forget crash-loop markers don't hit a DB.
mock.module("./registry", () => ({
  markProcessCrashLoop: mock(async (_name: string) => {}),
  clearProcessCrashLoop: mock(async (_name: string) => {}),
  CRASH_LOOP_KEY: "crashLoopAt",
}));

const { createInitialChildState, pingChildren, HUNG_STRIKES_MAX, PING_TIMEOUT_MS } = await import(
  "./child-lifecycle"
);
import type { ChildState } from "./child-lifecycle";
import type { ResolvedProcessSpec } from "./manifest";

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

function makeSpec(overrides: Partial<ResolvedProcessSpec> = {}): ResolvedProcessSpec {
  return {
    name: "sige",
    entry: "src/entries/sige.ts",
    restartPolicy: "always",
    maxRestarts: 10,
    restartWindowSec: 300,
    ...overrides,
  };
}

function runningChild(spec: ResolvedProcessSpec, proc: FakeProc): ChildState {
  const state = createInitialChildState(spec);
  state.status = "running";
  state.proc = proc as unknown as ChildState["proc"];
  state.pid = 4242;
  return state;
}

// ── Fake timers + process.kill ──────────────────────────────────────────────
// pingChildren awaits a setTimeout(maxWait). We capture each timer with its delay
// so we can both flush them and assert which budget was used.

interface CapturedTimer {
  readonly fn: () => void;
  readonly delay: number;
}

let capturedTimers: CapturedTimer[];
let realSetTimeout: typeof globalThis.setTimeout;
let realProcessKill: typeof process.kill;

beforeEach(() => {
  capturedTimers = [];
  realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void, delay = 0) => {
    capturedTimers.push({ fn, delay });
    return { ref() {}, unref() {} } as unknown as ReturnType<typeof setTimeout>;
  }) as typeof globalThis.setTimeout;

  realProcessKill = process.kill;
  process.kill = (() => true) as typeof process.kill;
});

afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
  process.kill = realProcessKill;
});

function flushPingTimers(): void {
  const fired = capturedTimers;
  capturedTimers = [];
  for (const t of fired) t.fn();
}

describe("pingChildren — per-spec heartbeat (heartbeat.enabled === false)", () => {
  test("a child with heartbeat disabled is NEVER pinged or hung-killed, even after many cycles", async () => {
    const proc = makeFakeProc();
    const state = runningChild(makeSpec({ heartbeat: { enabled: false } }), proc);
    const children = new Map<string, ChildState>([["sige", state]]);
    const onScheduleRestart = mock(() => {});

    // Many consecutive cycles with no pong ever arriving.
    for (let i = 0; i < 50; i++) {
      const pending = pingChildren(children, onScheduleRestart);
      flushPingTimers();
      await pending;
    }

    expect(proc.sent).toEqual([]); // never even pinged
    expect(proc.killed).toEqual([]); // never killed
    expect(state.hungStrikes).toBe(0); // no strikes accrued
    expect(state.proc).not.toBeNull();
    expect(onScheduleRestart).not.toHaveBeenCalled();
  });
});

describe("pingChildren — per-spec heartbeat tunables", () => {
  test("honours a per-spec pingTimeoutMs for the await window", async () => {
    const proc = makeFakeProc();
    const state = runningChild(makeSpec({ heartbeat: { pingTimeoutMs: 10_000 } }), proc);
    const children = new Map<string, ChildState>([["sige", state]]);

    const pending = pingChildren(
      children,
      mock(() => {}),
    );
    // The single wait window must use the per-spec budget, not the global default.
    expect(capturedTimers.some((t) => t.delay === 10_000)).toBe(true);
    expect(capturedTimers.some((t) => t.delay === PING_TIMEOUT_MS)).toBe(false);
    flushPingTimers();
    await pending;

    expect(proc.sent).toContain("ping");
  });

  test("honours a per-spec hungStrikesMax before killing", async () => {
    const proc = makeFakeProc();
    const state = runningChild(makeSpec({ heartbeat: { hungStrikesMax: 5 } }), proc);
    const children = new Map<string, ChildState>([["sige", state]]);
    const onScheduleRestart = mock(() => {});

    // Four missed cycles: under the per-spec threshold of 5 → no kill yet.
    for (let i = 0; i < 4; i++) {
      const pending = pingChildren(children, onScheduleRestart);
      flushPingTimers();
      await pending;
    }
    expect(state.hungStrikes).toBe(4);
    expect(proc.killed).toEqual([]);
    expect(onScheduleRestart).not.toHaveBeenCalled();

    // Fifth missed cycle reaches the threshold → kill + restart.
    const pending = pingChildren(children, onScheduleRestart);
    flushPingTimers();
    await pending;
    expect(proc.killed).toContain("SIGKILL");
    expect(onScheduleRestart).toHaveBeenCalledTimes(1);
  });
});

describe("pingChildren — default behaviour unchanged for specs without override", () => {
  test("a spec with no heartbeat field uses the global defaults", async () => {
    const proc = makeFakeProc();
    const state = runningChild(makeSpec(), proc);
    const children = new Map<string, ChildState>([["test-proc", state]]);
    const onScheduleRestart = mock(() => {});

    // The wait window uses the global PING_TIMEOUT_MS default.
    const first = pingChildren(children, onScheduleRestart);
    expect(capturedTimers.some((t) => t.delay === PING_TIMEOUT_MS)).toBe(true);
    flushPingTimers();
    await first;
    expect(state.hungStrikes).toBe(1);
    expect(proc.killed).toEqual([]);

    // Drive the rest of the way to the global HUNG_STRIKES_MAX.
    for (let i = state.hungStrikes; i < HUNG_STRIKES_MAX; i++) {
      const pending = pingChildren(children, onScheduleRestart);
      flushPingTimers();
      await pending;
    }
    expect(proc.killed).toContain("SIGKILL");
    expect(onScheduleRestart).toHaveBeenCalledTimes(1);
  });

  test("with mixed specs, the wait is the MAX per-spec budget and each is judged by its own threshold", async () => {
    // A default child (6s budget, strikes-max 2) and a generous child (12s
    // budget). Pings fire together; the single wait = max(6000, 12000) = 12000.
    const defaultProc = makeFakeProc();
    const defaultState = runningChild(makeSpec({ name: "web" }), defaultProc);
    const generousProc = makeFakeProc();
    const generousState = runningChild(
      makeSpec({ name: "heavy", heartbeat: { pingTimeoutMs: 12_000 } }),
      generousProc,
    );
    const children = new Map<string, ChildState>([
      ["web", defaultState],
      ["heavy", generousState],
    ]);

    const pending = pingChildren(
      children,
      mock(() => {}),
    );
    expect(capturedTimers.some((t) => t.delay === 12_000)).toBe(true);
    flushPingTimers();
    await pending;

    // Both got pinged; both accrued exactly one strike (neither ponged).
    expect(defaultProc.sent).toContain("ping");
    expect(generousProc.sent).toContain("ping");
    expect(defaultState.hungStrikes).toBe(1);
    expect(generousState.hungStrikes).toBe(1);
  });
});
