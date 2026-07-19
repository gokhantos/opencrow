import { describe, expect, it } from "bun:test";
import {
  computeTier1Cap,
  isTier1Eligible,
  TIER1_MAX_BATCH_FRACTION,
  TIER1_STALE_THRESHOLD_MS,
} from "./keyword-tiering";
import type { Tier1Input } from "./keyword-tiering";

describe("isTier1Eligible", () => {
  const now = 1_000_000;
  const staleAt = now - TIER1_STALE_THRESHOLD_MS / 1000;

  function input(overrides: Partial<Tier1Input> = {}): Tier1Input {
    return {
      lastScannedAt: staleAt - 1, // stale by default
      source: "mined",
      hasActiveSignatureHit: false,
      ...overrides,
    };
  }

  it("is true for a never-scanned manual keyword", () => {
    expect(isTier1Eligible(input({ lastScannedAt: null, source: "manual" }), now)).toBe(true);
  });

  it("is true for a never-scanned seed keyword", () => {
    expect(isTier1Eligible(input({ lastScannedAt: null, source: "seed" }), now)).toBe(true);
  });

  it("is true for a stale keyword with an active signature hit, regardless of source", () => {
    expect(
      isTier1Eligible(input({ source: "mined", hasActiveSignatureHit: true }), now),
    ).toBe(true);
  });

  it("is false for a mined keyword with no signature hit, even if stale", () => {
    expect(isTier1Eligible(input({ source: "mined" }), now)).toBe(false);
  });

  it("is false for a manual/seed keyword scanned within the last 24h", () => {
    const freshAt = now - 60; // 1 minute ago
    expect(isTier1Eligible(input({ lastScannedAt: freshAt, source: "manual" }), now)).toBe(
      false,
    );
  });

  it("is true exactly at the 24h staleness boundary", () => {
    expect(isTier1Eligible(input({ lastScannedAt: staleAt, source: "seed" }), now)).toBe(true);
  });

  it("is false one second inside the 24h boundary", () => {
    expect(
      isTier1Eligible(input({ lastScannedAt: staleAt + 1, source: "seed" }), now),
    ).toBe(false);
  });

  it("is false for a fresh keyword with an active signature hit (staleness still required)", () => {
    const freshAt = now - 60;
    expect(
      isTier1Eligible(
        input({ lastScannedAt: freshAt, source: "mined", hasActiveSignatureHit: true }),
        now,
      ),
    ).toBe(false);
  });
});

describe("computeTier1Cap", () => {
  it("floors batchLimit * TIER1_MAX_BATCH_FRACTION", () => {
    expect(computeTier1Cap(100)).toBe(Math.floor(100 * TIER1_MAX_BATCH_FRACTION));
    expect(computeTier1Cap(25)).toBe(7); // floor(7.5)
    expect(computeTier1Cap(75)).toBe(22); // floor(22.5)
  });

  it("never returns a negative number", () => {
    expect(computeTier1Cap(0)).toBe(0);
  });

  it("returns 0 for a batch limit under 1/fraction", () => {
    expect(computeTier1Cap(1)).toBe(0);
  });
});
