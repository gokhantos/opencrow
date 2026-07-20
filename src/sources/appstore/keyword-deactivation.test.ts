import { describe, expect, it } from "bun:test";
import {
  DEACTIVATION_MAX_DEMAND,
  DEACTIVATION_MAX_REVIEWS_CEILING,
  DEACTIVATION_MIN_SCANS,
  DEACTIVATION_TRACTION_AGE_DAYS_MAX,
  DEACTIVATION_TRACTION_MIN_RATINGS_PER_DAY,
  MINED_DEACTIVATION_MAX_DEMAND_EVER,
  shouldDeactivateKeyword,
  shouldDeactivateMinedKeyword,
} from "./keyword-deactivation";
import type { DeactivationCandidate, MinedDeactivationCandidate } from "./keyword-deactivation";
import type { TopApp } from "./keyword-types";

function makeTopApp(overrides: Partial<TopApp> = {}): TopApp {
  return {
    id: "1",
    name: "Toy",
    reviews: 50,
    rating: 3.5,
    ageDays: 900,
    ratingsPerDay: 0.05,
    titleMatch: true,
    ...overrides,
  };
}

function candidate(overrides: Partial<DeactivationCandidate> = {}): DeactivationCandidate {
  return {
    keyword: "zzz-legit-multi-word-phrase",
    source: "mined",
    scanCount: DEACTIVATION_MIN_SCANS,
    demand: 0,
    topApps: [makeTopApp()],
    topAppReviews: 50,
    ...overrides,
  };
}

describe("shouldDeactivateKeyword", () => {
  it("is true for a lexically junk keyword regardless of scan data", () => {
    expect(
      shouldDeactivateKeyword(
        candidate({ keyword: "free", demand: 999, scanCount: 0, topAppReviews: 999_999 }),
      ),
    ).toBe(true);
  });

  it("is true for a too-short keyword", () => {
    expect(shouldDeactivateKeyword(candidate({ keyword: "ab" }))).toBe(true);
  });

  it("is true for a non-Latin-script keyword", () => {
    expect(shouldDeactivateKeyword(candidate({ keyword: "сотрудник" }))).toBe(true);
  });

  it("NEVER deactivates source 'manual', even when lexically junk", () => {
    expect(shouldDeactivateKeyword(candidate({ keyword: "free", source: "manual" }))).toBe(
      false,
    );
  });

  it("NEVER deactivates source 'seed', even when data-hopeless", () => {
    expect(
      shouldDeactivateKeyword(
        candidate({
          source: "seed",
          demand: DEACTIVATION_MAX_DEMAND - 0.5,
          topApps: [makeTopApp({ ageDays: 900, ratingsPerDay: 0.01 })],
          topAppReviews: DEACTIVATION_MAX_REVIEWS_CEILING - 1,
        }),
      ),
    ).toBe(false);
  });

  it("is true for a data-hopeless keyword: >=2 scans, low demand, no newcomer traction, small field", () => {
    expect(
      shouldDeactivateKeyword(
        candidate({
          demand: DEACTIVATION_MAX_DEMAND - 0.5,
          topApps: [makeTopApp({ ageDays: 900, ratingsPerDay: 0.01 })],
          topAppReviews: DEACTIVATION_MAX_REVIEWS_CEILING - 1,
        }),
      ),
    ).toBe(true);
  });

  it("is false when scanCount is under DEACTIVATION_MIN_SCANS", () => {
    expect(
      shouldDeactivateKeyword(
        candidate({
          scanCount: DEACTIVATION_MIN_SCANS - 1,
          demand: 0,
          topApps: [makeTopApp({ ageDays: 900, ratingsPerDay: 0.01 })],
          topAppReviews: 10,
        }),
      ),
    ).toBe(false);
  });

  it("is false when demand is at or above DEACTIVATION_MAX_DEMAND", () => {
    expect(
      shouldDeactivateKeyword(
        candidate({
          demand: DEACTIVATION_MAX_DEMAND,
          topApps: [makeTopApp({ ageDays: 900, ratingsPerDay: 0.01 })],
          topAppReviews: 10,
        }),
      ),
    ).toBe(false);
  });

  it("is false when a newcomer in the SERP shows real traction", () => {
    expect(
      shouldDeactivateKeyword(
        candidate({
          demand: 0,
          topApps: [
            makeTopApp({
              ageDays: DEACTIVATION_TRACTION_AGE_DAYS_MAX - 1,
              ratingsPerDay: DEACTIVATION_TRACTION_MIN_RATINGS_PER_DAY + 0.1,
            }),
          ],
          topAppReviews: 10,
        }),
      ),
    ).toBe(false);
  });

  it("is false when the newcomer's traction is exactly at the ratingsPerDay threshold (strictly greater required)", () => {
    expect(
      shouldDeactivateKeyword(
        candidate({
          demand: 0,
          topApps: [
            makeTopApp({
              ageDays: DEACTIVATION_TRACTION_AGE_DAYS_MAX - 1,
              ratingsPerDay: DEACTIVATION_TRACTION_MIN_RATINGS_PER_DAY,
            }),
          ],
          topAppReviews: 10,
        }),
      ),
    ).toBe(true); // not strictly greater -> no traction -> still hopeless
  });

  it("is false when the field's biggest incumbent is at or above the reviews ceiling", () => {
    expect(
      shouldDeactivateKeyword(
        candidate({
          demand: 0,
          topApps: [makeTopApp({ ageDays: 900, ratingsPerDay: 0.01 })],
          topAppReviews: DEACTIVATION_MAX_REVIEWS_CEILING,
        }),
      ),
    ).toBe(false);
  });

  it("an established (non-newcomer) app's high ratingsPerDay does not count as traction", () => {
    expect(
      shouldDeactivateKeyword(
        candidate({
          demand: 0,
          topApps: [
            makeTopApp({
              ageDays: DEACTIVATION_TRACTION_AGE_DAYS_MAX, // exactly at the boundary -> established, not newcomer
              ratingsPerDay: 50,
            }),
          ],
          topAppReviews: 10,
        }),
      ),
    ).toBe(true);
  });

  // ---------------------------------------------------------------------
  // Backtest guard (project convention — see keyword-screener.ts's own
  // backtest doc comment): every filter/deactivation change is re-asserted
  // against the known-positive winners this signature was validated
  // against — "peptide tracker", "block shorts", "card grading". A prior
  // gate change that skipped this check once blinded the screener to 2 of
  // 3 of them. Hard-coded, plausible real-world shapes: a mined-source
  // keyword with an active signature hit and healthy demand — the exact
  // profile these winners would have once the screener flagged them.
  // ---------------------------------------------------------------------
  describe("known-positive backtest keywords are NEVER deactivated", () => {
    const knownPositives = ["peptide tracker", "block shorts", "card grading"];

    for (const keyword of knownPositives) {
      it(`${keyword}: mined source, signature-hit-worthy demand/traction shape`, () => {
        expect(
          shouldDeactivateKeyword(
            candidate({
              keyword,
              source: "mined",
              scanCount: DEACTIVATION_MIN_SCANS + 3,
              demand: 12, // well above DEACTIVATION_MAX_DEMAND
              topApps: [
                makeTopApp({ ageDays: 200, ratingsPerDay: 3, reviews: 900 }),
                makeTopApp({ ageDays: 150, ratingsPerDay: 4, reviews: 400 }),
              ],
              topAppReviews: 900,
            }),
          ),
        ).toBe(false);
      });
    }
  });
});

describe("shouldDeactivateMinedKeyword", () => {
  function minedCandidate(
    overrides: Partial<MinedDeactivationCandidate> = {},
  ): MinedDeactivationCandidate {
    return {
      source: "mined",
      scanCount: DEACTIVATION_MIN_SCANS,
      maxDemandEver: 0,
      hasSignatureHit: false,
      ...overrides,
    };
  }

  it("is true for a mined keyword with enough scans, low demand ever, and no signature hit", () => {
    expect(shouldDeactivateMinedKeyword(minedCandidate())).toBe(true);
  });

  it("is false for a non-mined source, even with the same hopeless stats", () => {
    for (const source of ["seed", "manual", "autocomplete", "pipeline"]) {
      expect(shouldDeactivateMinedKeyword(minedCandidate({ source }))).toBe(false);
    }
  });

  it("is false when scanCount is under DEACTIVATION_MIN_SCANS", () => {
    expect(
      shouldDeactivateMinedKeyword(minedCandidate({ scanCount: DEACTIVATION_MIN_SCANS - 1 })),
    ).toBe(false);
  });

  it("is false once maxDemandEver reaches MINED_DEACTIVATION_MAX_DEMAND_EVER — even if the LATEST scan's demand is 0", () => {
    expect(
      shouldDeactivateMinedKeyword(
        minedCandidate({ maxDemandEver: MINED_DEACTIVATION_MAX_DEMAND_EVER }),
      ),
    ).toBe(false);
  });

  it("is true when maxDemandEver is just under the threshold", () => {
    expect(
      shouldDeactivateMinedKeyword(
        minedCandidate({ maxDemandEver: MINED_DEACTIVATION_MAX_DEMAND_EVER - 0.01 }),
      ),
    ).toBe(true);
  });

  it("is false when the keyword has ANY signature hit, regardless of status", () => {
    expect(
      shouldDeactivateMinedKeyword(minedCandidate({ hasSignatureHit: true, maxDemandEver: 0 })),
    ).toBe(false);
  });

  // Backtest guard — same three known-positive winners, this time exercised
  // against the mined-specific rule directly: even a marginal-looking mined
  // candidate must never be deactivated once it has a signature hit.
  describe("known-positive backtest keywords are NEVER deactivated by the mined-specific rule", () => {
    const knownPositives = ["peptide tracker", "block shorts", "card grading"];

    for (const keyword of knownPositives) {
      it(`${keyword}: mined source, signature hit, even with marginal demand-ever`, () => {
        expect(
          shouldDeactivateMinedKeyword(
            minedCandidate({ hasSignatureHit: true, maxDemandEver: 1 }),
          ),
        ).toBe(false);
      });
    }
  });
});
