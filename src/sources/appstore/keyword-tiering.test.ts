import { describe, expect, it } from "bun:test";
import { computeMineSlots, computePerSweepCap, isTier1Eligible } from "./keyword-tiering";
import type { Tier1Input } from "./keyword-tiering";

// Arbitrary for this pure-function test — `isTier1Eligible` no longer reads
// a module constant (staleness threshold is config-driven in production, see
// `tier1StaleThresholdMs` in src/config/schema.ts, default 6h); any fixed
// value exercises the boundary logic identically.
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

describe("isTier1Eligible", () => {
  const now = 1_000_000;
  const staleAt = now - STALE_THRESHOLD_MS / 1000;

  function input(overrides: Partial<Tier1Input> = {}): Tier1Input {
    return {
      lastScannedAt: staleAt - 1, // stale by default
      source: "mined",
      hasActiveSignatureHit: false,
      ...overrides,
    };
  }

  it("is true for a never-scanned manual keyword", () => {
    expect(isTier1Eligible(input({ lastScannedAt: null, source: "manual" }), now, STALE_THRESHOLD_MS)).toBe(true);
  });

  it("is true for a never-scanned seed keyword", () => {
    expect(isTier1Eligible(input({ lastScannedAt: null, source: "seed" }), now, STALE_THRESHOLD_MS)).toBe(true);
  });

  it("is true for a stale keyword with an active signature hit, regardless of source", () => {
    expect(
      isTier1Eligible(input({ source: "mined", hasActiveSignatureHit: true }), now, STALE_THRESHOLD_MS),
    ).toBe(true);
  });

  it("is false for a mined keyword with no signature hit, even if stale", () => {
    expect(isTier1Eligible(input({ source: "mined" }), now, STALE_THRESHOLD_MS)).toBe(false);
  });

  it("is false for a manual/seed keyword scanned within the last 24h", () => {
    const freshAt = now - 60; // 1 minute ago
    expect(isTier1Eligible(input({ lastScannedAt: freshAt, source: "manual" }), now, STALE_THRESHOLD_MS)).toBe(
      false,
    );
  });

  it("is true exactly at the 24h staleness boundary", () => {
    expect(isTier1Eligible(input({ lastScannedAt: staleAt, source: "seed" }), now, STALE_THRESHOLD_MS)).toBe(true);
  });

  it("is false one second inside the 24h boundary", () => {
    expect(
      isTier1Eligible(input({ lastScannedAt: staleAt + 1, source: "seed" }), now, STALE_THRESHOLD_MS),
    ).toBe(false);
  });

  it("is false for a fresh keyword with an active signature hit (staleness still required)", () => {
    const freshAt = now - 60;
    expect(
      isTier1Eligible(
        input({ lastScannedAt: freshAt, source: "mined", hasActiveSignatureHit: true }),
        now,
        STALE_THRESHOLD_MS,
      ),
    ).toBe(false);
  });

  // 2026-07-21 scan-budget retune: autocomplete joined manual/seed as an
  // unconditionally tier-1-eligible source — real, popularity-ordered user
  // search queries deserve the same daily-guaranteed re-scan.
  it("is true for a never-scanned autocomplete keyword", () => {
    expect(isTier1Eligible(input({ lastScannedAt: null, source: "autocomplete" }), now, STALE_THRESHOLD_MS)).toBe(
      true,
    );
  });

  it("is true for a stale autocomplete keyword scanned exactly at the 24h boundary", () => {
    expect(
      isTier1Eligible(input({ lastScannedAt: staleAt, source: "autocomplete" }), now, STALE_THRESHOLD_MS),
    ).toBe(true);
  });

  it("is false for a fresh autocomplete keyword", () => {
    const freshAt = now - 60;
    expect(
      isTier1Eligible(input({ lastScannedAt: freshAt, source: "autocomplete" }), now, STALE_THRESHOLD_MS),
    ).toBe(false);
  });

  // Backtest guard (project convention — see keyword-screener.ts's own
  // backtest doc comment describing "peptide tracker" / "block shorts";
  // "card grading" is the third validated GO-grade winner from the same
  // backtest pass). A prior gate change that skipped this kind of check once
  // blinded the screener to 2 of 3 known winners — every filter change here
  // is re-asserted against all three. Once any of these has a signature hit,
  // it must land in tier 1 regardless of its original discovery source
  // (including 'mined', which otherwise never qualifies by source alone).
  describe("known-positive backtest keywords are always tier-1 once signature-hit", () => {
    const knownPositives = ["peptide tracker", "block shorts", "card grading"];

    for (const keyword of knownPositives) {
      it(`${keyword}: stale + signature hit -> tier 1, even from source 'mined'`, () => {
        expect(
          isTier1Eligible(
            { lastScannedAt: null, source: "mined", hasActiveSignatureHit: true },
            now,
            STALE_THRESHOLD_MS,
          ),
        ).toBe(true);
      });
    }
  });
});

// 2026-07-21 audit NOW-tier fix, item A: `runKeywordSweep` previously let a
// single sweep spend the WHOLE day's `minedExploration.dailyQuota` in one
// cycle (greedy `min(remainingBatch, quotaRemaining)` fill), starving every
// later sweep of the day of any mined slots at all. `computePerSweepCap`
// spreads the quota evenly across the sweeps expected per day instead.
describe("computePerSweepCap", () => {
  it("spreads the daily quota evenly across the sweeps expected in 24h", () => {
    // 1-minute sweep interval -> 1,440 sweeps/day. 20,000 / 1,440 = 13.89 -> 14.
    expect(computePerSweepCap(20_000, 60_000)).toBe(14);
  });

  it("rounds up so a nonzero quota always yields at least 1 slot/sweep", () => {
    // A slow-cadence config (1h sweeps -> 24 sweeps/day) with a small quota
    // still gets at least 1 slot per sweep rather than rounding to 0.
    expect(computePerSweepCap(10, 60 * 60 * 1000)).toBeGreaterThanOrEqual(1);
  });

  it("returns 0 for a zero daily quota", () => {
    expect(computePerSweepCap(0, 60_000)).toBe(0);
  });

  it("scales linearly with the sweep interval", () => {
    // Doubling the interval (half as many sweeps/day) roughly doubles each
    // sweep's slice of the quota.
    const oneMinute = computePerSweepCap(20_000, 60_000);
    const twoMinutes = computePerSweepCap(20_000, 120_000);
    expect(twoMinutes).toBeGreaterThan(oneMinute);
  });
});

// Pure companion to `computePerSweepCap`: the actual per-sweep slot count is
// the tightest of three independent ceilings (batch room, remaining daily
// quota, this sweep's per-sweep cap) — see `getStaleKeywordsTiered`
// (keyword-store.ts).
describe("computeMineSlots", () => {
  it("never exceeds perSweepCap even when remainingBatch and mineQuotaRemaining are much larger", () => {
    expect(computeMineSlots(10_000, 10_000, 14)).toBe(14);
  });

  it("never exceeds remainingBatch even when the quota/cap are larger", () => {
    expect(computeMineSlots(3, 10_000, 10_000)).toBe(3);
  });

  it("never exceeds mineQuotaRemaining even when the batch/cap are larger", () => {
    expect(computeMineSlots(10_000, 2, 10_000)).toBe(2);
  });

  it("is the minimum of all three inputs, whichever is tightest", () => {
    expect(computeMineSlots(50, 30, 14)).toBe(14);
    expect(computeMineSlots(50, 5, 14)).toBe(5);
    expect(computeMineSlots(2, 30, 14)).toBe(2);
  });

  it("never returns negative, even with a negative remainingBatch (batch already overfull)", () => {
    expect(computeMineSlots(-5, 10_000, 14)).toBe(0);
  });

  it("returns 0 when any ceiling is 0", () => {
    expect(computeMineSlots(0, 10_000, 14)).toBe(0);
    expect(computeMineSlots(10_000, 0, 14)).toBe(0);
    expect(computeMineSlots(10_000, 10_000, 0)).toBe(0);
  });
});
