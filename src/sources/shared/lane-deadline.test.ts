/**
 * Unit tests for the lane-step hard deadline.
 *
 * Regression basis: `indexUnindexedReviews()` / `indexUnindexedRankings()`
 * parked the App Store hourly chain for 2.5h+ on 2026-07-25 (Qdrant connects
 * stuck in SYN_SENT). The guarantee under test is that the CALLER always
 * settles, whatever the underlying operation does.
 */
import { describe, it, expect } from "bun:test";
import { LaneDeadlineError, withLaneDeadline, MEMORY_INDEXING_DEADLINE_MS } from "./lane-deadline";

describe("withLaneDeadline", () => {
  it("returns the value when the work settles in time", async () => {
    const value = await withLaneDeadline("test", 1000, async () => "ok");
    expect(value).toBe("ok");
  });

  it("rejects with LaneDeadlineError when the work never settles", async () => {
    const started = performance.now();

    await expect(
      withLaneDeadline("test:never-settles", 50, () => new Promise<never>(() => {})),
    ).rejects.toBeInstanceOf(LaneDeadlineError);

    // Must have settled at roughly the deadline, not hung.
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("carries the label and deadline on the error for logging", async () => {
    try {
      await withLaneDeadline("appstore:index-reviews", 10, () => new Promise<never>(() => {}));
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LaneDeadlineError);
      const deadlineErr = err as LaneDeadlineError;
      expect(deadlineErr.label).toBe("appstore:index-reviews");
      expect(deadlineErr.deadlineMs).toBe(10);
      expect(deadlineErr.name).toBe("LaneDeadlineError");
    }
  });

  it("propagates the underlying failure rather than masking it as a timeout", async () => {
    await expect(
      withLaneDeadline("test", 1000, async () => {
        throw new Error("qdrant refused");
      }),
    ).rejects.toThrow("qdrant refused");
  });

  it("does not fire the deadline for work that finishes just under it", async () => {
    const value = await withLaneDeadline(
      "test",
      500,
      () => new Promise<string>((resolve) => setTimeout(() => resolve("just in time"), 10)),
    );
    expect(value).toBe("just in time");
  });

  it("budgets memory indexing well below the hourly scrape cadence", () => {
    // The lane it guards ticks hourly; a deadline at or above that would let a
    // wedged vector store hold the lane into the next tick — the exact bug.
    expect(MEMORY_INDEXING_DEADLINE_MS).toBeLessThan(60 * 60_000);
    expect(MEMORY_INDEXING_DEADLINE_MS).toBeGreaterThan(60_000);
  });
});
