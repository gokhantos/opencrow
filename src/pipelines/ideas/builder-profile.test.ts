import { describe, expect, test } from "bun:test";
import {
  COMPETABILITY_DIMENSIONS,
  type CompetabilityScore,
} from "./competability";
import {
  DEFAULT_BUILDER_PROFILE,
  type BuilderProfile,
  applyBuilderProfile,
  decideCompetabilityForProfile,
  describeBuilderProfile,
  matchExpertiseDomain,
} from "./builder-profile";

function score(
  dims: Partial<Record<(typeof COMPETABILITY_DIMENSIONS)[number], number>>,
  overall: number,
): CompetabilityScore {
  return {
    dimensions: {
      capital: dims.capital ?? 0,
      networkEffect: dims.networkEffect ?? 0,
      logistics: dims.logistics ?? 0,
      regulated: dims.regulated ?? 0,
    },
    overall,
    rationale: "r",
  };
}

function profile(overrides: Partial<BuilderProfile> = {}): BuilderProfile {
  return { ...DEFAULT_BUILDER_PROFILE, ...overrides };
}

describe("applyBuilderProfile — default profile is IDENTITY", () => {
  const cases: CompetabilityScore[] = [
    score({ capital: 5, networkEffect: 5, logistics: 5, regulated: 5 }, 1.0),
    score({ capital: 2, networkEffect: 3, logistics: 1, regulated: 0 }, 2.5),
    score({ capital: 0, networkEffect: 0, logistics: 0, regulated: 0 }, 5.0),
    score({ capital: 4, networkEffect: 1, logistics: 3, regulated: 2 }, 1.8),
  ];

  for (const raw of cases) {
    test(`identity for overall=${raw.overall}`, () => {
      const eff = applyBuilderProfile(raw, DEFAULT_BUILDER_PROFILE);
      for (const dim of COMPETABILITY_DIMENSIONS) {
        expect(eff.dimensions[dim]).toBe(raw.dimensions[dim]);
      }
      expect(eff.overall).toBe(raw.overall);
      expect(eff.matchedExpertiseDomain).toBeNull();
    });
  }
});

describe("applyBuilderProfile — each knob discounts the right dimension", () => {
  const raw = score(
    { capital: 5, networkEffect: 5, logistics: 5, regulated: 5 },
    2.0,
  );

  test("higher capital lowers the capital barrier and raises overall", () => {
    const bootstrap = applyBuilderProfile(raw, profile({ capital: "bootstrap" }));
    const seed = applyBuilderProfile(raw, profile({ capital: "seed" }));
    const funded = applyBuilderProfile(raw, profile({ capital: "funded" }));
    expect(seed.dimensions.capital).toBeLessThan(bootstrap.dimensions.capital);
    expect(funded.dimensions.capital).toBeLessThan(seed.dimensions.capital);
    expect(seed.overall).toBeGreaterThan(bootstrap.overall);
    expect(funded.overall).toBeGreaterThan(seed.overall);
  });

  test("regulatoryAppetite high lowers the regulated barrier", () => {
    const low = applyBuilderProfile(raw, profile({ regulatoryAppetite: "low" }));
    const high = applyBuilderProfile(raw, profile({ regulatoryAppetite: "high" }));
    expect(high.dimensions.regulated).toBeLessThan(low.dimensions.regulated);
    expect(high.overall).toBeGreaterThan(low.overall);
  });

  test("opsAppetite high lowers the logistics barrier", () => {
    const low = applyBuilderProfile(raw, profile({ opsAppetite: "low" }));
    const high = applyBuilderProfile(raw, profile({ opsAppetite: "high" }));
    expect(high.dimensions.logistics).toBeLessThan(low.dimensions.logistics);
  });

  test("larger teamSize lowers logistics monotonically, bounded by cap", () => {
    const solo = applyBuilderProfile(raw, profile({ teamSize: 1 }));
    const small = applyBuilderProfile(raw, profile({ teamSize: 3 }));
    const big = applyBuilderProfile(raw, profile({ teamSize: 50 }));
    expect(small.dimensions.logistics).toBeLessThan(solo.dimensions.logistics);
    expect(big.dimensions.logistics).toBeLessThanOrEqual(small.dimensions.logistics);
    // Cap: 1.5 total discount → logistics floor at 5 - 1.5 = 3.5 (team-only).
    expect(big.dimensions.logistics).toBeGreaterThanOrEqual(3.5);
  });

  test("expertise match lowers the DOMINANT moat dimension", () => {
    const dominantRaw = score(
      { capital: 1, networkEffect: 5, logistics: 1, regulated: 1 },
      2.0,
    );
    const noMatch = applyBuilderProfile(dominantRaw, DEFAULT_BUILDER_PROFILE);
    const matched = applyBuilderProfile(dominantRaw, DEFAULT_BUILDER_PROFILE, {
      matchedExpertiseDomain: "fintech",
    });
    // networkEffect is the dominant (highest raw) dim → it gets discounted.
    expect(matched.dimensions.networkEffect).toBeLessThan(
      noMatch.dimensions.networkEffect,
    );
    expect(matched.matchedExpertiseDomain).toBe("fintech");
  });

  test("networkEffect resists capital — at most a tiny funded discount", () => {
    const netRaw = score(
      { capital: 0, networkEffect: 5, logistics: 0, regulated: 0 },
      2.0,
    );
    const seed = applyBuilderProfile(netRaw, profile({ capital: "seed" }));
    const funded = applyBuilderProfile(netRaw, profile({ capital: "funded" }));
    // Seed capital does NOT touch network effect.
    expect(seed.dimensions.networkEffect).toBe(5);
    // Funded buys only a marginal edge (0.5).
    expect(funded.dimensions.networkEffect).toBe(4.5);
  });
});

describe("applyBuilderProfile — bounds", () => {
  test("effective dims and overall stay within [0,5]", () => {
    const raw = score(
      { capital: 5, networkEffect: 5, logistics: 5, regulated: 5 },
      5.0,
    );
    const eff = applyBuilderProfile(
      raw,
      profile({
        capital: "funded",
        teamSize: 1000,
        regulatoryAppetite: "high",
        opsAppetite: "high",
      }),
      { matchedExpertiseDomain: "anything" },
    );
    for (const dim of COMPETABILITY_DIMENSIONS) {
      expect(eff.dimensions[dim]).toBeGreaterThanOrEqual(0);
      expect(eff.dimensions[dim]).toBeLessThanOrEqual(5);
    }
    expect(eff.overall).toBeGreaterThanOrEqual(0);
    expect(eff.overall).toBeLessThanOrEqual(5);
  });

  test("transform never RAISES a barrier (effective <= raw per dim)", () => {
    const raw = score(
      { capital: 2, networkEffect: 3, logistics: 1, regulated: 4 },
      2.0,
    );
    const eff = applyBuilderProfile(
      raw,
      profile({ capital: "funded", teamSize: 10, regulatoryAppetite: "high" }),
    );
    for (const dim of COMPETABILITY_DIMENSIONS) {
      expect(eff.dimensions[dim]).toBeLessThanOrEqual(raw.dimensions[dim]);
    }
    expect(eff.overall).toBeGreaterThanOrEqual(raw.overall);
  });
});

describe("matchExpertiseDomain", () => {
  test("case-insensitive whole-word match returns the domain", () => {
    expect(matchExpertiseDomain("A Fintech tool for banks", ["fintech"])).toBe(
      "fintech",
    );
    expect(matchExpertiseDomain("HEALTHCARE workflow", ["healthcare"])).toBe(
      "healthcare",
    );
  });

  test("no match returns null", () => {
    expect(matchExpertiseDomain("a gardening app", ["fintech"])).toBeNull();
  });

  test("does not match a substring inside a larger word", () => {
    expect(matchExpertiseDomain("unfintechy nonsense", ["fintech"])).toBeNull();
  });

  test("empty domains returns null", () => {
    expect(matchExpertiseDomain("a fintech tool", [])).toBeNull();
  });

  test("returns first matching domain in original casing", () => {
    expect(
      matchExpertiseDomain("a Healthcare and FinTech tool", [
        "FinTech",
        "Healthcare",
      ]),
    ).toBe("FinTech");
  });
});

describe("describeBuilderProfile", () => {
  test("solo bootstrapper sentence", () => {
    expect(describeBuilderProfile(DEFAULT_BUILDER_PROFILE)).toBe(
      "The builder is a solo bootstrapper.",
    );
  });

  test("funded team with expertise + appetites", () => {
    const desc = describeBuilderProfile(
      profile({
        capital: "funded",
        teamSize: 5,
        expertiseDomains: ["fintech", "healthcare"],
        regulatoryAppetite: "high",
      }),
    );
    expect(desc).toContain("team of 5");
    expect(desc).toContain("funded");
    expect(desc).toContain("fintech and healthcare");
    expect(desc).toContain("high regulatory appetite");
  });
});

describe("decideCompetabilityForProfile — profile-aware DECISION", () => {
  test("logistics-heavy idea FAILS for default but PASSES for funded high-ops", () => {
    const raw = score(
      { capital: 1, networkEffect: 1, logistics: 5, regulated: 1 },
      1.8,
    );
    const def = decideCompetabilityForProfile(raw, DEFAULT_BUILDER_PROFILE, {});
    // Default: dominant logistics=5 + overall 1.8 < 3.0 → hard reject.
    expect(def.decision.pass).toBe(false);

    const funded = decideCompetabilityForProfile(
      raw,
      profile({ capital: "funded", teamSize: 8, opsAppetite: "high" }),
      {},
    );
    // Discounts pull logistics off the dominant floor AND lift overall → passes.
    expect(funded.decision.pass).toBe(true);
    expect(funded.effective.dimensions.logistics).toBeLessThan(5);
    expect(funded.effective.overall).toBeGreaterThan(raw.overall);
  });

  test("expertise match RESCUES a borderline idea", () => {
    // Just below the default reject threshold (2.0).
    const raw = score(
      { capital: 1, networkEffect: 4, logistics: 1, regulated: 1 },
      1.9,
    );
    const noExpertise = decideCompetabilityForProfile(
      raw,
      DEFAULT_BUILDER_PROFILE,
      {},
    );
    expect(noExpertise.decision.pass).toBe(false);

    const withExpertise = decideCompetabilityForProfile(
      raw,
      profile({ expertiseDomains: ["fintech"] }),
      {},
      { matchedExpertiseDomain: "fintech" },
    );
    expect(withExpertise.decision.pass).toBe(true);
  });
});
