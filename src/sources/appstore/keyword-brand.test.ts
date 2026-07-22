import { describe, expect, it } from "bun:test";
import {
  BRAND_DOMINANCE_MIN_REVIEWS,
  BRAND_DOMINANCE_REVIEW_SHARE,
  buildBrandSegmentSet,
  isBrandNavigationalCandidate,
  isBrandNavigationalScan,
  isKnownBrandSegment,
  normalizeBrandText,
} from "./keyword-brand";
import type { TopApp } from "./keyword-types";

function makeTopApp(overrides: Partial<TopApp> = {}): TopApp {
  return {
    id: "1",
    name: "Toy",
    reviews: 100,
    rating: 4.0,
    ageDays: 200,
    ratingsPerDay: 0.5,
    titleMatch: true,
    ...overrides,
  };
}

describe("normalizeBrandText", () => {
  it("lowercases, trims, and collapses internal whitespace", () => {
    expect(normalizeBrandText("  Duolingo   Inc  ")).toBe("duolingo inc");
  });
});

describe("buildBrandSegmentSet", () => {
  it("extracts a normalized brand prefix from a separator-bearing app title", () => {
    const segments = buildBrandSegmentSet(["Duolingo: Language Lessons"]);
    expect(segments.has("duolingo")).toBe(true);
  });

  it("ignores app titles with no separator (no brand prefix to extract)", () => {
    const segments = buildBrandSegmentSet(["Notion"]);
    expect(segments.size).toBe(0);
  });

  it("dedupes identical brand prefixes across multiple titles", () => {
    const segments = buildBrandSegmentSet([
      "Duolingo: Language Lessons",
      "Duolingo: Learn Spanish",
    ]);
    expect(segments.size).toBe(1);
  });

  it("drops an empty or too-short brand prefix", () => {
    // Leading separator with nothing before it.
    const segments = buildBrandSegmentSet([": Subtitle Only"]);
    expect(segments.size).toBe(0);
  });
});

describe("isKnownBrandSegment", () => {
  const segments = buildBrandSegmentSet(["Duolingo: Language Lessons"]);

  it("matches a candidate that EXACTLY equals a known brand segment (case/whitespace-insensitive)", () => {
    expect(isKnownBrandSegment("Duolingo", segments)).toBe(true);
    expect(isKnownBrandSegment("  duolingo  ", segments)).toBe(true);
  });

  it("does NOT match a candidate that merely contains the brand segment as a substring", () => {
    expect(isKnownBrandSegment("duolingo plus", segments)).toBe(false);
    expect(isKnownBrandSegment("best duolingo alternative", segments)).toBe(false);
  });

  it("does NOT match an unrelated candidate", () => {
    expect(isKnownBrandSegment("budget planner", segments)).toBe(false);
  });
});

describe("isBrandNavigationalCandidate (layer 1, insert-time)", () => {
  const segments = buildBrandSegmentSet(["Duolingo: Language Lessons"]);

  it("drops a candidate containing a colon separator", () => {
    expect(isBrandNavigationalCandidate("duolingo: language lessons", segments)).toBe(true);
  });

  it("drops a candidate containing a ' - ' separator", () => {
    expect(isBrandNavigationalCandidate("egg timer - boiled eggs", segments)).toBe(true);
  });

  it("drops a candidate containing a ' | ' separator", () => {
    expect(isBrandNavigationalCandidate("app name | subtitle", segments)).toBe(true);
  });

  it("drops a candidate that exactly matches a known brand segment even with no separator of its own", () => {
    expect(isBrandNavigationalCandidate("duolingo", segments)).toBe(true);
  });

  it("keeps a genuine multi-word generic-demand phrase", () => {
    expect(isBrandNavigationalCandidate("budget planner", segments)).toBe(false);
    expect(isBrandNavigationalCandidate("meal prep ideas", segments)).toBe(false);
  });

  // False-positive audit against a small sample of realistic seed-style
  // phrases — see keyword-brand.ts's module doc for the measured live-corpus
  // numbers (0.14% false-positive rate against the real seed/manual corpus,
  // 21% catch rate against a random autocomplete sample).
  it("does not flag realistic seed-style generic phrases as brand-navigational", () => {
    const genericSeeds = [
      "budget planner",
      "meal prep app",
      "habit tracker",
      "workout log",
      "invoice maker",
      "pdf scanner",
      "sleep sounds",
      "period tracker",
    ];
    for (const seed of genericSeeds) {
      expect(isBrandNavigationalCandidate(seed, segments)).toBe(false);
    }
  });
});

describe("isBrandNavigationalScan (layer 2, scan-time)", () => {
  it("is false for an empty field", () => {
    expect(isBrandNavigationalScan([])).toBe(false);
  });

  it("is false when the rank-1 app does not title-match the keyword", () => {
    const topApps = [
      makeTopApp({ id: "1", reviews: 10_000, titleMatch: false }),
      makeTopApp({ id: "2", reviews: 100, titleMatch: false }),
    ];
    expect(isBrandNavigationalScan(topApps)).toBe(false);
  });

  it("is false when the rank-1 app has too few reviews to be meaningfully dominant", () => {
    const topApps = [
      makeTopApp({ id: "1", reviews: BRAND_DOMINANCE_MIN_REVIEWS - 1, titleMatch: true }),
    ];
    expect(isBrandNavigationalScan(topApps)).toBe(false);
  });

  it("is false when the rank-1 app's review share is below the dominance threshold", () => {
    // rank-1 has 500 of (500+500) = 50% share, well under the 80% bar.
    const topApps = [
      makeTopApp({ id: "1", reviews: 500, titleMatch: true }),
      makeTopApp({ id: "2", reviews: 500, titleMatch: false }),
    ];
    expect(isBrandNavigationalScan(topApps)).toBe(false);
  });

  it("is true when the rank-1 app title-matches AND dominates the field's review share", () => {
    const topApps = [
      makeTopApp({ id: "1", reviews: 5000, titleMatch: true }),
      makeTopApp({ id: "2", reviews: 200, titleMatch: false }),
      makeTopApp({ id: "3", reviews: 100, titleMatch: false }),
    ];
    // 5000 / 5300 ≈ 94% share, well above BRAND_DOMINANCE_REVIEW_SHARE.
    expect(isBrandNavigationalScan(topApps)).toBe(true);
  });

  it("is true even for a long-tail (far-below-giant) dominant app — the whole point of the low dominance-min-reviews floor", () => {
    const topApps = [
      makeTopApp({ id: "1", reviews: 250, titleMatch: true }),
      makeTopApp({ id: "2", reviews: 20, titleMatch: false }),
    ];
    expect(isBrandNavigationalScan(topApps)).toBe(true);
  });

  it("is exactly at the boundary at BRAND_DOMINANCE_REVIEW_SHARE", () => {
    const dominant = 800;
    const other = 200; // 800 / 1000 = exactly 0.8
    const topApps = [
      makeTopApp({ id: "1", reviews: dominant, titleMatch: true }),
      makeTopApp({ id: "2", reviews: other, titleMatch: false }),
    ];
    expect(dominant / (dominant + other)).toBe(BRAND_DOMINANCE_REVIEW_SHARE);
    expect(isBrandNavigationalScan(topApps)).toBe(true);
  });
});
