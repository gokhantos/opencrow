import { describe, expect, it } from "bun:test";
import { createMinIntervalGate } from "./min-interval-gate";

describe("createMinIntervalGate", () => {
  it("resolves immediately on the first acquire()", async () => {
    const gate = createMinIntervalGate(50);
    const start = Date.now();
    await gate();
    expect(Date.now() - start).toBeLessThan(25);
  });

  it("delays a second acquire() that arrives before the interval elapses", async () => {
    const gate = createMinIntervalGate(40);
    await gate();
    const start = Date.now();
    await gate();
    const elapsed = Date.now() - start;
    // Allow generous scheduling slack — assert we waited close to the floor,
    // not that we hit it exactly.
    expect(elapsed).toBeGreaterThanOrEqual(25);
  });

  it("does not delay an acquire() that arrives after the interval has elapsed", async () => {
    const gate = createMinIntervalGate(20);
    await gate();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const start = Date.now();
    await gate();
    expect(Date.now() - start).toBeLessThan(15);
  });

  it("serializes concurrent acquire() calls to the minimum interval apart", async () => {
    const gate = createMinIntervalGate(20);
    const start = Date.now();
    await Promise.all([gate(), gate(), gate()]);
    // Three calls at a 20ms floor should take at least ~40ms in total
    // (first is free, second and third each wait out the remaining floor).
    expect(Date.now() - start).toBeGreaterThanOrEqual(25);
  });
});
