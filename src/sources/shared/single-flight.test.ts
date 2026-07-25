/**
 * Unit tests for the self-healing single-flight guard.
 *
 * Regression basis: two hangs in two days (2026-07-24 `config_overrides`,
 * 2026-07-25 Qdrant SYN_SENT) each left a plain `xRunning = true` boolean set
 * forever, silently stopping its lane until a manual restart. See
 * `single-flight.ts` and `lane-deadline.ts`.
 */
import { describe, it, expect } from "bun:test";
import { createSingleFlight } from "./single-flight";

/** A promise that never settles — the exact shape of the production hangs. */
const never = (): Promise<never> => new Promise<never>(() => {});

/** Deferred helper so a test can decide when a run finishes. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("createSingleFlight", () => {
  it("runs the work and reports not-running once it settles", async () => {
    const sf = createSingleFlight({ label: "test", maxDurationMs: 1000 });

    const result = await sf.run(async () => "done");

    expect(result).toBe("done");
    expect(sf.isRunning()).toBe(false);
  });

  it("skips an overlapping tick while a healthy claim is in flight", async () => {
    const skips: number[] = [];
    const sf = createSingleFlight({
      label: "test",
      maxDurationMs: 60_000,
      now: () => 0,
      onSkip: (elapsedMs) => skips.push(elapsedMs),
    });
    const gate = deferred<string>();

    const first = sf.run(() => gate.promise);
    const second = await sf.run(async () => "should not run");

    expect(second).toBeUndefined();
    expect(skips).toEqual([0]);

    gate.resolve("first");
    expect(await first).toBe("first");
  });

  it("releases the claim even when the work throws", async () => {
    const sf = createSingleFlight({ label: "test", maxDurationMs: 1000 });

    await expect(
      sf.run(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(sf.isRunning()).toBe(false);
    expect(await sf.run(async () => "next")).toBe("next");
  });

  it("supersedes a claim that has blown its budget — the wedge-recovery case", async () => {
    const stale: number[] = [];
    let nowMs = 0;
    const sf = createSingleFlight({
      label: "test",
      maxDurationMs: 1000,
      now: () => nowMs,
      onStaleRelease: (elapsedMs) => stale.push(elapsedMs),
    });

    // A run that never settles — its `finally` will never fire.
    void sf.run(never);
    expect(sf.isRunning()).toBe(true);

    // Still within budget: the next tick is skipped, lane stays stuck.
    nowMs = 999;
    expect(await sf.run(async () => "too early")).toBeUndefined();
    expect(stale).toEqual([]);

    // Past budget: the stale claim is abandoned and the lane recovers.
    nowMs = 1000;
    expect(await sf.run(async () => "recovered")).toBe("recovered");
    expect(stale).toEqual([1000]);
  });

  it("does not let a superseded zombie release the live run's claim", async () => {
    let nowMs = 0;
    const sf = createSingleFlight({ label: "test", maxDurationMs: 1000, now: () => nowMs });
    const zombie = deferred<string>();

    // First run hangs past its budget and is superseded.
    const first = sf.run(() => zombie.promise);
    nowMs = 5000;
    const second = deferred<string>();
    const live = sf.run(() => second.promise);

    // The zombie finally settles — it must NOT clear the live claim.
    zombie.resolve("zombie");
    await first;
    expect(sf.isRunning()).toBe(true);

    second.resolve("live");
    await live;
    expect(sf.isRunning()).toBe(false);
  });

  it("keeps mutual exclusion across many ticks while one run is healthy", async () => {
    let started = 0;
    const sf = createSingleFlight({ label: "test", maxDurationMs: 60_000, now: () => 0 });
    const gate = deferred<void>();

    const first = sf.run(async () => {
      started += 1;
      await gate.promise;
    });
    for (let i = 0; i < 5; i++) {
      expect(
        await sf.run(async () => {
          started += 1;
        }),
      ).toBeUndefined();
    }

    gate.resolve();
    await first;
    expect(started).toBe(1);
  });
});
