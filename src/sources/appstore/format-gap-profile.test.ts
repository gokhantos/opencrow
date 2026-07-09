import { describe, expect, it } from "bun:test";
import { formatGapProfile } from "./format-gap-profile";
import type { KeywordGapProfile } from "./keyword-types";

const profile: KeywordGapProfile = {
  keyword: "fatty liver diet",
  store: "app",
  competitiveness: 22,
  demand: 13.4,
  incumbentWeakness: 0.71,
  opportunity: 0.64,
  trend: "heating",
  topAppReviews: 320,
  avgRating: 3.6,
  avgAgeDays: 540,
  topApps: [
    {
      id: "111",
      name: "Liver Health Tracker",
      reviews: 320,
      rating: 3.8,
      ageDays: 400,
      ratingsPerDay: 0.8,
      titleMatch: true,
    },
    {
      id: "222",
      name: "Fatty Liver Coach",
      reviews: 210,
      rating: 3.4,
      ageDays: 620,
      ratingsPerDay: 0.34,
      titleMatch: true,
    },
  ],
  scannedAt: 1_720_000_000,
};

describe("formatGapProfile", () => {
  it("includes the keyword, competitiveness, opportunity, and top incumbents", () => {
    const output = formatGapProfile(profile);

    expect(output).toContain("fatty liver diet");
    expect(output).toContain("22");
    expect(output).toContain("64");
    expect(output).toContain("Liver Health Tracker");
  });

  it("renders without throwing when topApps is empty", () => {
    const empty: KeywordGapProfile = { ...profile, topApps: [] };
    expect(() => formatGapProfile(empty)).not.toThrow();
    expect(formatGapProfile(empty)).toContain("fatty liver diet");
  });
});
