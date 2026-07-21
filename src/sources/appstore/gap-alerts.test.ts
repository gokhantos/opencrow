import { describe, expect, it } from "bun:test";
import { formatGapAlertsDigest, isEmptyDigest, type GapAlertsDigest, type KeywordCrossing } from "./gap-alerts";
import type { SignatureHit } from "./signature-hits-store";

/** Minimal SignatureHit factory — only the digest-relevant fields carry meaning. */
function makeHit(overrides: Partial<SignatureHit> & { keyword: string }): SignatureHit {
  return {
    firstDetectedAt: 1_000,
    lastSeenAt: 1_000,
    timesSeen: 1,
    status: "new",
    competitiveness: 20,
    demand: 5.5,
    trend: "heating",
    newcomerRpd: null,
    establishedRpd: null,
    velocityRatio: null,
    fastNewcomers: null,
    acceleratingApps: null,
    maxReviews: null,
    genreZone: null,
    topAppsSnapshot: [],
    ...overrides,
  };
}

function makeCrossing(overrides: Partial<KeywordCrossing> & { keyword: string }): KeywordCrossing {
  return {
    scannedAt: 1_000,
    opportunity: 0.5,
    ...overrides,
  };
}

const EMPTY_DIGEST: GapAlertsDigest = { newSignatureHits: [], newCrossings: [] };

describe("isEmptyDigest", () => {
  it("is true when both sections are empty", () => {
    expect(isEmptyDigest(EMPTY_DIGEST)).toBe(true);
  });

  it("is false when there's at least one signature hit", () => {
    expect(isEmptyDigest({ newSignatureHits: [makeHit({ keyword: "a" })], newCrossings: [] })).toBe(
      false,
    );
  });

  it("is false when there's at least one crossing", () => {
    expect(isEmptyDigest({ newSignatureHits: [], newCrossings: [makeCrossing({ keyword: "a" })] })).toBe(
      false,
    );
  });
});

describe("formatGapAlertsDigest", () => {
  it("returns an empty string for an empty digest", () => {
    expect(formatGapAlertsDigest(EMPTY_DIGEST)).toBe("");
  });

  it("includes both sections when both are non-empty", () => {
    const text = formatGapAlertsDigest({
      newSignatureHits: [makeHit({ keyword: "budget planner", demand: 12.3, trend: "heating" })],
      newCrossings: [makeCrossing({ keyword: "habit tracker widget", opportunity: 0.42 })],
    });
    expect(text).toContain("Newborn-velocity signature hits (1):");
    expect(text).toContain("budget planner");
    expect(text).toContain("demand 12.3");
    expect(text).toContain("First-time opportunity crossings (1):");
    expect(text).toContain("habit tracker widget");
    expect(text).toContain("0.420");
  });

  it("omits a section entirely when it has no items", () => {
    const text = formatGapAlertsDigest({
      newSignatureHits: [makeHit({ keyword: "solo" })],
      newCrossings: [],
    });
    expect(text).toContain("Newborn-velocity signature hits");
    expect(text).not.toContain("First-time opportunity crossings");
  });

  it("truncates long lists and notes the remainder", () => {
    const hits = Array.from({ length: 25 }, (_, i) => makeHit({ keyword: `kw-${i}` }));
    const text = formatGapAlertsDigest({ newSignatureHits: hits, newCrossings: [] });
    expect(text).toContain("Newborn-velocity signature hits (25):");
    expect(text).toContain("… and 5 more");
  });

  it("renders a null demand/trend as n/a rather than throwing", () => {
    const text = formatGapAlertsDigest({
      newSignatureHits: [makeHit({ keyword: "sparse", demand: null, trend: null })],
      newCrossings: [],
    });
    expect(text).toContain("demand n/a, trend n/a");
  });
});
