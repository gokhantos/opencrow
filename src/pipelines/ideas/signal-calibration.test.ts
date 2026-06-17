import { test, expect, describe } from "bun:test";
import {
  IMPORTANCE_BUCKETS,
  NEUTRAL_WEIGHT,
  computeSignalCalibration,
  neutralSignalCalibration,
  calibratedRelevance,
  calibrationCategoryKey,
  projectSignalOutcomeRows,
  type LabeledSignalRow,
  type SignalCalibration,
} from "./signal-calibration";
import { PRIOR_ALPHA, PRIOR_BETA } from "./credibility";

// ── helpers ──────────────────────────────────────────────────────────────────

function rows(
  spec: ReadonlyArray<[LabeledSignalRow["importance"], boolean, string?]>,
): LabeledSignalRow[] {
  return spec.map(([importance, success, category]) => ({
    importance,
    success,
    ...(category ? { category } : {}),
  }));
}

// ── computeSignalCalibration: shape + neutrality ──────────────────────────────

describe("computeSignalCalibration", () => {
  test("every importance bucket is present even with no rows", () => {
    const cal = computeSignalCalibration([]);
    for (const bucket of IMPORTANCE_BUCKETS) {
      expect(cal.byImportance[bucket]).toBeCloseTo(NEUTRAL_WEIGHT, 10);
      expect(cal.importanceCells[bucket].successes).toBe(0);
      expect(cal.importanceCells[bucket].failures).toBe(0);
    }
    expect(cal.byCategory.size).toBe(0);
  });

  test("neutralSignalCalibration matches empty-input calibration", () => {
    const a = neutralSignalCalibration();
    const b = computeSignalCalibration([]);
    for (const bucket of IMPORTANCE_BUCKETS) {
      expect(a.byImportance[bucket]).toBe(b.byImportance[bucket]);
    }
  });

  test("posterior mean reuses Beta(prior) math: high all-success > prior", () => {
    const cal = computeSignalCalibration(
      rows([
        ["high", true],
        ["high", true],
        ["high", true],
      ]),
    );
    // alpha = 1 + 3 = 4, beta = 1 → mean 4/5 = 0.8
    const cell = cal.importanceCells.high;
    expect(cell.alpha).toBe(PRIOR_ALPHA + 3);
    expect(cell.beta).toBe(PRIOR_BETA);
    expect(cell.weight).toBeCloseTo(0.8, 10);
    expect(cal.byImportance.high).toBeCloseTo(0.8, 10);
  });

  test("a miscalibrated 'high' bucket (mostly failures) is down-weighted below neutral", () => {
    const cal = computeSignalCalibration(
      rows([
        ["high", false],
        ["high", false],
        ["high", false],
        ["high", true],
      ]),
    );
    // alpha = 1+1 = 2, beta = 1+3 = 4 → mean 2/6 ≈ 0.333
    expect(cal.byImportance.high).toBeCloseTo(1 / 3, 10);
    expect(cal.byImportance.high).toBeLessThan(NEUTRAL_WEIGHT);
  });

  test("a genuinely productive 'low' bucket can out-weigh a bad 'high'", () => {
    const cal = computeSignalCalibration(
      rows([
        ["low", true],
        ["low", true],
        ["low", true],
        ["low", true],
        ["high", false],
        ["high", false],
      ]),
    );
    expect(cal.byImportance.low).toBeGreaterThan(cal.byImportance.high);
  });

  test("is deterministic / pure: same input → identical output", () => {
    const input = rows([
      ["medium", true],
      ["medium", false],
      ["noise", false],
    ]);
    const a = computeSignalCalibration(input);
    const b = computeSignalCalibration(input);
    for (const bucket of IMPORTANCE_BUCKETS) {
      expect(a.byImportance[bucket]).toBe(b.byImportance[bucket]);
    }
  });

  test("custom priors are honored", () => {
    // Strong prior toward failure: Beta(1, 9). One success → 2/11.
    const cal = computeSignalCalibration(rows([["high", true]]), 1, 9);
    expect(cal.byImportance.high).toBeCloseTo(2 / 11, 10);
  });

  test("throws on non-positive priors", () => {
    expect(() => computeSignalCalibration([], 0, 1)).toThrow();
    expect(() => computeSignalCalibration([], 1, 0)).toThrow();
    expect(() => computeSignalCalibration([], -1, 1)).toThrow();
  });

  test("skips malformed importance rows defensively", () => {
    const cal = computeSignalCalibration([
      { importance: "bogus" as never, success: true },
      { importance: "high", success: true },
    ]);
    expect(cal.importanceCells.high.successes).toBe(1);
  });
});

// ── per-category secondary grouping ───────────────────────────────────────────

describe("computeSignalCalibration per-category", () => {
  test("builds per-(importance,category) cells keyed by composite key", () => {
    const cal = computeSignalCalibration(
      rows([
        ["high", true, "fintech"],
        ["high", false, "fintech"],
        ["high", true, "devtools"],
      ]),
    );
    const fintech = cal.byCategory.get(calibrationCategoryKey("high", "fintech"));
    const devtools = cal.byCategory.get(calibrationCategoryKey("high", "devtools"));
    expect(fintech?.successes).toBe(1);
    expect(fintech?.failures).toBe(1);
    expect(devtools?.successes).toBe(1);
    expect(devtools?.failures).toBe(0);
  });

  test("rows without a category do not create category cells", () => {
    const cal = computeSignalCalibration(rows([["high", true]]));
    expect(cal.byCategory.size).toBe(0);
  });

  test("blank/whitespace category is ignored", () => {
    const cal = computeSignalCalibration([
      { importance: "high", success: true, category: "   " },
    ]);
    expect(cal.byCategory.size).toBe(0);
  });
});

// ── calibratedRelevance (apply helper) ────────────────────────────────────────

describe("calibratedRelevance", () => {
  const neutral = neutralSignalCalibration();

  test("neutral calibration leaves a 0.5-relevance signal unchanged", () => {
    expect(
      calibratedRelevance({ importance: "medium", relevanceToIdeas: 0.5 }, neutral),
    ).toBeCloseTo(0.5, 10);
  });

  test("neutral calibration keeps the LLM relevance as-is (gain = 1)", () => {
    expect(
      calibratedRelevance({ importance: "high", relevanceToIdeas: 0.8 }, neutral),
    ).toBeCloseTo(0.8, 10);
  });

  test("a down-weighted bucket pulls relevance DOWN", () => {
    const cal = computeSignalCalibration(
      rows([
        ["high", false],
        ["high", false],
        ["high", false],
      ]),
    );
    // alpha=1, beta=1+3=4 → weight high = 1/5 = 0.2 → gain 0.4 → 0.8 * 0.4 = 0.32
    const out = calibratedRelevance(
      { importance: "high", relevanceToIdeas: 0.8 },
      cal,
    );
    expect(out).toBeCloseTo(0.32, 10);
    expect(out).toBeLessThan(0.8);
  });

  test("a boosted bucket pulls relevance UP but stays bounded at 1", () => {
    const cal = computeSignalCalibration(
      rows([
        ["high", true],
        ["high", true],
        ["high", true],
        ["high", true],
        ["high", true],
      ]),
    );
    // weight high = 6/7 ≈ 0.857 → gain ≈ 1.714 → 0.9 * 1.714 = 1.54 → clamp 1
    const out = calibratedRelevance(
      { importance: "high", relevanceToIdeas: 0.9 },
      cal,
    );
    expect(out).toBe(1);
  });

  test("result is always within [0,1]", () => {
    const cal = computeSignalCalibration(rows([["high", true], ["high", true]]));
    for (const r of [-1, 0, 0.3, 0.7, 1, 2, Number.NaN]) {
      const out = calibratedRelevance(
        { importance: "high", relevanceToIdeas: r },
        cal,
      );
      expect(out).toBeGreaterThanOrEqual(0);
      expect(out).toBeLessThanOrEqual(1);
    }
  });

  test("falls back to raw relevance when bucket weight is missing", () => {
    const broken = {
      byImportance: {} as SignalCalibration["byImportance"],
      importanceCells: neutral.importanceCells,
      byCategory: neutral.byCategory,
    };
    expect(
      calibratedRelevance({ importance: "high", relevanceToIdeas: 0.42 }, broken),
    ).toBeCloseTo(0.42, 10);
  });
});

// ── projectSignalOutcomeRows (pure DB-row projection) ─────────────────────────

describe("projectSignalOutcomeRows", () => {
  test("maps validated/built to success, archived/dismissed to failure", () => {
    const out = projectSignalOutcomeRows([
      { importance: "high", category: "fintech", kind: "validated" },
      { importance: "high", category: "fintech", kind: "built" },
      { importance: "low", category: null, kind: "archived" },
      { importance: "low", category: null, kind: "dismissed" },
    ]);
    expect(out.map((r) => r.success)).toEqual([true, true, false, false]);
  });

  test("drops non-terminal kinds and unknown buckets", () => {
    const out = projectSignalOutcomeRows([
      { importance: "high", category: null, kind: "idea" },
      { importance: "high", category: null, kind: null },
      { importance: "bogus", category: null, kind: "validated" },
      { importance: "medium", category: null, kind: "validated" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.importance).toBe("medium");
  });

  test("normalizes blank categories to undefined", () => {
    const out = projectSignalOutcomeRows([
      { importance: "high", category: "  ", kind: "validated" },
      { importance: "high", category: "devtools", kind: "validated" },
    ]);
    expect(out[0]?.category).toBeUndefined();
    expect(out[1]?.category).toBe("devtools");
  });
});
