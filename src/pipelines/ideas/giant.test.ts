import { test, expect, describe } from "bun:test";
import {
  GIANT_AXIS_KEYS,
  GIANT_AXES,
  GIANT_DEFAULT_WEIGHTS,
  AXIS_MAX,
  HARD_GATE_THRESHOLD,
  DEMAND_EVIDENCE_CAP,
  GEOMEAN_EPSILON,
  ARCHETYPES,
  WHY_NOW_AXES,
  clampAxisScore,
  aggregateGiant,
  rawGiantSchema,
  parseGiant,
  evaluateGiant,
  type GiantAxisScores,
  type Archetype,
  type WhyNowAxis,
} from "./giant";

// ── helpers ──────────────────────────────────────────────────────────────────

/** Build a full 7-axis score vector, defaulting every axis to `fill`. */
function scores(
  fill: number,
  overrides: Partial<GiantAxisScores> = {},
): GiantAxisScores {
  const out = {} as GiantAxisScores;
  for (const key of GIANT_AXIS_KEYS) out[key] = fill;
  return { ...out, ...overrides };
}

/** Reference weighted-geometric-mean for assertions, mirroring the module. */
function refGeomean(
  s: GiantAxisScores,
  hasDemandEvidence: boolean,
  weights: Partial<Record<string, number>> = GIANT_DEFAULT_WEIGHTS,
): number {
  let logSum = 0;
  let weightSum = 0;
  for (const key of GIANT_AXIS_KEYS) {
    let v = Math.min(AXIS_MAX, Math.max(0, s[key]));
    if (key === "demand" && !hasDemandEvidence) v = Math.min(v, DEMAND_EVIDENCE_CAP);
    v = Math.max(v, GEOMEAN_EPSILON);
    const w = weights[key] ?? GIANT_DEFAULT_WEIGHTS[key];
    logSum += w * Math.log(v);
    weightSum += w;
  }
  return Math.exp(logSum / weightSum);
}

// ── axis table ────────────────────────────────────────────────────────────────

describe("GIANT axis table", () => {
  test("has exactly 7 axes in canonical order", () => {
    expect(GIANT_AXIS_KEYS).toEqual([
      "acuteProblem",
      "whyNow",
      "demand",
      "nonObviousness",
      "defensibility",
      "marketShape",
      "founderFit",
    ]);
  });

  test("default weights are 0.22/0.18/0.18/0.15/0.12/0.08/0.07", () => {
    expect(GIANT_DEFAULT_WEIGHTS.acuteProblem).toBeCloseTo(0.22, 10);
    expect(GIANT_DEFAULT_WEIGHTS.whyNow).toBeCloseTo(0.18, 10);
    expect(GIANT_DEFAULT_WEIGHTS.demand).toBeCloseTo(0.18, 10);
    expect(GIANT_DEFAULT_WEIGHTS.nonObviousness).toBeCloseTo(0.15, 10);
    expect(GIANT_DEFAULT_WEIGHTS.defensibility).toBeCloseTo(0.12, 10);
    expect(GIANT_DEFAULT_WEIGHTS.marketShape).toBeCloseTo(0.08, 10);
    expect(GIANT_DEFAULT_WEIGHTS.founderFit).toBeCloseTo(0.07, 10);
  });

  test("weights sum to 1.0", () => {
    const sum = GIANT_AXIS_KEYS.reduce(
      (acc, k) => acc + GIANT_DEFAULT_WEIGHTS[k],
      0,
    );
    expect(sum).toBeCloseTo(1.0, 10);
  });

  test("only acuteProblem and whyNow are hard gates", () => {
    const gates = GIANT_AXIS_KEYS.filter((k) => GIANT_AXES[k].hardGate);
    expect(gates).toEqual(["acuteProblem", "whyNow"]);
  });

  test("only demand is evidence-gated", () => {
    const gated = GIANT_AXIS_KEYS.filter((k) => GIANT_AXES[k].evidenceGated);
    expect(gated).toEqual(["demand"]);
  });
});

// ── clampAxisScore ────────────────────────────────────────────────────────────

describe("clampAxisScore", () => {
  test("clamps into [0, 5] and floors non-finite to 0", () => {
    expect(clampAxisScore(-3)).toBe(0);
    expect(clampAxisScore(0)).toBe(0);
    expect(clampAxisScore(3)).toBe(3);
    expect(clampAxisScore(5)).toBe(5);
    expect(clampAxisScore(7)).toBe(5);
    expect(clampAxisScore(Number.NaN)).toBe(0);
    expect(clampAxisScore(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

// ── aggregateGiant: geometric mean correctness ────────────────────────────────

describe("aggregateGiant geometric mean", () => {
  test("all-5 with demand evidence ~ 5", () => {
    const out = aggregateGiant(scores(5), { hasDemandEvidence: true });
    expect(out.composite).toBeCloseTo(5, 6);
    expect(out.gated).toBe(false);
    expect(out.gateReasons).toEqual([]);
  });

  test("all-3 equals 3 (geomean of a constant is that constant)", () => {
    const out = aggregateGiant(scores(3), { hasDemandEvidence: true });
    expect(out.composite).toBeCloseTo(3, 6);
  });

  test("all-4 equals 4", () => {
    const out = aggregateGiant(scores(4), { hasDemandEvidence: true });
    expect(out.composite).toBeCloseTo(4, 6);
  });

  test("matches the reference weighted geomean for a mixed vector", () => {
    const s = scores(4, {
      acuteProblem: 5,
      demand: 3,
      defensibility: 2,
      founderFit: 5,
    });
    const out = aggregateGiant(s, { hasDemandEvidence: true });
    expect(out.composite).toBeCloseTo(refGeomean(s, true), 10);
  });

  test("composite is bounded within [0, 5]", () => {
    const out = aggregateGiant(scores(99), { hasDemandEvidence: true });
    expect(out.composite).toBeLessThanOrEqual(5);
    expect(out.composite).toBeGreaterThanOrEqual(0);
  });

  test("is deterministic / pure", () => {
    const s = scores(4, { demand: 5, marketShape: 2 });
    const a = aggregateGiant(s, { hasDemandEvidence: true });
    const b = aggregateGiant(s, { hasDemandEvidence: true });
    expect(a.composite).toBe(b.composite);
  });
});

// ── non-compensatory: a near-zero axis tanks the composite ────────────────────

describe("aggregateGiant non-compensatory behavior", () => {
  test("a single near-zero non-gate axis tanks an otherwise perfect idea", () => {
    const s = scores(5, { defensibility: 0 });
    const out = aggregateGiant(s, { hasDemandEvidence: true });
    // exp of epsilon-clamped geomean — far below the arithmetic mean (~4.3).
    expect(out.composite).toBeCloseTo(refGeomean(s, true), 10);
    expect(out.composite).toBeLessThan(3);
    // and the gate did NOT fire — defensibility is not a hard gate.
    expect(out.gated).toBe(false);
  });

  test("a zero axis can't be bought back by maxing every other axis", () => {
    const tanked = aggregateGiant(scores(5, { marketShape: 0 }), {
      hasDemandEvidence: true,
    });
    const clean = aggregateGiant(scores(5), { hasDemandEvidence: true });
    expect(tanked.composite).toBeLessThan(clean.composite - 1.5);
  });

  test("uses the epsilon floor so a 0 axis stays finite (not 0 or NaN)", () => {
    const out = aggregateGiant(scores(0), { hasDemandEvidence: true });
    expect(Number.isFinite(out.composite)).toBe(true);
    expect(out.composite).toBeGreaterThan(0);
    expect(out.composite).toBeCloseTo(GEOMEAN_EPSILON, 6);
  });
});

// ── hard gates ────────────────────────────────────────────────────────────────

describe("aggregateGiant hard gates", () => {
  test("acuteProblem <= 1 gates the idea", () => {
    const out = aggregateGiant(scores(5, { acuteProblem: 1 }), {
      hasDemandEvidence: true,
    });
    expect(out.gated).toBe(true);
    expect(out.gateReasons.some((r) => r.includes("acuteProblem"))).toBe(true);
  });

  test("whyNow <= 1 gates the idea", () => {
    const out = aggregateGiant(scores(5, { whyNow: 0 }), {
      hasDemandEvidence: true,
    });
    expect(out.gated).toBe(true);
    expect(out.gateReasons.some((r) => r.includes("whyNow"))).toBe(true);
  });

  test("both hard gates can fire and record both reasons", () => {
    const out = aggregateGiant(scores(5, { acuteProblem: 1, whyNow: 1 }), {
      hasDemandEvidence: true,
    });
    expect(out.gated).toBe(true);
    expect(out.gateReasons).toHaveLength(2);
  });

  test("a score just above the threshold (2) does NOT gate", () => {
    const out = aggregateGiant(scores(5, { acuteProblem: 2, whyNow: 2 }), {
      hasDemandEvidence: true,
    });
    expect(out.gated).toBe(false);
    expect(out.gateReasons).toEqual([]);
  });

  test("the threshold is 1 (boundary semantics: <= gates, > does not)", () => {
    expect(HARD_GATE_THRESHOLD).toBe(1);
    // exactly at the threshold → gates.
    expect(aggregateGiant(scores(5, { acuteProblem: 1 })).gated).toBe(true);
    // just above the threshold → does NOT gate.
    expect(
      aggregateGiant(scores(5, { acuteProblem: 1.5 }), { hasDemandEvidence: true })
        .gated,
    ).toBe(false);
  });

  test("gated is reported regardless of enforceGates (shadow mode)", () => {
    const shadow = aggregateGiant(scores(5, { acuteProblem: 0 }), {
      enforceGates: false,
      hasDemandEvidence: true,
    });
    const enforced = aggregateGiant(scores(5, { acuteProblem: 0 }), {
      enforceGates: true,
      hasDemandEvidence: true,
    });
    expect(shadow.gated).toBe(true);
    expect(enforced.gated).toBe(true);
    // enforcement does not change the math the module returns.
    expect(shadow.composite).toBe(enforced.composite);
    expect(shadow.gateReasons).toEqual(enforced.gateReasons);
  });
});

// ── demand evidence-gate ──────────────────────────────────────────────────────

describe("aggregateGiant demand evidence-gate", () => {
  test("without evidence, a high demand axis is capped to 2 in aggregation", () => {
    const withEvidence = aggregateGiant(scores(5), { hasDemandEvidence: true });
    const noEvidence = aggregateGiant(scores(5), { hasDemandEvidence: false });
    expect(noEvidence.composite).toBeLessThan(withEvidence.composite);
    expect(noEvidence.composite).toBeCloseTo(refGeomean(scores(5), false), 10);
  });

  test("default (no opts) treats demand as un-evidenced and caps it", () => {
    const def = aggregateGiant(scores(5));
    const explicit = aggregateGiant(scores(5), { hasDemandEvidence: false });
    expect(def.composite).toBeCloseTo(explicit.composite, 10);
  });

  test("records a cap reason when an over-cap demand is clamped", () => {
    const out = aggregateGiant(scores(5, { demand: 5 }), {
      hasDemandEvidence: false,
    });
    expect(out.gateReasons.some((r) => r.includes("demand-evidence-gate"))).toBe(
      true,
    );
  });

  test("does NOT record a cap reason when demand already <= cap", () => {
    const out = aggregateGiant(scores(5, { demand: 2 }), {
      hasDemandEvidence: false,
    });
    expect(out.gateReasons.some((r) => r.includes("demand-evidence-gate"))).toBe(
      false,
    );
  });

  test("the demand cap does not set gated (it caps, not rejects)", () => {
    const out = aggregateGiant(scores(5, { demand: 5 }), {
      hasDemandEvidence: false,
    });
    expect(out.gated).toBe(false);
  });

  test("with evidence the full demand score flows through (no cap)", () => {
    const out = aggregateGiant(scores(5, { demand: 5 }), {
      hasDemandEvidence: true,
    });
    expect(out.gateReasons).toEqual([]);
    expect(out.composite).toBeCloseTo(5, 6);
  });

  test("DEMAND_EVIDENCE_CAP is 2", () => {
    expect(DEMAND_EVIDENCE_CAP).toBe(2);
  });
});

// ── weight overrides ──────────────────────────────────────────────────────────

describe("aggregateGiant weight overrides", () => {
  test("custom weights shift the composite toward the up-weighted axis", () => {
    const s = scores(2, { acuteProblem: 5 });
    const heavyAcute = aggregateGiant(s, {
      hasDemandEvidence: true,
      weights: { acuteProblem: 0.9 },
    });
    const defaultW = aggregateGiant(s, { hasDemandEvidence: true });
    expect(heavyAcute.composite).toBeGreaterThan(defaultW.composite);
    expect(heavyAcute.composite).toBeCloseTo(
      refGeomean(s, true, { ...GIANT_DEFAULT_WEIGHTS, acuteProblem: 0.9 }),
      10,
    );
  });

  test("missing override axes fall back to default weights", () => {
    const s = scores(3, { demand: 4 });
    const partial = aggregateGiant(s, {
      hasDemandEvidence: true,
      weights: { demand: 0.5 },
    });
    expect(partial.composite).toBeCloseTo(
      refGeomean(s, true, { ...GIANT_DEFAULT_WEIGHTS, demand: 0.5 }),
      10,
    );
  });

  test("negative / non-finite override weights are ignored (fall back to default)", () => {
    const s = scores(4);
    const broken = aggregateGiant(s, {
      hasDemandEvidence: true,
      weights: { acuteProblem: -1, whyNow: Number.NaN },
    });
    const clean = aggregateGiant(s, { hasDemandEvidence: true });
    expect(broken.composite).toBeCloseTo(clean.composite, 10);
  });

  test("equal weights reduce to the unweighted geomean", () => {
    const s = scores(4, { acuteProblem: 5, defensibility: 2 });
    const equal = Object.fromEntries(
      GIANT_AXIS_KEYS.map((k) => [k, 1]),
    ) as Record<string, number>;
    const out = aggregateGiant(s, { hasDemandEvidence: true, weights: equal });
    let product = 1;
    for (const k of GIANT_AXIS_KEYS) product *= Math.max(s[k], GEOMEAN_EPSILON);
    const unweighted = product ** (1 / GIANT_AXIS_KEYS.length);
    expect(out.composite).toBeCloseTo(unweighted, 10);
  });
});

// ── rawGiantSchema ────────────────────────────────────────────────────────────

describe("rawGiantSchema", () => {
  test("parses a well-formed payload and defaults optional fields", () => {
    const parsed = rawGiantSchema.parse({
      scores: {
        acuteProblem: 5,
        whyNow: 4,
        demand: 3,
        nonObviousness: 4,
        defensibility: 3,
        marketShape: 2,
        founderFit: 4,
      },
      archetype: "hair-on-fire",
    });
    expect(parsed.whyNow).toEqual([]);
    expect(parsed.evidence).toEqual({});
    expect(parsed.scores.acuteProblem).toBe(5);
  });

  test("rejects a payload missing a required axis", () => {
    expect(() =>
      rawGiantSchema.parse({
        scores: { acuteProblem: 5 },
        archetype: "hair-on-fire",
      }),
    ).toThrow();
  });
});

// ── parseGiant (tolerant coercion) ────────────────────────────────────────────

describe("parseGiant", () => {
  test("clamps out-of-range scores and fills all 7 axes", () => {
    const parsed = parseGiant({
      scores: {
        acuteProblem: 9,
        whyNow: -2,
        demand: 3,
        // remaining axes omitted → default to 0
      },
      archetype: "hard-fact",
    });
    expect(parsed.scores.acuteProblem).toBe(5);
    expect(parsed.scores.whyNow).toBe(0);
    expect(parsed.scores.demand).toBe(3);
    expect(parsed.scores.nonObviousness).toBe(0);
    expect(Object.keys(parsed.scores).sort()).toEqual(
      [...GIANT_AXIS_KEYS].sort(),
    );
  });

  test("coerces string-number scores", () => {
    const parsed = parseGiant({ scores: { acuteProblem: "4" } });
    expect(parsed.scores.acuteProblem).toBe(4);
  });

  test("normalizes a valid archetype (case / whitespace) and defaults bad ones", () => {
    expect(parseGiant({ archetype: "  HARD-FACT " }).archetype).toBe("hard-fact");
    expect(parseGiant({ archetype: "future-vision" }).archetype).toBe(
      "future-vision",
    );
    expect(parseGiant({ archetype: "nonsense" }).archetype).toBe("hair-on-fire");
    expect(parseGiant({}).archetype).toBe("hair-on-fire");
  });

  test("known archetypes are exactly the three Sequoia tags", () => {
    expect([...ARCHETYPES].sort()).toEqual(
      (["hair-on-fire", "hard-fact", "future-vision"] as Archetype[]).sort(),
    );
  });

  test("coerces whyNow shifts, normalizing axis and clamping strength", () => {
    const parsed = parseGiant({
      whyNow: [
        {
          axis: "REGULATORY",
          claim: "New rule X took effect",
          boundSignalId: "hn_123",
          date: "2026-01-01",
          strength: 9,
        },
        { axis: "bogus", claim: "soft shift" },
        { axis: "economic", claim: "   " }, // empty claim → dropped
        "not-an-object",
      ],
    });
    expect(parsed.whyNow).toHaveLength(2);
    expect(parsed.whyNow[0]).toEqual({
      axis: "regulatory",
      claim: "New rule X took effect",
      boundSignalId: "hn_123",
      date: "2026-01-01",
      strength: 1,
    });
    const second = parsed.whyNow[1];
    if (!second) throw new Error("expected a second whyNow shift");
    expect(second.axis).toBe("technological"); // bad axis → default
    expect(second.strength).toBe(0);
    expect(second.boundSignalId).toBeUndefined();
  });

  test("WHY_NOW_AXES are the four enabling-shift families", () => {
    expect([...WHY_NOW_AXES].sort()).toEqual(
      (
        ["behavioral", "economic", "regulatory", "technological"] as WhyNowAxis[]
      ).sort(),
    );
  });

  test("coerces per-axis evidence to strings, defaulting missing to empty", () => {
    const parsed = parseGiant({
      evidence: { acuteProblem: "  cluster of 40 complaints  ", demand: 7 },
    });
    expect(parsed.evidence.acuteProblem).toBe("cluster of 40 complaints");
    expect(parsed.evidence.demand).toBe(""); // non-string → empty
    expect(parsed.evidence.whyNow).toBe("");
  });

  test("never throws on garbage input", () => {
    expect(() => parseGiant(null)).not.toThrow();
    expect(() => parseGiant(undefined)).not.toThrow();
    expect(() => parseGiant(42)).not.toThrow();
    expect(() => parseGiant("string")).not.toThrow();
    expect(() => parseGiant([])).not.toThrow();
    const empty = parseGiant(null);
    expect(empty.scores.acuteProblem).toBe(0);
    expect(empty.archetype).toBe("hair-on-fire");
    expect(empty.whyNow).toEqual([]);
  });
});

// ── evaluateGiant (parse + aggregate) ─────────────────────────────────────────

describe("evaluateGiant", () => {
  test("produces a full evaluation from raw LLM output", () => {
    const evaluation = evaluateGiant(
      {
        scores: {
          acuteProblem: 5,
          whyNow: 4,
          demand: 5,
          nonObviousness: 4,
          defensibility: 4,
          marketShape: 3,
          founderFit: 4,
        },
        archetype: "hard-fact",
        whyNow: [{ axis: "technological", claim: "LLM costs dropped 10x", strength: 0.8 }],
        evidence: { acuteProblem: "40-complaint cluster" },
      },
      { hasDemandEvidence: true },
    );
    expect(evaluation.archetype).toBe("hard-fact");
    expect(evaluation.gated).toBe(false);
    expect(evaluation.composite).toBeGreaterThan(3.5);
    expect(evaluation.whyNow).toHaveLength(1);
    expect(evaluation.evidence.acuteProblem).toBe("40-complaint cluster");
  });

  test("a gated raw output surfaces gated + reasons (shadow mode)", () => {
    const evaluation = evaluateGiant(
      {
        scores: {
          acuteProblem: 1,
          whyNow: 5,
          demand: 5,
          nonObviousness: 5,
          defensibility: 5,
          marketShape: 5,
          founderFit: 5,
        },
        archetype: "hair-on-fire",
      },
      { hasDemandEvidence: true, enforceGates: false },
    );
    expect(evaluation.gated).toBe(true);
    expect(evaluation.gateReasons.some((r) => r.includes("acuteProblem"))).toBe(
      true,
    );
  });

  test("garbage input yields a safe, non-throwing evaluation", () => {
    const evaluation = evaluateGiant(null);
    expect(Number.isFinite(evaluation.composite)).toBe(true);
    expect(evaluation.archetype).toBe("hair-on-fire");
    // all-zero scores → both hard gates fire.
    expect(evaluation.gated).toBe(true);
  });
});
