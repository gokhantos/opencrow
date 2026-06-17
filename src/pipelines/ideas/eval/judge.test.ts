import { test, expect, describe } from "bun:test";
import {
  parseJudgeVerdicts,
  verdictToSubscores,
  giantScoresToLegacy,
} from "./judge";
import { parseCritiqueSubscores } from "./store";
import { GIANT_AXIS_KEYS } from "../giant";

// A full, well-formed GIANT score block (all axes above gate thresholds).
function fullScores(overrides: Partial<Record<string, number>> = {}) {
  return {
    acuteProblem: 4,
    whyNow: 4,
    demand: 4,
    nonObviousness: 3,
    defensibility: 3,
    marketShape: 3,
    founderFit: 3,
    ...overrides,
  };
}

// ── parseJudgeVerdicts (pure, GIANT) ────────────────────────────────────────────

describe("parseJudgeVerdicts (GIANT)", () => {
  test("emits the full 7-axis GIANT vector + archetype + composite", () => {
    const verdicts = parseJudgeVerdicts(
      {
        verdicts: [
          {
            id: "a",
            scores: fullScores(),
            archetype: "hard-fact",
            evidence: { acuteProblem: "complaint cluster" },
            rationale: "x",
          },
        ],
      },
      { hasDemandEvidence: true },
    );
    expect(verdicts).toHaveLength(1);
    const v = verdicts[0]!;
    expect(v.id).toBe("a");
    expect(v.archetype).toBe("hard-fact");
    for (const key of GIANT_AXIS_KEYS) {
      expect(typeof v.giantScores[key]).toBe("number");
    }
    expect(v.gated).toBe(false);
    expect(v.composite).toBeGreaterThan(0);
    expect(v.composite).toBeLessThanOrEqual(5);
    expect(v.rationale).toBe("x");
    expect(v.evidence.acuteProblem).toBe("complaint cluster");
  });

  test("hard gate fires when acuteProblem <= 1", () => {
    const v = parseJudgeVerdicts({
      verdicts: [{ id: "a", scores: fullScores({ acuteProblem: 1 }) }],
    })[0]!;
    expect(v.gated).toBe(true);
    expect(v.gateReasons.some((r) => r.startsWith("hard-gate:acuteProblem"))).toBe(
      true,
    );
  });

  test("demand evidence-gate caps demand and records a reason (not gated)", () => {
    // No hasDemandEvidence → demand 5 capped to 2 in aggregation.
    const v = parseJudgeVerdicts({
      verdicts: [{ id: "a", scores: fullScores({ demand: 5 }) }],
    })[0]!;
    expect(v.gated).toBe(false);
    expect(
      v.gateReasons.some((r) => r.startsWith("demand-evidence-gate:")),
    ).toBe(true);
    // raw asserted score preserved on the scorecard
    expect(v.giantScores.demand).toBe(5);
  });

  test("hasDemandEvidence:true suppresses the demand cap reason", () => {
    const v = parseJudgeVerdicts(
      { verdicts: [{ id: "a", scores: fullScores({ demand: 5 }) }] },
      { hasDemandEvidence: true },
    )[0]!;
    expect(
      v.gateReasons.some((r) => r.startsWith("demand-evidence-gate:")),
    ).toBe(false);
  });

  test("malformed / partial scores degrade to safe defaults (never throws)", () => {
    const v = parseJudgeVerdicts({ verdicts: [{ id: "a" }] })[0]!;
    // all axes default to 0 → hard gates fire
    for (const key of GIANT_AXIS_KEYS) expect(v.giantScores[key]).toBe(0);
    expect(v.gated).toBe(true);
    expect(v.archetype).toBe("hair-on-fire"); // default archetype
  });

  test("drops entries without a valid id", () => {
    const v = parseJudgeVerdicts({
      verdicts: [
        { scores: fullScores() },
        { id: "  ", scores: fullScores() },
        { id: "b", scores: fullScores() },
      ],
    });
    expect(v).toHaveLength(1);
    expect(v[0]!.id).toBe("b");
  });

  test("non-array verdicts → empty", () => {
    expect(parseJudgeVerdicts({ verdicts: "nope" })).toEqual([]);
    expect(parseJudgeVerdicts({})).toEqual([]);
  });

  test("clamps out-of-range axis scores into [0,5]", () => {
    const v = parseJudgeVerdicts({
      verdicts: [{ id: "a", scores: fullScores({ nonObviousness: 99, defensibility: -3 }) }],
    })[0]!;
    expect(v.giantScores.nonObviousness).toBe(5);
    expect(v.giantScores.defensibility).toBe(0);
  });

  test("parses dated why-now shifts", () => {
    const v = parseJudgeVerdicts({
      verdicts: [
        {
          id: "a",
          scores: fullScores(),
          whyNow: [
            { axis: "regulatory", claim: "new rule", date: "2025-03", strength: 0.8 },
            { axis: "garbage", claim: "" }, // dropped (empty claim)
          ],
        },
      ],
    })[0]!;
    expect(v.whyNow).toHaveLength(1);
    expect(v.whyNow[0]!.axis).toBe("regulatory");
    expect(v.whyNow[0]!.date).toBe("2025-03");
  });
});

// ── giantScoresToLegacy / verdictToSubscores ────────────────────────────────────

describe("giantScoresToLegacy", () => {
  test("projects GIANT axes onto [0,1] legacy sub-scores", () => {
    const legacy = giantScoresToLegacy(fullScores({ nonObviousness: 5, founderFit: 0, acuteProblem: 2.5 }));
    expect(legacy.novelty).toBe(1); // 5/5
    expect(legacy.feasibility).toBe(0); // 0/5
    expect(legacy.signalGrounding).toBe(0.5); // 2.5/5
  });
});

describe("verdictToSubscores", () => {
  test("maps verdict to critique subscores shape", () => {
    const v = parseJudgeVerdicts(
      { verdicts: [{ id: "a", scores: fullScores({ nonObviousness: 5, founderFit: 5, acuteProblem: 5 }) }] },
      { hasDemandEvidence: true },
    )[0]!;
    const sub = verdictToSubscores(v);
    expect(sub).toEqual({ novelty: 1, feasibility: 1, signalGrounding: 1 });
  });
});

// ── parseCritiqueSubscores (pure) ───────────────────────────────────────────────

describe("parseCritiqueSubscores", () => {
  test("null / undefined → null", () => {
    expect(parseCritiqueSubscores(null)).toBeNull();
    expect(parseCritiqueSubscores(undefined)).toBeNull();
  });

  test("parses JSON string", () => {
    expect(parseCritiqueSubscores('{"signalGrounding":0.7}')).toEqual({
      signalGrounding: 0.7,
    });
  });

  test("accepts already-parsed object (JSONB)", () => {
    expect(parseCritiqueSubscores({ novelty: 0.5, feasibility: 0.6 })).toEqual({
      novelty: 0.5,
      feasibility: 0.6,
    });
  });

  test("drops non-numeric fields", () => {
    expect(
      parseCritiqueSubscores({ novelty: 0.5, label: "x", bad: null }),
    ).toEqual({ novelty: 0.5 });
  });

  test("malformed JSON → null", () => {
    expect(parseCritiqueSubscores("{not json")).toBeNull();
  });

  test("empty object → null", () => {
    expect(parseCritiqueSubscores({})).toBeNull();
    expect(parseCritiqueSubscores("{}")).toBeNull();
  });

  test("'null' string and empty string → null", () => {
    expect(parseCritiqueSubscores("null")).toBeNull();
    expect(parseCritiqueSubscores("")).toBeNull();
  });

  test("array → null (not a subscores object)", () => {
    expect(parseCritiqueSubscores([1, 2])).toBeNull();
  });

  test("ignores non-finite numbers", () => {
    expect(parseCritiqueSubscores({ novelty: Number.NaN, feasibility: 0.5 })).toEqual({
      feasibility: 0.5,
    });
  });
});
