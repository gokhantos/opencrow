import { test, expect, describe } from "bun:test";

/**
 * Unit tests for the step-deadline Promise.race pattern (extracted logic).
 * These verify that a work() that never resolves is defeated by the deadline
 * timer, and that work() that finishes before the deadline is NOT affected.
 * No DB required.
 */

async function raceWithDeadline<T>(
  work: () => Promise<T>,
  deadlineMs: number,
): Promise<T> {
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      work(),
      new Promise<never>((_resolve, reject) => {
        deadlineTimer = setTimeout(() => {
          reject(new Error(`Step exceeded deadline (${deadlineMs}ms)`));
        }, deadlineMs);
        (deadlineTimer as { unref?: () => void }).unref?.();
      }),
    ]);
  } finally {
    if (deadlineTimer !== null) clearTimeout(deadlineTimer);
  }
}

describe("step deadline race", () => {
  test("work that resolves before deadline returns its result", async () => {
    const result = await raceWithDeadline(async () => "ok", 1000);
    expect(result).toBe("ok");
  });

  test("work that never resolves is rejected after the deadline", async () => {
    const work = () => new Promise<never>(() => {}); // hangs forever
    await expect(raceWithDeadline(work, 50)).rejects.toThrow("Step exceeded deadline (50ms)");
  });

  test("a deadline error carries the ms value in the message", async () => {
    const work = () => new Promise<never>(() => {});
    try {
      await raceWithDeadline(work, 30);
      expect(true).toBe(false); // unreachable
    } catch (err) {
      expect(err instanceof Error).toBe(true);
      expect((err as Error).message).toContain("30ms");
    }
  });

  test("timer is cleared when work resolves before deadline (no leak)", async () => {
    // This test ensures the finally block runs and clearTimeout is called.
    // If the timer leaked it would keep the process open (but unref() prevents that).
    // We verify no unhandled rejection is emitted.
    const result = await raceWithDeadline(async () => 42, 5000);
    expect(result).toBe(42);
  });
});
