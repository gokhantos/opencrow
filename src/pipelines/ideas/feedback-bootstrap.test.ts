import { test, expect, describe } from "bun:test";
import {
  DEFAULT_PROXY_OPTIONS,
  DEFAULT_GIANT_WEIGHT_OPTIONS,
  deriveProxyLabel,
  deriveProxyLabels,
  computeGiantWeightCalibration,
  neutralGiantWeightCalibration,
  parseGiantScores,
  projectGiantOutcomeRows,
  type ScoredIdeaForProxy,
  type GiantLabeledRow,
} from "./feedback-bootstrap";
import {
  GIANT_AXIS_KEYS,
  GIANT_AXES,
  GIANT_DEFAULT_WEIGHTS,
  type GiantAxisKey,
} from "./giant";

// ════════════════════════════════════════════════════════════════════════════
// PART A — proxy label rules
// ════════════════════════════════════════════════════════════════════════════

describe("deriveProxyLabel — human dominance", () => {
  const baseHighGiant: ScoredIdeaForProxy = {
    id: "i1",
    giantComposite: 4.5,
    grounded: true,
    distinctSegments: 3,
  };

  test("never emits a proxy when a terminal human label exists (even agreeing)", () => {
    // Would auto-validate, but a human already validated → suppress (redundant).
    const agree = deriveProxyLabel({ ...baseHighGiant, humanLabel: "validated" });
    expect(agree).toBeNull();
  });

  test("never emits a CONTRADICTING proxy over a human label", () => {
    // Idea would auto-ARCHIVE (very low giant) but a human VALIDATED it.
    const contradict = deriveProxyLabel({
      id: "i1",
      giantComposite: 0.5,
      humanLabel: "validated",
    });
    expect(contradict).toBeNull();
  });

  test.each(["archived", "dismissed", "built"] as const)(
    "suppresses proxy under any terminal human kind: %s",
    (kind) => {
      const r = deriveProxyLabel({ ...baseHighGiant, humanLabel: kind });
      expect(r).toBeNull();
    },
  );

  test("non-terminal human kinds (saved/rated/restored) do NOT block proxy", () => {
    const saved = deriveProxyLabel({ ...baseHighGiant, humanLabel: "saved" });
    expect(saved?.event.kind).toBe("validated");
  });
});

describe("deriveProxyLabel — auto-archive triggers", () => {
  test("convergence-veto auto-archives with proxy actor", () => {
    const r = deriveProxyLabel({ id: "v", convergenceVeto: true });
    expect(r?.event.kind).toBe("archived");
    expect(r?.reason).toBe("convergence-veto");
    expect(r?.event.actor).toBe("proxy:convergence-veto");
  });

  test("very low GIANT composite auto-archives", () => {
    const r = deriveProxyLabel({ id: "g", giantComposite: 1.0 });
    expect(r?.event.kind).toBe("archived");
    expect(r?.reason).toBe("very-low-giant");
    expect(r?.event.actor).toBe("proxy:very-low-giant");
  });

  test("composite exactly at threshold archives; just above does not", () => {
    const at = deriveProxyLabel({ id: "g", giantComposite: DEFAULT_PROXY_OPTIONS.veryLowGiant });
    expect(at?.reason).toBe("very-low-giant");
    const above = deriveProxyLabel({
      id: "g",
      giantComposite: DEFAULT_PROXY_OPTIONS.veryLowGiant + 0.01,
    });
    expect(above).toBeNull();
  });

  test("demand counter-evidence requires ALL THREE conditions", () => {
    const full: ScoredIdeaForProxy = {
      id: "d",
      giantComposite: 3.0, // above very-low, so not archived for that reason
      whitespace: 0.05,
      demandScore: 1.0,
      hasSupplySignal: true,
    };
    expect(deriveProxyLabel(full)?.reason).toBe("demand-counter");

    // Missing supply signal → not crowded-out, no archive.
    expect(deriveProxyLabel({ ...full, hasSupplySignal: false })).toBeNull();
    // Has whitespace headroom → not crowded.
    expect(deriveProxyLabel({ ...full, whitespace: 0.5 })).toBeNull();
    // Demand not low → real buyer-intent.
    expect(deriveProxyLabel({ ...full, demandScore: 4.0 })).toBeNull();
  });

  test("convergence-veto takes precedence over demand reason", () => {
    const r = deriveProxyLabel({
      id: "x",
      convergenceVeto: true,
      whitespace: 0,
      demandScore: 0,
      hasSupplySignal: true,
    });
    expect(r?.reason).toBe("convergence-veto");
  });
});

describe("deriveProxyLabel — weak auto-validate", () => {
  const good: ScoredIdeaForProxy = {
    id: "ok",
    giantComposite: 4.2,
    grounded: true,
    distinctSegments: 2,
  };

  test("emits validated only when high-GIANT AND grounded AND multi-segment", () => {
    const r = deriveProxyLabel(good);
    expect(r?.event.kind).toBe("validated");
    expect(r?.event.actor).toBe("proxy:high-giant");
  });

  test("requires grounded", () => {
    expect(deriveProxyLabel({ ...good, grounded: false })).toBeNull();
    expect(deriveProxyLabel({ ...good, grounded: null })).toBeNull();
  });

  test("requires multi-segment distinctness", () => {
    expect(deriveProxyLabel({ ...good, distinctSegments: 1 })).toBeNull();
  });

  test("requires high GIANT composite", () => {
    expect(
      deriveProxyLabel({ ...good, giantComposite: DEFAULT_PROXY_OPTIONS.highGiant - 0.01 }),
    ).toBeNull();
  });

  test("archive evidence wins over validate evidence", () => {
    // High GIANT + grounded + multi-segment but ALSO convergence-veto → archive.
    const r = deriveProxyLabel({ ...good, convergenceVeto: true });
    expect(r?.event.kind).toBe("archived");
  });
});

describe("deriveProxyLabel — defensive", () => {
  test("no id → null", () => {
    expect(deriveProxyLabel({ id: "" })).toBeNull();
  });

  test("a fully unscored idea earns no label", () => {
    expect(deriveProxyLabel({ id: "blank" })).toBeNull();
  });

  test("run_id is threaded onto the event when provided", () => {
    const r = deriveProxyLabel({ id: "r", giantComposite: 0.5 }, DEFAULT_PROXY_OPTIONS, "run-7");
    expect(r?.event.run_id).toBe("run-7");
  });
});

describe("deriveProxyLabels — batch", () => {
  test("returns only labeled ideas in input order", () => {
    const ideas: ScoredIdeaForProxy[] = [
      { id: "a", giantComposite: 0.5 }, // archive
      { id: "b", giantComposite: 3.0 }, // nothing
      { id: "c", giantComposite: 4.5, grounded: true, distinctSegments: 2 }, // validate
    ];
    const out = deriveProxyLabels(ideas);
    expect(out.map((l) => l.event.idea_id)).toEqual(["a", "c"]);
    expect(out[0]!.event.kind).toBe("archived");
    expect(out[1]!.event.kind).toBe("validated");
  });

  test("non-array input → empty", () => {
    expect(deriveProxyLabels(undefined as unknown as ScoredIdeaForProxy[])).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PART B — GIANT axis-weight calibration math
// ════════════════════════════════════════════════════════════════════════════

function allAxes(value: number): Record<GiantAxisKey, number> {
  return Object.fromEntries(GIANT_AXIS_KEYS.map((k) => [k, value])) as Record<
    GiantAxisKey,
    number
  >;
}

/** Build n labeled rows that score HIGH on `axis` with a given success rate. */
function highOnAxis(
  axis: GiantAxisKey,
  n: number,
  successRate: number,
  source: "human" | "proxy" = "human",
): GiantLabeledRow[] {
  return Array.from({ length: n }, (_, i) => ({
    scores: { ...allAxes(0), [axis]: 5 },
    success: i / n < successRate,
    source,
  }));
}

describe("neutral cold-start", () => {
  test("empty input → default weights, every nudge 1.0, marked neutral", () => {
    const cal = computeGiantWeightCalibration([]);
    expect(cal.neutral).toBe(true);
    for (const axis of GIANT_AXIS_KEYS) {
      expect(cal.weights[axis]).toBeCloseTo(GIANT_DEFAULT_WEIGHTS[axis], 10);
      expect(cal.cells[axis].nudge).toBeCloseTo(1, 10);
      expect(cal.cells[axis].mean).toBeCloseTo(0.5, 10);
    }
  });

  test("neutralGiantWeightCalibration matches under-powered compute", () => {
    const explicit = neutralGiantWeightCalibration();
    const computed = computeGiantWeightCalibration(
      highOnAxis("demand", 5, 1.0), // below minLabels (20)
    );
    expect(computed.neutral).toBe(true);
    for (const axis of GIANT_AXIS_KEYS) {
      expect(computed.weights[axis]).toBeCloseTo(explicit.weights[axis], 10);
    }
  });

  test("weights always sum to 1.0", () => {
    const cal = computeGiantWeightCalibration([
      ...highOnAxis("demand", 30, 0.9),
      ...highOnAxis("founderFit", 30, 0.1),
    ]);
    const sum = GIANT_AXIS_KEYS.reduce((acc, k) => acc + cal.weights[k], 0);
    expect(sum).toBeCloseTo(1.0, 10);
  });
});

describe("monotonic toward predictive axes", () => {
  test("an axis whose high scores predict validation nudges UP; a poor one DOWN", () => {
    const cal = computeGiantWeightCalibration([
      ...highOnAxis("demand", 40, 0.95), // strongly predictive
      ...highOnAxis("founderFit", 40, 0.05), // anti-predictive
    ]);
    expect(cal.neutral).toBe(false);
    expect(cal.cells.demand.mean).toBeGreaterThan(0.5);
    expect(cal.cells.demand.nudge).toBeGreaterThan(1);
    expect(cal.cells.founderFit.mean).toBeLessThan(0.5);
    expect(cal.cells.founderFit.nudge).toBeLessThan(1);
  });

  test("higher success rate ⇒ larger up-nudge (monotone)", () => {
    const mid = computeGiantWeightCalibration(highOnAxis("demand", 40, 0.6));
    const hi = computeGiantWeightCalibration(highOnAxis("demand", 40, 0.95));
    expect(hi.cells.demand.nudge).toBeGreaterThan(mid.cells.demand.nudge);
  });
});

describe("bounded nudges — never override the rubric spine", () => {
  test("non-spine nudge stays within ±maxNudge even at extremes", () => {
    const { maxNudge } = DEFAULT_GIANT_WEIGHT_OPTIONS;
    const up = computeGiantWeightCalibration(highOnAxis("demand", 200, 1.0));
    expect(up.cells.demand.nudge).toBeLessThanOrEqual(1 + maxNudge + 1e-9);
    const down = computeGiantWeightCalibration(highOnAxis("demand", 200, 0.0));
    expect(down.cells.demand.nudge).toBeGreaterThanOrEqual(1 - maxNudge - 1e-9);
  });

  test("SPINE axes (acuteProblem/whyNow) use the tighter cap", () => {
    const { maxSpineNudge } = DEFAULT_GIANT_WEIGHT_OPTIONS;
    const spineAxes = GIANT_AXIS_KEYS.filter((k) => GIANT_AXES[k].hardGate);
    expect(spineAxes).toContain("acuteProblem");
    expect(spineAxes).toContain("whyNow");

    for (const axis of spineAxes) {
      const up = computeGiantWeightCalibration(highOnAxis(axis, 200, 1.0));
      expect(up.cells[axis].nudge).toBeLessThanOrEqual(1 + maxSpineNudge + 1e-9);
      const down = computeGiantWeightCalibration(highOnAxis(axis, 200, 0.0));
      expect(down.cells[axis].nudge).toBeGreaterThanOrEqual(1 - maxSpineNudge - 1e-9);
    }
  });

  test("spine stays dominant: acuteProblem/whyNow remain the top two weights", () => {
    // Try to crush the spine and inflate a tail axis.
    const cal = computeGiantWeightCalibration([
      ...highOnAxis("acuteProblem", 100, 0.0),
      ...highOnAxis("whyNow", 100, 0.0),
      ...highOnAxis("founderFit", 100, 1.0),
    ]);
    // acuteProblem (0.22) and whyNow (0.18) start far above founderFit (0.07);
    // the bounded nudge can never reorder them past the tail.
    expect(cal.weights.acuteProblem).toBeGreaterThan(cal.weights.founderFit);
    expect(cal.weights.whyNow).toBeGreaterThan(cal.weights.founderFit);
    expect(cal.weights.acuteProblem).toBeGreaterThan(0);
    expect(cal.weights.whyNow).toBeGreaterThan(0);
  });
});

describe("provenance weighting — human labels dominate proxy", () => {
  test("proxy labels are down-weighted (slower to move the posterior)", () => {
    const humanCal = computeGiantWeightCalibration(highOnAxis("demand", 40, 1.0, "human"));
    const proxyCal = computeGiantWeightCalibration(highOnAxis("demand", 40, 1.0, "proxy"));
    // Same count + same success rate, but proxy carries 0.25 weight each, so the
    // human posterior is pushed further from neutral.
    expect(humanCal.cells.demand.mean).toBeGreaterThan(proxyCal.cells.demand.mean);
  });

  test("a pile of proxy labels stays under-powered when human-equivalent count is low", () => {
    // 40 proxy * 0.25 = 10 effective < minLabels (20) → neutral.
    const cal = computeGiantWeightCalibration(highOnAxis("demand", 40, 1.0, "proxy"));
    expect(cal.neutral).toBe(true);
    expect(cal.effectiveLabelCount).toBeCloseTo(10, 6);
  });

  test("invalid rows are skipped defensively", () => {
    const rows = [
      { scores: { demand: 5 }, success: true, source: "human" } as GiantLabeledRow,
      { scores: {}, success: "nope" as unknown as boolean, source: "human" } as GiantLabeledRow,
    ];
    const cal = computeGiantWeightCalibration(rows);
    expect(cal.effectiveLabelCount).toBe(1);
  });

  test("rejects non-positive priors", () => {
    expect(() =>
      computeGiantWeightCalibration([], { ...DEFAULT_GIANT_WEIGHT_OPTIONS, priorAlpha: 0 }),
    ).toThrow();
  });
});

// ── pure projection helpers ───────────────────────────────────────────────────

describe("parseGiantScores", () => {
  test("parses a JSON string of axis scores", () => {
    const blob = JSON.stringify({ acuteProblem: 4, whyNow: 3, demand: 5 });
    const scores = parseGiantScores(blob);
    expect(scores.acuteProblem).toBe(4);
    expect(scores.demand).toBe(5);
  });

  test("parses an already-parsed object", () => {
    expect(parseGiantScores({ demand: 2.5 }).demand).toBe(2.5);
  });

  test("unwraps a nested { scores: {...} } envelope (GiantEvaluation shape)", () => {
    expect(parseGiantScores({ scores: { whyNow: 5 } }).whyNow).toBe(5);
  });

  test("clamps to [0,5] and drops non-finite / unknown axes", () => {
    const scores = parseGiantScores({ demand: 9, acuteProblem: -1, bogus: 3, whyNow: NaN });
    expect(scores.demand).toBe(5);
    expect(scores.acuteProblem).toBe(0);
    expect(scores.whyNow).toBeUndefined();
    expect((scores as Record<string, unknown>).bogus).toBeUndefined();
  });

  test("malformed JSON / non-object → empty", () => {
    expect(parseGiantScores("{not json")).toEqual({});
    expect(parseGiantScores(null)).toEqual({});
    expect(parseGiantScores(42)).toEqual({});
  });
});

describe("projectGiantOutcomeRows", () => {
  test("maps terminal kinds to success/failure and tags label source", () => {
    const rows = projectGiantOutcomeRows([
      { giant_scores_json: { demand: 5 }, kind: "validated", actor: "user:42" },
      { giant_scores_json: { demand: 5 }, kind: "archived", actor: "proxy:very-low-giant" },
      { giant_scores_json: { demand: 5 }, kind: "saved", actor: null }, // non-terminal → skipped
      { giant_scores_json: null, kind: "validated", actor: null }, // no scores → skipped
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ success: true, source: "human" });
    expect(rows[1]).toMatchObject({ success: false, source: "proxy" });
  });
});
