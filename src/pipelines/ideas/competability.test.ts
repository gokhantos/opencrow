import { test, expect, describe } from "bun:test";
import {
  parseCompetability,
  decideCompetability,
  heuristicMoatFlags,
  type CompetabilityScore,
  ALWAYS_REJECT_OVERALL,
  DEFAULT_REJECT_THRESHOLD,
  DEFAULT_SOFT_PENALTY_THRESHOLD,
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
