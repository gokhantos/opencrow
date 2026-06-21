import { test, expect, describe } from "bun:test";
import {
  parseCompetability,
  decideCompetability,
  hardVetoCompetability,
  heuristicMoatFlags,
  buildCompetabilityPersisted,
  candidateCompetabilityPersisted,
  persistedToCandidateCompetability,
  type CompetabilityScore,
  type CompetabilityDimension,
  ALWAYS_REJECT_OVERALL,
  DEFAULT_REJECT_THRESHOLD,
  DEFAULT_SOFT_PENALTY_THRESHOLD,
  DEFAULT_HARD_VETO_THRESHOLD,
} from "./competability";
import { buildIncumbentSet } from "./incumbents";

function score(overrides: Partial<CompetabilityScore> = {}): CompetabilityScore {
  return {
    dimensions: { capital: 1, networkEffect: 1, logistics: 1, regulated: 1 },
    overall: 4,
    rationale: "",
    ...overrides,
  };
}

describe("parseCompetability", () => {
  test("clamps scores into [0,5] and trims rationale", () => {
    const parsed = parseCompetability({
      dimensions: { capital: 9, networkEffect: -2, logistics: 3, regulated: 4 },
      overall: 7,
      rationale: "  heavy logistics  ",
    });
    expect(parsed.dimensions.capital).toBe(5);
    expect(parsed.dimensions.networkEffect).toBe(0);
    expect(parsed.overall).toBe(5);
    expect(parsed.rationale).toBe("heavy logistics");
  });

  test("missing dimensions default to neutral midpoint, never throws", () => {
    const parsed = parseCompetability({});
    expect(parsed.dimensions.capital).toBe(2.5);
    expect(parsed.overall).toBe(2.5);
  });

  test("garbage input degrades to neutral defaults", () => {
    expect(parseCompetability(null).overall).toBe(2.5);
    expect(parseCompetability("nope").overall).toBe(2.5);
  });
});

describe("decideCompetability", () => {
  test("a DoorDash-style idea (overall 1, dominant logistics) REJECTS", () => {
    const doordash = score({
      dimensions: { capital: 5, networkEffect: 5, logistics: 5, regulated: 2 },
      overall: 1,
    });
    const decision = decideCompetability(doordash);
    expect(decision.pass).toBe(false);
    expect(decision.soft).toBe(false);
  });

  test("a sharp niche idea (overall 4, low moats) PASSES cleanly", () => {
    const niche = score({
      dimensions: { capital: 1, networkEffect: 0, logistics: 0, regulated: 0 },
      overall: 4,
    });
    const decision = decideCompetability(niche);
    expect(decision.pass).toBe(true);
    expect(decision.soft).toBe(false);
  });

  test("overall at/below always-reject is rejected regardless of threshold", () => {
    const decision = decideCompetability(score({ overall: ALWAYS_REJECT_OVERALL }), {
      rejectThreshold: 0,
    });
    expect(decision.pass).toBe(false);
  });

  test("dominant single moat with mid overall is a hard reject (non-compensatory)", () => {
    // overall 2.8 sits in the soft band, but a network-effect == 5 sinks it.
    const decision = decideCompetability(
      score({
        dimensions: { capital: 1, networkEffect: 5, logistics: 1, regulated: 1 },
        overall: 2.8,
      }),
    );
    expect(decision.pass).toBe(false);
    expect(decision.reason).toContain("networkEffect");
  });

  test("overall in the soft band passes but is flagged soft", () => {
    const decision = decideCompetability(
      score({
        dimensions: { capital: 2, networkEffect: 2, logistics: 1, regulated: 1 },
        overall: (DEFAULT_REJECT_THRESHOLD + DEFAULT_SOFT_PENALTY_THRESHOLD) / 2,
      }),
    );
    expect(decision.pass).toBe(true);
    expect(decision.soft).toBe(true);
  });

  test("respects custom thresholds", () => {
    const s = score({ overall: 3 });
    expect(decideCompetability(s, { rejectThreshold: 3.5 }).pass).toBe(false);
    expect(decideCompetability(s, { rejectThreshold: 2 }).pass).toBe(true);
  });
});

describe("hardVetoCompetability", () => {
  const FATAL: readonly CompetabilityDimension[] = [
    "regulated",
    "capital",
    "logistics",
    "networkEffect",
  ];

  // A high overall (4.5) proves the veto fires INDEPENDENTLY of the composite —
  // a passing overall must NOT rescue an idea with a fatal raw dimension.
  function withDim(
    dim: CompetabilityDimension,
    value: number,
  ): CompetabilityScore {
    return score({
      dimensions: { capital: 1, networkEffect: 1, logistics: 1, regulated: 1, [dim]: value },
      overall: 4.5,
    });
  }

  for (const dim of FATAL) {
    test(`${dim} at raw ${DEFAULT_HARD_VETO_THRESHOLD} vetoes even when overall is high (4.5)`, () => {
      const v = hardVetoCompetability(withDim(dim, DEFAULT_HARD_VETO_THRESHOLD));
      expect(v.vetoed).toBe(true);
      expect(v.dimension).toBe(dim);
      expect(v.value).toBe(DEFAULT_HARD_VETO_THRESHOLD);
      expect(v.reason).toContain(`${dim}=${DEFAULT_HARD_VETO_THRESHOLD}`);
    });

    test(`${dim} at raw 5 vetoes`, () => {
      const v = hardVetoCompetability(withDim(dim, 5));
      expect(v.vetoed).toBe(true);
      expect(v.dimension).toBe(dim);
      expect(v.value).toBe(5);
    });

    test(`${dim} at raw 3 (below threshold) is NOT vetoed`, () => {
      const v = hardVetoCompetability(withDim(dim, 3));
      expect(v.vetoed).toBe(false);
      expect(v.dimension).toBeNull();
      expect(v.value).toBeNull();
      expect(v.reason).toBe("");
    });
  }

  test("all four families are fatal at the default threshold (none escapes)", () => {
    for (const dim of FATAL) {
      expect(hardVetoCompetability(withDim(dim, 4)).vetoed).toBe(true);
    }
  });

  test("an idea with all dims at raw 3 (overall low) is NOT vetoed", () => {
    const v = hardVetoCompetability(
      score({
        dimensions: { capital: 3, networkEffect: 3, logistics: 3, regulated: 3 },
        overall: 1,
      }),
    );
    expect(v.vetoed).toBe(false);
  });

  test("respects a custom threshold", () => {
    const s = withDim("regulated", 3);
    expect(hardVetoCompetability(s, { threshold: 3 }).vetoed).toBe(true);
    expect(hardVetoCompetability(s, { threshold: 4 }).vetoed).toBe(false);
  });

  test("respects a custom fatal-dimension subset (non-fatal dims ignored)", () => {
    // Only `capital` is fatal here; a regulated==5 idea is NOT vetoed.
    const regulatedHeavy = withDim("regulated", 5);
    expect(
      hardVetoCompetability(regulatedHeavy, { dimensions: ["capital"] }).vetoed,
    ).toBe(false);
    // But a capital==5 idea IS vetoed under the same subset.
    expect(
      hardVetoCompetability(withDim("capital", 5), { dimensions: ["capital"] }).vetoed,
    ).toBe(true);
  });

  test("returns the FIRST breaching dimension deterministically", () => {
    // capital precedes networkEffect in the default order; both breach.
    const v = hardVetoCompetability(
      score({
        dimensions: { capital: 5, networkEffect: 5, logistics: 1, regulated: 1 },
        overall: 1,
      }),
    );
    expect(v.dimension).toBe("capital");
  });

  test("is PURE — does not mutate its input score", () => {
    const s = withDim("logistics", 4);
    const snapshot = JSON.stringify(s);
    hardVetoCompetability(s);
    expect(JSON.stringify(s)).toBe(snapshot);
  });
});

describe("heuristicMoatFlags", () => {
  const incumbents = buildIncumbentSet(["DoorDash", "Uber"]);

  test("flags an obvious uncompetable shell (moat keyword + named incumbent)", () => {
    const v = heuristicMoatFlags(
      "A food delivery app to rival DoorDash in small towns",
      incumbents,
    );
    expect(v.flags).toContain("logistics");
    expect(v.namesIncumbent).toBe(true);
    expect(v.obvious).toBe(true);
  });

  test("a moat keyword ALONE is a flag, not obvious", () => {
    const v = heuristicMoatFlags("A two-sided marketplace for niche crafts", incumbents);
    expect(v.flags).toContain("networkEffect");
    expect(v.obvious).toBe(false);
  });

  test("a named incumbent ALONE is a flag, not obvious", () => {
    const v = heuristicMoatFlags("A budgeting tool inspired by Uber's design", incumbents);
    expect(v.namesIncumbent).toBe(true);
    expect(v.obvious).toBe(false);
  });

  test("a clean solo-buildable idea has no flags", () => {
    const v = heuristicMoatFlags("A CLI that lints your SQL migrations", incumbents);
    expect(v.flags).toEqual([]);
    expect(v.namesIncumbent).toBe(false);
    expect(v.obvious).toBe(false);
  });

  test("detects regulated-market keywords", () => {
    const v = heuristicMoatFlags("A neobank for freelancers", new Set<string>());
    expect(v.flags).toContain("regulated");
  });
});

describe("buildCompetabilityPersisted", () => {
  test("returns null for a missing score (un-scored idea)", () => {
    expect(buildCompetabilityPersisted(null, "n/a", false)).toBeNull();
    expect(buildCompetabilityPersisted(undefined, "n/a", false)).toBeNull();
  });

  test("builds the persisted scorecard, clamping overall", () => {
    const s: CompetabilityScore = {
      dimensions: { capital: 5, networkEffect: 5, logistics: 0, regulated: 0 },
      overall: 1,
      rationale: "two-sided marketplace",
    };
    const persisted = buildCompetabilityPersisted(s, "overall 1 < reject", true);
    expect(persisted).not.toBeNull();
    expect(persisted!.dimensions).toEqual(s.dimensions);
    expect(persisted!.overall).toBe(1);
    expect(persisted!.reason).toBe("overall 1 < reject");
    expect(persisted!.gated).toBe(true);
  });

  test("clamps an out-of-range overall into [0,5]", () => {
    const s: CompetabilityScore = {
      dimensions: { capital: 0, networkEffect: 0, logistics: 0, regulated: 0 },
      overall: 99,
      rationale: "",
    };
    expect(buildCompetabilityPersisted(s, "", false)!.overall).toBe(5);
  });
});

describe("candidateCompetabilityPersisted", () => {
  test("returns null when the candidate has no competability dims", () => {
    expect(candidateCompetabilityPersisted({})).toBeNull();
    expect(
      candidateCompetabilityPersisted({ competabilityOverall: 3 }),
    ).toBeNull();
  });

  test("reconstructs the scorecard from loose candidate fields", () => {
    const persisted = candidateCompetabilityPersisted({
      competability: { capital: 4, networkEffect: 2, logistics: 1, regulated: 0 },
      competabilityOverall: 2.5,
      competabilityGated: true,
      competabilityReason: "soft band",
    });
    expect(persisted).not.toBeNull();
    expect(persisted!.dimensions.capital).toBe(4);
    expect(persisted!.overall).toBe(2.5);
    expect(persisted!.gated).toBe(true);
    expect(persisted!.reason).toBe("soft band");
  });

  test("defaults overall to the neutral midpoint and clamps dims", () => {
    const persisted = candidateCompetabilityPersisted({
      competability: { capital: 99, networkEffect: -5, logistics: 3, regulated: 3 },
    });
    expect(persisted!.dimensions.capital).toBe(5);
    expect(persisted!.dimensions.networkEffect).toBe(0);
    expect(persisted!.overall).toBe(2.5);
    expect(persisted!.gated).toBe(false);
    expect(persisted!.reason).toBe("");
  });
});

describe("persistedToCandidateCompetability", () => {
  test("returns empty fields when there is no scorecard", () => {
    expect(persistedToCandidateCompetability(null)).toEqual({});
    expect(persistedToCandidateCompetability(undefined)).toEqual({});
  });

  test("round-trips a stored scorecard back into loose candidate fields", () => {
    const fields = persistedToCandidateCompetability({
      dimensions: { capital: 2, networkEffect: 5, logistics: 1, regulated: 1 },
      overall: 1.5,
      reason: "uncompetable",
      gated: true,
      raw: {
        dimensions: { capital: 5, networkEffect: 5, logistics: 1, regulated: 1 },
        overall: 1,
      },
      matchedExpertiseDomain: "marketplaces",
    });
    expect(fields.competability).toEqual({
      capital: 2,
      networkEffect: 5,
      logistics: 1,
      regulated: 1,
    });
    expect(fields.competabilityOverall).toBe(1.5);
    expect(fields.competabilityGated).toBe(true);
    expect(fields.competabilityReason).toBe("uncompetable");
    expect(fields.competabilityRaw?.capital).toBe(5);
    expect(fields.competabilityRawOverall).toBe(1);
    expect(fields.competabilityMatchedExpertiseDomain).toBe("marketplaces");
  });

  test("is the inverse of candidateCompetabilityPersisted (round-trip stable)", () => {
    const original = candidateCompetabilityPersisted({
      competability: { capital: 3, networkEffect: 4, logistics: 2, regulated: 1 },
      competabilityOverall: 2.5,
      competabilityGated: false,
      competabilityReason: "soft band",
    });
    const back = persistedToCandidateCompetability(original);
    const again = candidateCompetabilityPersisted(back);
    expect(again).toEqual(original);
  });
});
