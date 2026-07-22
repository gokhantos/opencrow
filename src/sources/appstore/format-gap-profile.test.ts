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
  lowConfidence: false,
  brandNavigational: false,
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

  // Batch A budget rescue (2026-07-22) — see keyword-brand.ts module doc.
  it("omits the brand-navigational note when brandNavigational is false", () => {
    expect(formatGapProfile(profile)).not.toContain("navigational");
  });

  it("surfaces a brand-navigational note when brandNavigational is true", () => {
    const brandy: KeywordGapProfile = { ...profile, brandNavigational: true };
    expect(formatGapProfile(brandy)).toContain("navigational query — demand reflects one brand");
  });

  // Batch D item D2: low-confidence caveat.
  it("appends a caveat line when lowConfidence is true", () => {
    const lowConf: KeywordGapProfile = { ...profile, lowConfidence: true };
    expect(formatGapProfile(lowConf)).toContain(
      "no title-matched incumbent — demand estimated from unrelated non-giant apps",
    );
  });

  it("omits the caveat line when lowConfidence is false", () => {
    expect(formatGapProfile(profile)).not.toContain("Caveat:");
  });

  // Batch D item D1: autocomplete hint evidence line.
  it("surfaces the autocomplete hint rank/seed count when present", () => {
    const withHint: KeywordGapProfile = { ...profile, hintBestRank: 2, hintSeedCount: 3 };
    const output = formatGapProfile(withHint);
    expect(output).toContain("observed as a real typed query, rank 2");
    expect(output).toContain("3 seeds");
  });

  it("uses singular 'seed' for a single-seed observation", () => {
    const withHint: KeywordGapProfile = { ...profile, hintBestRank: 0, hintSeedCount: 1 };
    expect(formatGapProfile(withHint)).toContain("1 seed)");
  });

  it("omits the hint line when there is no hint evidence", () => {
    const noHint: KeywordGapProfile = { ...profile, hintBestRank: null, hintSeedCount: null };
    expect(formatGapProfile(noHint)).not.toContain("Autocomplete hint");
  });

  it("omits the hint line when seedCount is 0 (evidence unavailable, not a real observation)", () => {
    const zeroSeeds: KeywordGapProfile = { ...profile, hintBestRank: null, hintSeedCount: 0 };
    expect(formatGapProfile(zeroSeeds)).not.toContain("Autocomplete hint");
  });

  it("prints 'unverified' when no ASA popularity reading is passed", () => {
    const output = formatGapProfile(profile);
    expect(output).toContain("ASA popularity: unverified");
  });

  it("prints 'unverified' when volumeCheck is explicitly null", () => {
    const output = formatGapProfile(profile, null);
    expect(output).toContain("ASA popularity: unverified");
  });

  it("prints the popularity score and probed date when a volumeCheck is passed", () => {
    const output = formatGapProfile(profile, { popularity: 1, checkedAt: 1_784_548_800 });
    expect(output).toContain("ASA popularity: 1/5 (probed 2026-07-20)");
  });

  it("includes a computed buildability line (Batch F, F2)", () => {
    const output = formatGapProfile(profile);
    expect(output).toContain("Buildability:");
    expect(output).toContain("/100");
  });

  it("does NOT include a low-confidence banner for a normal-confidence profile", () => {
    const output = formatGapProfile(profile);
    expect(output).not.toContain("LOW CONFIDENCE");
  });

  it("includes a low-confidence banner when the profile is lowConfidence (Batch F, F2)", () => {
    const lowConf: KeywordGapProfile = { ...profile, lowConfidence: true };
    const output = formatGapProfile(lowConf);
    expect(output).toContain("LOW CONFIDENCE");
  });
});
