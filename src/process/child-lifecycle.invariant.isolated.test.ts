import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// This file mocks Bun.spawn and process.kill at the module level → isolated lane.
// It pins the hard invariant "at most ONE live process per child spec" and the
// process-group (tree) kill behaviour that prevents orphaned agent-SDK kids.
//
// Reconciled with master's hardened child-lifecycle (commit 53883cb): the
// per-spawn identity guard and O(1) parallel ping live there already; this file
// ADDS the leak-fix invariants on top — idempotent spawnChild, detached spawns,
// scheduleRestart dedup, and group (negative-pid) kills.

// Stub the registry module so the fire-and-forget crash-loop markers don't hit
// a DB. Must be installed before importing child-lifecycle.
mock.module("./registry", () => ({
  markProcessCrashLoop: mock(async (_name: string) => {}),
  clearProcessCrashLoop: mock(async (_name: string) => {}),
  CRASH_LOOP_KEY: "crashLoopAt",
}));

const {
  createInitialChildState,
  spawnChild,
  scheduleRestart,
  killChild,
  pingChildren,
  HUNG_STRIKES_MAX,
} = await import("./child-lifecycle");
import type { ChildState } from "./child-lifecycle";
import type { ResolvedProcessSpec } from "./manifest";

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

// ── Fake Bun.spawn ──────────────────────────────────────────────────────────
// Each spawn returns a fresh fake Subprocess with a unique, increasing pid and
// records its own kill() calls. We never start a real process.

interface FakeProc {
  readonly pid: number;
  readonly killed: string[];
  readonly sent: string[];
  readonly exited: Promise<number>;
  resolveExit: (code: number) => void;
  kill: (sig?: string | number) => void;
  send: (msg: string) => void;
}

let nextPid: number;
let spawnedProcs: FakeProc[];
let realSpawn: typeof Bun.spawn;

function makeFakeProc(): FakeProc {
  const pid = nextPid++;
  const killed: string[] = [];
  const sent: string[] = [];
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((r) => {
    resolveExit = r;
  });
  return {
    pid,
    killed,
    sent,
    exited,
    resolveExit,
    kill(sig?: string | number) {
      killed.push(String(sig ?? "SIGTERM"));
    },
    send(msg: string) {
      sent.push(msg);
    },
  };
}

// ── Fake process.kill ───────────────────────────────────────────────────────
// Records every (pid, signal). Negative pid == process-group signal.

interface GroupKill {
  readonly pid: number;
  readonly signal: string | number | undefined;
}

let groupKills: GroupKill[];
let realProcessKill: typeof process.kill;

beforeEach(() => {
  nextPid = 1000;
  spawnedProcs = [];
  groupKills = [];

  realSpawn = Bun.spawn;
  Bun.spawn = mock(() => {
    const p = makeFakeProc();
    spawnedProcs.push(p);
    return p as unknown as ReturnType<typeof Bun.spawn>;
  });

  realProcessKill = process.kill;
  process.kill = ((pid: number, signal?: string | number) => {
    groupKills.push({ pid, signal });
    return true;
  }) as typeof process.kill;
});

afterEach(() => {
  Bun.spawn = realSpawn;
  process.kill = realProcessKill;
});

const liveProcs = () => spawnedProcs.filter((p) => p.killed.length === 0);
const groupKillFor = (pid: number) => groupKills.filter((k) => k.pid === -pid);

// ── Invariant: at most ONE live process per spec ────────────────────────────

describe("spawnChild — one live process per spec invariant", () => {
  test("two spawnChild calls for the same state leave only ONE live proc and kill the prior tree", () => {
    const state = createInitialChildState(makeSpec());
    const onScheduleRestart = mock(() => {});

    spawnChild(state, () => true, onScheduleRestart);
    const first = spawnedProcs[0]!;
    expect(state.proc).not.toBeNull();
    expect(state.pid).toBe(first.pid);

    // Duplicate trigger while the first is still live (the leak path).
    spawnChild(state, () => true, onScheduleRestart);
    const second = spawnedProcs[1]!;

    // Exactly two were spawned, and state tracks the newest.
    expect(spawnedProcs).toHaveLength(2);
    expect(state.pid).toBe(second.pid);

    // The prior process tree was group-killed (negative pid) with SIGKILL.
    expect(groupKillFor(first.pid).some((k) => k.signal === "SIGKILL")).toBe(true);

    // Only the second proc remains un-killed → one live process per spec.
    expect(liveProcs()).toHaveLength(1);
    expect(liveProcs()[0]!.pid).toBe(second.pid);
  });

  test("spawnChild detaches the child into its own process group", () => {
    const state = createInitialChildState(makeSpec());
    spawnChild(
      state,
      () => true,
      mock(() => {}),
    );

    const call = (Bun.spawn as unknown as ReturnType<typeof mock>).mock.calls[0]!;
    const opts = call[1] as { detached?: boolean };
    expect(opts.detached).toBe(true);
  });
});

// ── Invariant: scheduleRestart dedups concurrent triggers ───────────────────

describe("scheduleRestart — dedup of concurrent triggers", () => {
  let capturedTimers: Array<{ fn: () => void; delay: number }>;
  let realSetTimeout: typeof globalThis.setTimeout;

  beforeEach(() => {
    capturedTimers = [];
    realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, delay: number) => {
      capturedTimers.push({ fn, delay });
      return {
        ref() {},
        unref() {},
      } as unknown as ReturnType<typeof setTimeout>;
    }) as typeof globalThis.setTimeout;
  });

  afterEach(() => {
    globalThis.setTimeout = realSetTimeout;
  });

  test("a second trigger while a respawn timer is already armed is a no-op", () => {
    const state = createInitialChildState(makeSpec());
    const onSpawn = mock(() => {});

    scheduleRestart(state, () => true, onSpawn);
    scheduleRestart(state, () => true, onSpawn);

    // Only one backoff timer is armed despite two triggers — the second is the
    // duplicate-trigger path that would otherwise stack a second respawn.
    expect(capturedTimers).toHaveLength(1);
    expect(state.restartCount).toBe(1);

    // Firing it respawns exactly once.
    capturedTimers[0]!.fn();
    expect(onSpawn).toHaveBeenCalledTimes(1);
  });

  test("a fresh death after the timer fired schedules a new restart (accounting still accrues)", () => {
    const state = createInitialChildState(makeSpec());
    const onSpawn = mock(() => {});

    scheduleRestart(state, () => true, onSpawn);
    expect(state.restartCount).toBe(1);
    // Fire the armed timer → it nulls state.backoffTimer (the real respawn path).
    capturedTimers.at(-1)!.fn();
    expect(state.backoffTimer).toBeNull();

    // The respawned child later dies → a legitimately fresh trigger, NOT deduped.
    scheduleRestart(state, () => true, onSpawn);
    expect(state.restartCount).toBe(2);
    expect(capturedTimers).toHaveLength(2);
  });
});

// ── Invariant: overlapping ping cycles do not double-restart a hung child ───

describe("pingChildren — concurrent cycles do not double-restart", () => {
  let capturedTimers: Array<{ fn: () => void; delay: number }>;
  let realSetTimeout: typeof globalThis.setTimeout;

  beforeEach(() => {
    capturedTimers = [];
    realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, delay: number) => {
      capturedTimers.push({ fn, delay });
      return {
        ref() {},
        unref() {},
      } as unknown as ReturnType<typeof setTimeout>;
    }) as typeof globalThis.setTimeout;
  });

  afterEach(() => {
    globalThis.setTimeout = realSetTimeout;
  });

  function flushAllTimers(): void {
    while (capturedTimers.length > 0) {
      const next = capturedTimers.shift()!;
      next.fn();
    }
  }

  test("two overlapping ping cycles on a hung child schedule at most one restart", async () => {
    const proc = makeFakeProc();
    spawnedProcs.push(proc);

    const state = createInitialChildState(makeSpec());
    state.status = "running";
    state.proc = proc as unknown as ChildState["proc"];
    state.pid = proc.pid;
    // One strike already recorded → this cycle pushes it over the threshold.
    state.hungStrikes = HUNG_STRIKES_MAX - 1;

    const children = new Map<string, ChildState>([["sige", state]]);
    // Route the restart through the real scheduleRestart so its dedup applies.
    const onScheduleRestart = mock((s: ChildState) =>
      scheduleRestart(
        s,
        () => true,
        mock(() => {}),
      ),
    );

    // Fire two ping cycles "concurrently" against the same map. The pong-wait
    // setTimeout is captured; flush everything to resolve both awaits.
    const a = pingChildren(children, onScheduleRestart);
    const b = pingChildren(children, onScheduleRestart);
    flushAllTimers();
    await Promise.all([a, b]);

    // The hung proc was group-killed with SIGKILL (tree kill).
    expect(groupKillFor(proc.pid).some((k) => k.signal === "SIGKILL")).toBe(true);
    // The first cycle nulls state.proc; the second cycle's identity check
    // (state.proc !== proc) then skips it → exactly one restart trigger.
    expect(onScheduleRestart).toHaveBeenCalledTimes(1);
    // Exactly one backoff respawn timer is armed.
    expect(capturedTimers).toHaveLength(1);
  });
});

// ── Tree kill via killChild ─────────────────────────────────────────────────

describe("killChild — group (tree) kill", () => {
  test("SIGTERMs the whole group, then SIGKILLs the group on timeout", async () => {
    const state = createInitialChildState(makeSpec());
    spawnChild(
      state,
      () => true,
      mock(() => {}),
    );
    const proc = spawnedProcs[0]!;

    // Never resolve proc.exited → force the graceful-timeout SIGKILL path.
    await killChild(state, 5);

    const signals = groupKillFor(proc.pid).map((k) => k.signal);
    expect(signals).toContain("SIGTERM");
    expect(signals).toContain("SIGKILL");
    expect(state.proc).toBeNull();
    expect(state.pid).toBeNull();
  });
});

// ── PID-reuse guard ─────────────────────────────────────────────────────────
// If the leader PID has already been reaped, the negative-pid group signal must
// NOT be sent (it could hit a recycled, unrelated process group). The liveness
// probe is `process.kill(pid, 0)`; we simulate a reaped leader by making that
// probe throw ESRCH for the child's pid.

describe("killChild — does not group-signal a reaped leader (PID-reuse guard)", () => {
  test("when process.kill(pid, 0) throws, no negative-pid group signal is sent", async () => {
    const state = createInitialChildState(makeSpec());
    spawnChild(
      state,
      () => true,
      mock(() => {}),
    );
    const proc = spawnedProcs[0]!;

    // Override process.kill so the liveness probe (signal 0) reports the leader
    // as already gone; still record any negative-pid group signals attempted.
    process.kill = ((pid: number, signal?: string | number) => {
      if (signal === 0) {
        const err = new Error("ESRCH") as Error & { code: string };
        err.code = "ESRCH";
        throw err;
      }
      groupKills.push({ pid, signal });
      return true;
    }) as typeof process.kill;

    await killChild(state, 5);

    // No GROUP signal (-pid) was delivered for the reaped leader.
    expect(groupKillFor(proc.pid)).toHaveLength(0);
    // The direct, safe per-proc fallback still ran (SIGTERM then SIGKILL).
    expect(proc.killed).toContain("SIGTERM");
    expect(proc.killed).toContain("SIGKILL");
    expect(state.proc).toBeNull();
  });
});
