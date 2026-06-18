/**
 * Unit tests for the SIGE cross-process cancel watcher.
 *
 * Pure unit tests: the status reader is injected, so there is no DB and no
 * `mock.module` — hence `*.test.ts` (unit lane), not `*.isolated.test.ts`.
 *
 * Contracts under test:
 *  - A polled status that flips to `cancelled` aborts the run's controller within
 *    ~one poll interval.
 *  - A transient DB read error during polling does NOT abort the run.
 *  - The poll interval is cleared by stop() (no leaked timer that keeps firing).
 */
import { describe, test, expect } from "bun:test";
import { startCancelWatcher } from "./cancel-watcher";
import type { SigeSessionStatus } from "./types";

/** Resolve after `ms` real milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const SESSION_ID = "test-session";
// Short interval so tests stay fast while still exercising real timers.
const INTERVAL = 20;

describe("startCancelWatcher", () => {
  test("aborts the controller when the polled status flips to cancelled", async () => {
    let status: SigeSessionStatus = "expert_game";
    const controller = new AbortController();

    const stop = startCancelWatcher({
      sessionId: SESSION_ID,
      controller,
      intervalMs: INTERVAL,
      getStatus: async () => status,
    });

    try {
      // Not aborted while the status is non-terminal.
      await sleep(INTERVAL * 2);
      expect(controller.signal.aborted).toBe(false);

      // Flip to cancelled — the next poll must abort.
      status = "cancelled";
      await sleep(INTERVAL * 3);
      expect(controller.signal.aborted).toBe(true);
    } finally {
      stop();
    }
  });

  test("aborts on any externally-set terminal status (failed)", async () => {
    let status: SigeSessionStatus = "social_simulation";
    const controller = new AbortController();
    const stop = startCancelWatcher({
      sessionId: SESSION_ID,
      controller,
      intervalMs: INTERVAL,
      getStatus: async () => status,
    });

    try {
      status = "failed";
      await sleep(INTERVAL * 3);
      expect(controller.signal.aborted).toBe(true);
    } finally {
      stop();
    }
  });

  test("a transient read error does NOT abort the run", async () => {
    const controller = new AbortController();
    let calls = 0;
    const stop = startCancelWatcher({
      sessionId: SESSION_ID,
      controller,
      intervalMs: INTERVAL,
      getStatus: async () => {
        calls += 1;
        throw new Error("transient DB read failure");
      },
    });

    try {
      await sleep(INTERVAL * 4);
      // Polled multiple times and every read threw — still must not abort.
      expect(calls).toBeGreaterThan(1);
      expect(controller.signal.aborted).toBe(false);
    } finally {
      stop();
    }
  });

  test("a null status (session vanished) does NOT abort the run", async () => {
    const controller = new AbortController();
    const stop = startCancelWatcher({
      sessionId: SESSION_ID,
      controller,
      intervalMs: INTERVAL,
      getStatus: async () => null,
    });

    try {
      await sleep(INTERVAL * 3);
      expect(controller.signal.aborted).toBe(false);
    } finally {
      stop();
    }
  });

  test("stop() clears the interval — no further polls fire", async () => {
    let calls = 0;
    const controller = new AbortController();
    const stop = startCancelWatcher({
      sessionId: SESSION_ID,
      controller,
      intervalMs: INTERVAL,
      getStatus: async () => {
        calls += 1;
        return "expert_game";
      },
    });

    await sleep(INTERVAL * 2);
    stop();
    const callsAtStop = calls;

    // Give it several more intervals; no further polls should occur.
    await sleep(INTERVAL * 4);
    expect(calls).toBe(callsAtStop);
  });
});
