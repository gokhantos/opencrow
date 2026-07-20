import { test, expect, describe } from "bun:test";
import {
  isOrphaned,
  createParentWatchdog,
  PARENT_WATCHDOG_INTERVAL_MS,
  type ParentWatchdog,
} from "./parent-watchdog";

// ── isOrphaned (pure decision) ───────────────────────────────────────────────

describe("isOrphaned", () => {
  test("not orphaned while ppid equals the captured parent pid", () => {
    expect(isOrphaned(500, 500)).toBe(false);
  });

  test("orphaned when reparented to init/launchd (ppid becomes 1)", () => {
    expect(isOrphaned(1, 500)).toBe(true);
  });

  test("orphaned when reparented to a subreaper (ppid changes to a non-1 pid)", () => {
    expect(isOrphaned(999, 500)).toBe(true);
  });

  test("ppid <= 1 is always treated as orphaned even against a bogus baseline", () => {
    expect(isOrphaned(0, 0)).toBe(true);
    expect(isOrphaned(1, 1)).toBe(true);
  });
});

// ── createParentWatchdog.check() (deterministic, no real timers) ─────────────

describe("createParentWatchdog.check", () => {
  test("child exits when its ppid becomes 1 (the core died)", () => {
    // Simulate ppid flipping from the live parent (500) to 1 after the core dies.
    let ppid = 500;
    const orphanedWith: number[] = [];

    const watchdog = createParentWatchdog(
      { initialParentPid: 500 },
      {
        getPpid: () => ppid,
        onOrphaned: (p) => orphanedWith.push(p),
      },
    );

    // Parent still alive → no action across repeated checks.
    expect(watchdog.check()).toBe(false);
    expect(watchdog.check()).toBe(false);
    expect(orphanedWith).toEqual([]);

    // Core dies → reparented to init (pid 1).
    ppid = 1;
    expect(watchdog.check()).toBe(true);
    expect(orphanedWith).toEqual([1]);
  });

  test("onOrphaned fires at most once even if checked repeatedly after death", () => {
    let ppid = 500;
    let calls = 0;

    const watchdog = createParentWatchdog(
      { initialParentPid: 500 },
      { getPpid: () => ppid, onOrphaned: () => calls++ },
    );

    ppid = 1;
    expect(watchdog.check()).toBe(true);
    expect(watchdog.check()).toBe(true);
    expect(watchdog.check()).toBe(true);
    expect(calls).toBe(1);
  });

  test("detects reparent to a non-1 pid (subreaper) and self-terminates", () => {
    let ppid = 500;
    let fired = false;

    const watchdog = createParentWatchdog(
      { initialParentPid: 500 },
      { getPpid: () => ppid, onOrphaned: () => (fired = true) },
    );

    expect(watchdog.check()).toBe(false);
    ppid = 4242; // adopted by a subreaper, not init
    expect(watchdog.check()).toBe(true);
    expect(fired).toBe(true);
  });
});

// ── start()/stop() timer wiring (injected timers) ────────────────────────────

describe("createParentWatchdog start/stop", () => {
  function fakeTimers() {
    let nextId = 1;
    const scheduled = new Map<number, () => void>();
    let lastMs: number | null = null;
    const handle = {
      setIntervalFn: (fn: () => void, ms: number) => {
        lastMs = ms;
        const id = nextId++;
        scheduled.set(id, fn);
        // Shape mirrors a Bun/Node timer enough for .unref?.() to be a no-op.
        return { id, unref: () => {} } as unknown as ReturnType<typeof setInterval>;
      },
      clearIntervalFn: (h: ReturnType<typeof setInterval>) => {
        scheduled.delete((h as unknown as { id: number }).id);
      },
      tick: () => {
        for (const fn of scheduled.values()) fn();
      },
      size: () => scheduled.size,
      lastMs: () => lastMs,
    };
    return handle;
  }

  test("start arms one interval that fires the check; stop clears it", () => {
    const timers = fakeTimers();
    let ppid = 500;
    let fired = false;

    const watchdog: ParentWatchdog = createParentWatchdog(
      { initialParentPid: 500 },
      {
        getPpid: () => ppid,
        onOrphaned: () => (fired = true),
        setIntervalFn: timers.setIntervalFn,
        clearIntervalFn: timers.clearIntervalFn,
      },
    );

    watchdog.start();
    expect(timers.size()).toBe(1);
    expect(timers.lastMs()).toBe(PARENT_WATCHDOG_INTERVAL_MS);

    // Interval fires while parent alive → nothing happens.
    timers.tick();
    expect(fired).toBe(false);

    // Parent dies → next interval fire triggers onOrphaned.
    ppid = 1;
    timers.tick();
    expect(fired).toBe(true);

    watchdog.stop();
    expect(timers.size()).toBe(0);
  });

  test("start is idempotent — a second start does not arm a second timer", () => {
    const timers = fakeTimers();
    const watchdog = createParentWatchdog(
      { initialParentPid: 500 },
      {
        getPpid: () => 500,
        onOrphaned: () => {},
        setIntervalFn: timers.setIntervalFn,
        clearIntervalFn: timers.clearIntervalFn,
      },
    );

    watchdog.start();
    watchdog.start();
    expect(timers.size()).toBe(1);
  });

  test("honors a custom interval", () => {
    const timers = fakeTimers();
    const watchdog = createParentWatchdog(
      { initialParentPid: 500, intervalMs: 1234 },
      {
        getPpid: () => 500,
        setIntervalFn: timers.setIntervalFn,
        clearIntervalFn: timers.clearIntervalFn,
      },
    );
    watchdog.start();
    expect(timers.lastMs()).toBe(1234);
  });
});
