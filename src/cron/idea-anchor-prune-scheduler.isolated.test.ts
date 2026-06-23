/**
 * Isolated tests for createIdeaAnchorPruneScheduler.
 *
 * The WRITE client is a CONSTRUCTOR dep (a hand-rolled fake — no mock.module
 * needed). setInterval/clearInterval are stubbed (captured, never scheduled) so
 * lifecycle tests can fire the interval callback manually. Filed *.isolated.test.ts
 * because it swaps globalThis.setInterval — kept narrow per the isolated-lane
 * discipline (the lane shares one process).
 *
 * Verifies:
 *   - one tick computes cutoff = nowSec - retentionDays*86400 and calls
 *     pruneIdeaAnchors with it.
 *   - tickOnce() never throws even when pruneIdeaAnchors throws (the WRITE client
 *     is already never-throw, but the top-level guard must contain anything).
 *   - NON-REENTRANCY: a concurrent tickOnce() while a tick is in-flight is a no-op.
 *   - LIFECYCLE: start()/stop() idempotency; drain() awaits the in-flight tick.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createIdeaAnchorPruneScheduler } from "./idea-anchor-prune-scheduler";
import type { IdeaAnchorPruneSchedulerConfig } from "./idea-anchor-prune-scheduler";
import type { Neo4jWriteClient } from "../sige/knowledge/neo4j-write-client";

// ── Fake setInterval harness (lifecycle tests) ───────────────────────────────
interface CapturedInterval {
  readonly fn: () => void;
  readonly delay: number;
}

let capturedIntervals: CapturedInterval[] = [];
let realSetInterval: typeof globalThis.setInterval;
let realClearInterval: typeof globalThis.clearInterval;

beforeEach(() => {
  capturedIntervals = [];
  realSetInterval = globalThis.setInterval;
  realClearInterval = globalThis.clearInterval;
  globalThis.setInterval = ((fn: () => void, delay: number) => {
    const entry: CapturedInterval = { fn, delay };
    capturedIntervals.push(entry);
    return entry as unknown as ReturnType<typeof setInterval>;
  }) as typeof globalThis.setInterval;
  globalThis.clearInterval = (_handle: unknown) => {};
});

afterEach(() => {
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
});

/** Fake WRITE client recording the cutoffs passed to pruneIdeaAnchors. */
function makeWriteClient(opts: { throwOnPrune?: boolean; deleted?: number } = {}): Neo4jWriteClient & {
  _cutoffs: number[];
} {
  const cutoffs: number[] = [];
  return {
    _cutoffs: cutoffs,
    pruneIdeaAnchors: async (olderThanSec: number) => {
      cutoffs.push(olderThanSec);
      if (opts.throwOnPrune) throw new Error("neo4j down");
      return opts.deleted ?? 0;
    },
    close: async () => {},
  } as unknown as Neo4jWriteClient & { _cutoffs: number[] };
}

function config(over: Partial<IdeaAnchorPruneSchedulerConfig> = {}): IdeaAnchorPruneSchedulerConfig {
  return { tickIntervalMs: 86_400_000, anchorRetentionDays: 90, ...over };
}

describe("createIdeaAnchorPruneScheduler — one tick", () => {
  test("computes the cutoff (now - retentionDays*86400) and prunes with it", async () => {
    const writeClient = makeWriteClient({ deleted: 3 });
    const before = Math.floor(Date.now() / 1000) - 90 * 86_400;
    const scheduler = createIdeaAnchorPruneScheduler({
      writeClient,
      config: config({ anchorRetentionDays: 90 }),
    });

    await scheduler.tickOnce();
    const after = Math.floor(Date.now() / 1000) - 90 * 86_400;

    expect(writeClient._cutoffs.length).toBe(1);
    const cutoff = writeClient._cutoffs[0]!;
    // Cutoff is now-90d in epoch seconds; bracket it to avoid clock flakiness.
    expect(cutoff).toBeGreaterThanOrEqual(before);
    expect(cutoff).toBeLessThanOrEqual(after);
  });

  test("a shorter retention window yields a LATER (larger) cutoff", async () => {
    const writeClient = makeWriteClient();
    const scheduler = createIdeaAnchorPruneScheduler({
      writeClient,
      config: config({ anchorRetentionDays: 1 }),
    });
    await scheduler.tickOnce();
    const expected = Math.floor(Date.now() / 1000) - 1 * 86_400;
    // A 1-day window cuts off ~now-1d, which is much larger than a 90-day cutoff.
    expect(writeClient._cutoffs[0]!).toBeGreaterThan(expected - 5);
  });

  test("tickOnce() never throws when pruneIdeaAnchors throws", async () => {
    const writeClient = makeWriteClient({ throwOnPrune: true });
    const scheduler = createIdeaAnchorPruneScheduler({ writeClient, config: config() });
    await expect(scheduler.tickOnce()).resolves.toBeUndefined();
    // It still attempted the prune (the throw was contained by the tick guard).
    expect(writeClient._cutoffs.length).toBe(1);
  });
});

describe("createIdeaAnchorPruneScheduler — non-reentrancy", () => {
  test("a second tickOnce() while a tick is in-flight returns immediately (no double-prune)", async () => {
    let releasePrune!: () => void;
    const blocking = new Promise<void>((resolve) => {
      releasePrune = resolve;
    });
    let pruneCalls = 0;
    const writeClient = {
      pruneIdeaAnchors: async () => {
        pruneCalls += 1;
        await blocking;
        return 0;
      },
      close: async () => {},
    } as unknown as Neo4jWriteClient;

    const scheduler = createIdeaAnchorPruneScheduler({ writeClient, config: config() });

    // Start tick 1 (in-flight, ticking===true set synchronously before first await).
    const tick1 = scheduler.tickOnce();
    // Concurrent tickOnce() must see ticking===true and no-op.
    await scheduler.tickOnce();

    releasePrune();
    await tick1;

    expect(pruneCalls).toBe(1);
  });
});

describe("createIdeaAnchorPruneScheduler — lifecycle", () => {
  test("start() is idempotent: double-start registers only one interval", () => {
    const scheduler = createIdeaAnchorPruneScheduler({
      writeClient: makeWriteClient(),
      config: config(),
    });
    scheduler.start();
    scheduler.start();
    expect(capturedIntervals).toHaveLength(1);
  });

  test("start() registers the interval with the configured tickIntervalMs", () => {
    const scheduler = createIdeaAnchorPruneScheduler({
      writeClient: makeWriteClient(),
      config: config({ tickIntervalMs: 12_345 }),
    });
    scheduler.start();
    expect(capturedIntervals[0]?.delay).toBe(12_345);
  });

  test("stop() is idempotent (double-stop does not throw)", () => {
    const scheduler = createIdeaAnchorPruneScheduler({
      writeClient: makeWriteClient(),
      config: config(),
    });
    scheduler.start();
    expect(() => scheduler.stop()).not.toThrow();
    expect(() => scheduler.stop()).not.toThrow();
  });

  test("drain() resolves immediately when no tick is in-flight", async () => {
    const scheduler = createIdeaAnchorPruneScheduler({
      writeClient: makeWriteClient(),
      config: config(),
    });
    await expect(scheduler.drain()).resolves.toBeUndefined();
  });

  test("drain() waits for the in-flight tick before resolving", async () => {
    const events: string[] = [];
    let releasePrune!: () => void;
    const blocking = new Promise<void>((resolve) => {
      releasePrune = resolve;
    });
    const writeClient = {
      pruneIdeaAnchors: async () => {
        events.push("prune-start");
        await blocking;
        events.push("prune-done");
        return 0;
      },
      close: async () => {},
    } as unknown as Neo4jWriteClient;

    const scheduler = createIdeaAnchorPruneScheduler({ writeClient, config: config() });

    const tick1 = scheduler.tickOnce();
    let drainResolved = false;
    const drainPromise = scheduler.drain().then(() => {
      drainResolved = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(drainResolved).toBe(false);

    releasePrune();
    await tick1;
    await drainPromise;

    expect(drainResolved).toBe(true);
    expect(events).toEqual(["prune-start", "prune-done"]);
  });
});
