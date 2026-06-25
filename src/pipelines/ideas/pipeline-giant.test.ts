import { test, expect, describe } from "bun:test";
import {
  candidateHasDemandEvidence,
  evaluateCandidateGiantGate,
} from "./pipeline";
import {
  GIANT_DEFAULT_WEIGHTS,
  aggregateGiant,
  type GiantAxisScores,
} from "./giant";
import type { GiantConfig } from "../../config/schema";
import type { GeneratedIdeaCandidate } from "./types";

// ── Pipeline-level GIANT gate (PHASE 0) ────────────────────────────────────
//
// Pure tests for the pipeline boundary's GIANT helpers: the best-effort demand
// evidence check and the gate re-evaluation that drives shadow-mode kill logs +
// persistence. No DB / network — these are deterministic pure functions.

const GIANT_CONFIG_SHADOW: GiantConfig = {
  enabled: true,
  enforceGates: false,
  critiqueBatchSize: 7,
  weights: { ...GIANT_DEFAULT_WEIGHTS },
};

const GIANT_CONFIG_ENFORCE: GiantConfig = {
  enabled: true,
  enforceGates: true,
  critiqueBatchSize: 7,
  weights: { ...GIANT_DEFAULT_WEIGHTS },
};

/** A baseline strong-on-every-axis scorecard (no hard gate, demand high). */
const STRONG_SCORES: GiantAxisScores = {
  acuteProblem: 4,
  whyNow: 4,
  demand: 5,
  monetization: 4,
  feasibility: 4,
  nonObviousness: 4,
  defensibility: 4,
  marketShape: 4,
  founderFit: 4,
};

function candidate(
  overrides: Partial<GeneratedIdeaCandidate> = {},
): GeneratedIdeaCandidate {
  return {
    title: "Test idea",
    summary: "summary",
    reasoning: "reasoning",
    designDescription: "design",
    monetizationDetail: "monetization",
    sourceLinks: [],
    sourcesUsed: "sources",
    category: "productivity",
    qualityScore: 3,
    targetAudience: "audience",
    keyFeatures: ["a", "b"],
    revenueModel: "subscription",
    trendIntersection: "intersection",
    ...overrides,
  };
}

describe("candidateHasDemandEvidence", () => {
  test("false when no GIANT evidence and no signal-bound whyNow", () => {
    expect(candidateHasDemandEvidence(candidate())).toBe(false);
  });

  test("false when demand evidence is only whitespace", () => {
    const c = candidate({
      giantEvidence: {
        acuteProblem: "",
        whyNow: "",
        demand: "   ",
        monetization: "",
        feasibility: "",
        nonObviousness: "",
        defensibility: "",
        marketShape: "",
        founderFit: "",
      },
    });
    expect(candidateHasDemandEvidence(c)).toBe(false);
  });

  test("true when a non-empty demand evidence citation exists", () => {
    const c = candidate({
      giantEvidence: {
        acuteProblem: "",
        whyNow: "",
        demand: "1.2k LinkedIn job posts in Q1",
        monetization: "",
        feasibility: "",
        nonObviousness: "",
        defensibility: "",
        marketShape: "",
        founderFit: "",
      },
    });
    expect(candidateHasDemandEvidence(c)).toBe(true);
  });

  test("true when a whyNow shift is bound to a real signal id", () => {
    const c = candidate({
      whyNow: [
        {
          axis: "behavioral",
          claim: "waitlist spike",
          boundSignalId: "producthunt_2",
          strength: 0.7,
        },
      ],
    });
    expect(candidateHasDemandEvidence(c)).toBe(true);
  });

  test("false when whyNow shift has an empty boundSignalId", () => {
    const c = candidate({
      whyNow: [{ axis: "technological", claim: "new model", strength: 0.5 }],
    });
    expect(candidateHasDemandEvidence(c)).toBe(false);
  });
});

describe("evaluateCandidateGiantGate", () => {
  test("recomputes via aggregateGiant from raw axis scores when present", () => {
    const c = candidate({ giant: STRONG_SCORES });
    const gate = evaluateCandidateGiantGate(c, GIANT_CONFIG_SHADOW);

    // Must match aggregateGiant directly (config weights, no demand evidence ->
    // demand capped). No hard gate -> not gated.
    const expected = aggregateGiant(STRONG_SCORES, {
      weights: GIANT_DEFAULT_WEIGHTS,
      enforceGates: false,
      hasDemandEvidence: false,
    });
    expect(gate.composite).toBeCloseTo(expected.composite, 10);
    expect(gate.gated).toBe(false);
  });

  test("hard gate fires when acuteProblem <= 1", () => {
    const c = candidate({ giant: { ...STRONG_SCORES, acuteProblem: 1 } });
    const gate = evaluateCandidateGiantGate(c, GIANT_CONFIG_SHADOW);
    expect(gate.gated).toBe(true);
    expect(gate.gateReasons.some((r) => r.startsWith("hard-gate:acuteProblem"))).toBe(
      true,
    );
  });

  test("hard gate fires when whyNow <= 1", () => {
    const c = candidate({ giant: { ...STRONG_SCORES, whyNow: 0 } });
    const gate = evaluateCandidateGiantGate(c, GIANT_CONFIG_SHADOW);
    expect(gate.gated).toBe(true);
    expect(gate.gateReasons.some((r) => r.startsWith("hard-gate:whyNow"))).toBe(true);
  });

  test("demand evidence-gate caps demand and records a reason without evidence", () => {
    const c = candidate({ giant: STRONG_SCORES });
    const gate = evaluateCandidateGiantGate(c, GIANT_CONFIG_SHADOW);
    // No demand evidence -> demand (5) capped to 2 -> composite < the
    // evidenced version. Reason is recorded but it is not a hard gate.
    expect(
      gate.gateReasons.some((r) => r.startsWith("demand-evidence-gate")),
    ).toBe(true);
    expect(gate.gated).toBe(false);

    const evidenced = aggregateGiant(STRONG_SCORES, {
      weights: GIANT_DEFAULT_WEIGHTS,
      hasDemandEvidence: true,
    });
    expect(gate.composite).toBeLessThan(evidenced.composite);
  });

  test("demand evidence lifts the cap when a citation is present", () => {
    const c = candidate({
      giant: STRONG_SCORES,
      giantEvidence: {
        acuteProblem: "",
        whyNow: "",
        demand: "2k waitlist signups",
        monetization: "",
        feasibility: "",
        nonObviousness: "",
        defensibility: "",
        marketShape: "",
        founderFit: "",
      },
    });
    const gate = evaluateCandidateGiantGate(c, GIANT_CONFIG_SHADOW);
    expect(
      gate.gateReasons.some((r) => r.startsWith("demand-evidence-gate")),
    ).toBe(false);
  });

  test("enforceGates flag does not change the computed gate verdict (shadow vs enforce)", () => {
    const c = candidate({ giant: { ...STRONG_SCORES, acuteProblem: 0 } });
    const shadow = evaluateCandidateGiantGate(c, GIANT_CONFIG_SHADOW);
    const enforce = evaluateCandidateGiantGate(c, GIANT_CONFIG_ENFORCE);
    expect(shadow.gated).toBe(enforce.gated);
    expect(shadow.composite).toBeCloseTo(enforce.composite, 10);
  });

  test("falls back to stored giant fields when raw axis scores are absent", () => {
    const c = candidate({
      giantComposite: 2.5,
      giantGated: true,
      giantGateReasons: ["hard-gate:acuteProblem score 1 <= 1"],
    });
    const gate = evaluateCandidateGiantGate(c, GIANT_CONFIG_SHADOW);
    expect(gate.composite).toBe(2.5);
    expect(gate.gated).toBe(true);
    expect(gate.gateReasons).toEqual(["hard-gate:acuteProblem score 1 <= 1"]);
  });

  test("never invents a kill when no GIANT data is present at all", () => {
    const c = candidate({ qualityScore: 3.2 });
    const gate = evaluateCandidateGiantGate(c, GIANT_CONFIG_SHADOW);
    expect(gate.gated).toBe(false);
    expect(gate.gateReasons).toEqual([]);
    // composite falls back to qualityScore when nothing was stamped.
    expect(gate.composite).toBe(3.2);
  });

  test("config weight overrides flow through to the composite", () => {
    const c = candidate({ giant: STRONG_SCORES });
    const skewed: GiantConfig = {
      enabled: true,
      enforceGates: false,
      critiqueBatchSize: 7,
      weights: { ...GIANT_DEFAULT_WEIGHTS, demand: 0 },
    };
    const gate = evaluateCandidateGiantGate(c, skewed);
    const expected = aggregateGiant(STRONG_SCORES, {
      weights: { ...GIANT_DEFAULT_WEIGHTS, demand: 0 },
      hasDemandEvidence: false,
    });
    expect(gate.composite).toBeCloseTo(expected.composite, 10);
  });
});
