import { describe, expect, it } from "bun:test";
import {
  DEACTIVATION_MAX_DEMAND,
  DEACTIVATION_MAX_REVIEWS_CEILING,
  DEACTIVATION_MIN_SCANS,
  DEACTIVATION_TRACTION_AGE_DAYS_MAX,
  DEACTIVATION_TRACTION_MIN_RATINGS_PER_DAY,
  shouldDeactivateKeyword,
} from "./keyword-deactivation";
import type { DeactivationCandidate } from "./keyword-deactivation";
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
});
