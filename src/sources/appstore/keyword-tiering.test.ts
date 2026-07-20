import { describe, expect, it } from "bun:test";
import { isTier1Eligible, TIER1_STALE_THRESHOLD_MS } from "./keyword-tiering";
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

  // 2026-07-21 scan-budget retune: autocomplete joined manual/seed as an
  // unconditionally tier-1-eligible source — real, popularity-ordered user
  // search queries deserve the same daily-guaranteed re-scan.
  it("is true for a never-scanned autocomplete keyword", () => {
    expect(isTier1Eligible(input({ lastScannedAt: null, source: "autocomplete" }), now)).toBe(
      true,
    );
  });

  it("is true for a stale autocomplete keyword scanned exactly at the 24h boundary", () => {
    expect(
      isTier1Eligible(input({ lastScannedAt: staleAt, source: "autocomplete" }), now),
    ).toBe(true);
  });

  it("is false for a fresh autocomplete keyword", () => {
    const freshAt = now - 60;
    expect(
      isTier1Eligible(input({ lastScannedAt: freshAt, source: "autocomplete" }), now),
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
          ),
        ).toBe(true);
      });
    }
  });
});
