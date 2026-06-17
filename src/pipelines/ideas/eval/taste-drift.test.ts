import { test, expect, describe } from "bun:test";
import {
  computeJudgeOutcomeKappa,
  computeJudgeOutcomeRankCorrelation,
  computeTasteLoopCoverage,
  computeTasteLoopDrift,
  pearson,
  tiedRanks,
  DEFAULT_JUDGE_ACCEPT_THRESHOLD,
  type JudgeOutcomeRow,
} from "./aggregate";
import { extractMetrics, type EvalAggregate } from "./regression";

// ── Fixtures ───────────────────────────────────────────────────────────────────

function row(
  id: string,
  giantComposite: number | null,
  outcome: JudgeOutcomeRow["outcome"],
  source: JudgeOutcomeRow["source"] = "proxy",
): JudgeOutcomeRow {
  return { id, giantComposite, outcome, source };
}

// ── tiedRanks ───────────────────────────────────────────────────────────────────

describe("tiedRanks", () => {
  test("assigns 1-based ranks to distinct ascending values", () => {
    expect(tiedRanks([10, 30, 20])).toEqual([1, 3, 2]);
  });

  test("averages ranks of tied values", () => {
    // values: 5,5,9 → the two 5s share ranks 1 and 2 → 1.5 each; 9 → 3.
    expect(tiedRanks([5, 5, 9])).toEqual([1.5, 1.5, 3]);
  });

  test("all-equal values collapse to the mean rank", () => {
    expect(tiedRanks([7, 7, 7, 7])).toEqual([2.5, 2.5, 2.5, 2.5]);
  });

  test("empty input yields empty ranks", () => {
    expect(tiedRanks([])).toEqual([]);
  });
});

// ── pearson ─────────────────────────────────────────────────────────────────────

describe("pearson", () => {
  test("perfect positive correlation is 1", () => {
    expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 10);
  });

  test("perfect negative correlation is -1", () => {
    expect(pearson([1, 2, 3], [6, 4, 2])).toBeCloseTo(-1, 10);
  });

  test("no variance on one side returns null", () => {
    expect(pearson([1, 1, 1], [2, 4, 6])).toBeNull();
  });

  test("fewer than two points returns null", () => {
    expect(pearson([1], [2])).toBeNull();
  });
});

// ── computeJudgeOutcomeKappa ─────────────────────────────────────────────────────

describe("computeJudgeOutcomeKappa", () => {
  test("empty input yields null kappa and zeroed cells", () => {
    const k = computeJudgeOutcomeKappa([]);
    expect(k.kappa).toBeNull();
    expect(k.observedAgreement).toBeNull();
    expect(k.expectedAgreement).toBeNull();
    expect(k.labeled).toBe(0);
  });

  test("perfect agreement: high-composite validated, low-composite archived → kappa 1", () => {
    const rows = [
      row("a", 4.5, "validated"),
      row("b", 4.2, "validated"),
      row("c", 1.0, "archived"),
      row("d", 1.5, "archived"),
    ];
    const k = computeJudgeOutcomeKappa(rows);
    expect(k.kappa).toBe(1);
    expect(k.observedAgreement).toBe(1);
    expect(k.acceptValidated).toBe(2);
    expect(k.rejectArchived).toBe(2);
    expect(k.acceptArchived).toBe(0);
    expect(k.rejectValidated).toBe(0);
    expect(k.labeled).toBe(4);
  });

  test("perfect DISagreement gives negative kappa", () => {
    // Judge accepts the ones that get archived, rejects the ones validated.
    const rows = [
      row("a", 4.5, "archived"),
      row("b", 4.2, "archived"),
      row("c", 1.0, "validated"),
      row("d", 1.5, "validated"),
    ];
    const k = computeJudgeOutcomeKappa(rows);
    expect(k.kappa).toBe(-1);
    expect(k.observedAgreement).toBe(0);
  });

  test("rows without an outcome OR without a composite are excluded", () => {
    const rows = [
      row("a", 4.5, "validated"),
      row("b", null, "validated"), // no composite
      row("c", 4.0, null), // no outcome
      row("d", 1.0, "archived"),
    ];
    const k = computeJudgeOutcomeKappa(rows);
    expect(k.labeled).toBe(2);
    expect(k.kappa).toBe(1);
  });

  test("degenerate margin (every row accept+validated) yields null kappa, Po=1", () => {
    const rows = [
      row("a", 4.5, "validated"),
      row("b", 4.2, "validated"),
    ];
    const k = computeJudgeOutcomeKappa(rows);
    expect(k.observedAgreement).toBe(1);
    expect(k.expectedAgreement).toBe(1); // Pe = 1 → kappa undefined
    expect(k.kappa).toBeNull();
  });

  test("respects a custom accept threshold", () => {
    const rows = [row("a", 3.0, "validated"), row("b", 3.0, "archived")];
    // Default threshold 3.2 → both REJECT. With threshold 2.5 → both ACCEPT.
    const def = computeJudgeOutcomeKappa(rows);
    expect(def.rejectValidated).toBe(1);
    expect(def.rejectArchived).toBe(1);
    const low = computeJudgeOutcomeKappa(rows, { acceptThreshold: 2.5 });
    expect(low.acceptValidated).toBe(1);
    expect(low.acceptArchived).toBe(1);
  });

  test("composite exactly at threshold counts as accept", () => {
    const k = computeJudgeOutcomeKappa([
      row("a", DEFAULT_JUDGE_ACCEPT_THRESHOLD, "validated"),
    ]);
    expect(k.acceptValidated).toBe(1);
  });
});

// ── computeJudgeOutcomeRankCorrelation ───────────────────────────────────────────

describe("computeJudgeOutcomeRankCorrelation", () => {
  test("fewer than two labeled rows returns null", () => {
    const r = computeJudgeOutcomeRankCorrelation([row("a", 4, "validated")]);
    expect(r.spearman).toBeNull();
    expect(r.labeled).toBe(1);
  });

  test("monotone (two-level tied outcome): higher composites validate → strongly positive spearman", () => {
    const rows = [
      row("a", 4.8, "validated"),
      row("b", 4.0, "validated"),
      row("c", 2.0, "archived"),
      row("d", 1.0, "archived"),
    ];
    const r = computeJudgeOutcomeRankCorrelation(rows);
    // With a two-level tied outcome, even a perfectly separating composite caps
    // below 1 because the outcome ranks tie. Strongly positive is the signal.
    expect(r.spearman).toBeCloseTo(0.8944, 3);
    expect(r.labeled).toBe(4);
  });

  test("perfectly monotone with distinct outcome ranks gives exactly 1", () => {
    // Use distinct composites that already order the same as a strictly
    // increasing outcome encoding to confirm the underlying math hits 1.
    expect(pearson(tiedRanks([1, 2, 3, 4]), tiedRanks([1, 2, 3, 4]))).toBe(1);
  });

  test("anti-monotone (two-level tied outcome) is strongly negative", () => {
    const rows = [
      row("a", 4.8, "archived"),
      row("b", 4.0, "archived"),
      row("c", 2.0, "validated"),
      row("d", 1.0, "validated"),
    ];
    const r = computeJudgeOutcomeRankCorrelation(rows);
    expect(r.spearman).toBeCloseTo(-0.8944, 3);
  });

  test("all-same outcome (no outcome variance) returns null", () => {
    const rows = [
      row("a", 4.8, "validated"),
      row("b", 2.0, "validated"),
    ];
    expect(computeJudgeOutcomeRankCorrelation(rows).spearman).toBeNull();
  });

  test("rows lacking composite/outcome are excluded from the count", () => {
    const rows = [
      row("a", 4.8, "validated"),
      row("b", null, "archived"),
      row("c", 1.0, "archived"),
    ];
    const r = computeJudgeOutcomeRankCorrelation(rows);
    expect(r.labeled).toBe(2);
  });
});

// ── computeTasteLoopCoverage ─────────────────────────────────────────────────────

describe("computeTasteLoopCoverage", () => {
  test("counts human vs proxy labels distinctly and computes labeledFraction", () => {
    const rows = [
      row("a", 4, "validated", "human"),
      row("b", 3, "archived", "proxy"),
      row("c", 2, null, "proxy"), // unlabeled
      row("d", 1, "archived", "proxy"),
    ];
    const cov = computeTasteLoopCoverage(rows, {
      goldenExemplars: 3,
      antiExemplars: 2,
    });
    expect(cov.humanLabelCount).toBe(1);
    expect(cov.proxyLabelCount).toBe(2);
    expect(cov.labeledCount).toBe(3);
    expect(cov.totalIdeas).toBe(4);
    expect(cov.labeledFraction).toBe(0.75);
    expect(cov.goldenExemplars).toBe(3);
    expect(cov.antiExemplars).toBe(2);
  });

  test("human label takes precedence over a proxy label on the SAME idea", () => {
    const rows = [
      row("a", 4, "validated", "proxy"),
      row("a", 4, "validated", "human"),
    ];
    const cov = computeTasteLoopCoverage(rows, {
      goldenExemplars: 0,
      antiExemplars: 0,
    });
    expect(cov.humanLabelCount).toBe(1);
    expect(cov.proxyLabelCount).toBe(0);
    // distinct labeled idea = 1, but totalIdeas counts both rows (raw pool).
    expect(cov.labeledCount).toBe(1);
  });

  test("empty input yields zeroed coverage (no divide-by-zero)", () => {
    const cov = computeTasteLoopCoverage([], {
      goldenExemplars: 0,
      antiExemplars: 0,
    });
    expect(cov.labeledFraction).toBe(0);
    expect(cov.totalIdeas).toBe(0);
  });

  test("negative/fractional exemplar counts are clamped to a non-negative int", () => {
    const cov = computeTasteLoopCoverage([], {
      goldenExemplars: -3,
      antiExemplars: 2.9,
    });
    expect(cov.goldenExemplars).toBe(0);
    expect(cov.antiExemplars).toBe(2);
  });
});

// ── computeTasteLoopDrift (integration of the three) ─────────────────────────────

describe("computeTasteLoopDrift", () => {
  test("assembles kappa + rank correlation + coverage", () => {
    const rows = [
      row("a", 4.5, "validated", "human"),
      row("b", 1.0, "archived", "proxy"),
    ];
    const drift = computeTasteLoopDrift(rows, {
      goldenExemplars: 4,
      antiExemplars: 4,
    });
    expect(drift.kappa.kappa).toBe(1);
    expect(drift.coverage.labeledCount).toBe(2);
    expect(drift.coverage.goldenExemplars).toBe(4);
    expect(drift.rankCorrelation.labeled).toBe(2);
  });

  test("empty input is fully null/zeroed and never throws", () => {
    const drift = computeTasteLoopDrift([]);
    expect(drift.kappa.kappa).toBeNull();
    expect(drift.rankCorrelation.spearman).toBeNull();
    expect(drift.coverage.labeledFraction).toBe(0);
    expect(drift.coverage.goldenExemplars).toBe(0);
  });
});

// ── regression metric wiring ─────────────────────────────────────────────────────

function aggregateWithTaste(
  kappa: number | null,
  spearman: number | null,
  labeledFraction: number | null,
): EvalAggregate {
  return {
    totalIdeas: 0,
    meanSubscores: {
      novelty: null,
      feasibility: null,
      signalGrounding: null,
      counts: { novelty: 0, feasibility: 0, signalGrounding: 0 },
    },
    outcomeRates: {
      killedRate: 0,
      humanValidatedRate: 0,
      validatedRate: 0,
      totalIdeas: 0,
      killedCount: 0,
      humanValidatedCount: 0,
      validatedCount: 0,
    },
    dedupQuality: null,
    signalRanker: null,
    tasteLoop:
      kappa === null && spearman === null && labeledFraction === null
        ? null
        : {
            kappa: {
              kappa,
              observedAgreement: null,
              expectedAgreement: null,
              acceptValidated: 0,
              acceptArchived: 0,
              rejectValidated: 0,
              rejectArchived: 0,
              labeled: 0,
            },
            rankCorrelation: { spearman, labeled: 0 },
            coverage: {
              goldenExemplars: 0,
              antiExemplars: 0,
              humanLabelCount: 0,
              proxyLabelCount: 0,
              labeledCount: 0,
              labeledFraction: labeledFraction ?? 0,
              totalIdeas: 0,
            },
          },
  };
}

describe("taste-loop regression metrics", () => {
  test("judgeOutcomeKappa / judgeOutcomeSpearman / tasteLoopLabeledFraction are tracked", () => {
    const metrics = extractMetrics(aggregateWithTaste(0.72, 0.81, 0.5));
    const byKey = new Map(metrics.map((m) => [m.key, m]));

    expect(byKey.get("judgeOutcomeKappa")?.value).toBe(0.72);
    expect(byKey.get("judgeOutcomeKappa")?.direction).toBe("higher_is_better");
    expect(byKey.get("judgeOutcomeSpearman")?.value).toBe(0.81);
    expect(byKey.get("tasteLoopLabeledFraction")?.value).toBe(0.5);
  });

  test("metrics are null when the taste-loop section is absent", () => {
    const metrics = extractMetrics(aggregateWithTaste(null, null, null));
    const byKey = new Map(metrics.map((m) => [m.key, m]));
    expect(byKey.get("judgeOutcomeKappa")?.value).toBeNull();
    expect(byKey.get("judgeOutcomeSpearman")?.value).toBeNull();
    expect(byKey.get("tasteLoopLabeledFraction")?.value).toBeNull();
  });
});
