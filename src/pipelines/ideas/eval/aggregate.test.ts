import { test, expect, describe } from "bun:test";
import {
  aggregateMeanSubscores,
  aggregateOutcomeRates,
  aggregateDedupQuality,
  aggregateEval,
  roundOrNull,
  type EvalIdeaRow,
  type EvalOutcomeRow,
  type DedupLabel,
} from "./aggregate";

// ── Fixtures ───────────────────────────────────────────────────────────────────

function idea(
  id: string,
  stage: string | null,
  sub: EvalIdeaRow["critique_subscores"],
): EvalIdeaRow {
  return {
    id,
    category: "mobile_app",
    pipeline_stage: stage,
    critique_subscores: sub,
    created_at: 1000,
  };
}

// ── roundOrNull ─────────────────────────────────────────────────────────────────

describe("roundOrNull", () => {
  test("keeps null", () => {
    expect(roundOrNull(null)).toBeNull();
  });
  test("rounds to 4 decimals by default", () => {
    expect(roundOrNull(1 / 3)).toBe(0.3333);
  });
  test("respects custom decimals", () => {
    expect(roundOrNull(0.126, 2)).toBe(0.13);
  });
});

// ── aggregateMeanSubscores ──────────────────────────────────────────────────────

describe("aggregateMeanSubscores", () => {
  test("empty → all null with zero counts", () => {
    const r = aggregateMeanSubscores([]);
    expect(r.novelty).toBeNull();
    expect(r.feasibility).toBeNull();
    expect(r.signalGrounding).toBeNull();
    expect(r.counts).toEqual({ novelty: 0, feasibility: 0, signalGrounding: 0 });
  });

  test("per-metric denominators are independent", () => {
    const ideas = [
      idea("a", "idea", { novelty: 0.8, signalGrounding: 0.6 }),
      idea("b", "idea", { novelty: 0.4 }), // no feasibility, no grounding
      idea("c", "idea", { feasibility: 0.9, signalGrounding: 0.4 }),
    ];
    const r = aggregateMeanSubscores(ideas);
    // novelty over {0.8, 0.4} = 0.6
    expect(r.novelty).toBe(0.6);
    expect(r.counts.novelty).toBe(2);
    // feasibility over {0.9} = 0.9
    expect(r.feasibility).toBe(0.9);
    expect(r.counts.feasibility).toBe(1);
    // grounding over {0.6, 0.4} = 0.5
    expect(r.signalGrounding).toBe(0.5);
    expect(r.counts.signalGrounding).toBe(2);
  });

  test("clamps out-of-range and ignores non-finite", () => {
    const ideas = [
      idea("a", "idea", { novelty: 1.5 }), // clamps to 1
      idea("b", "idea", { novelty: -0.2 }), // clamps to 0
      idea("c", "idea", { novelty: Number.NaN }), // ignored
    ];
    const r = aggregateMeanSubscores(ideas);
    expect(r.novelty).toBe(0.5); // mean of {1, 0}
    expect(r.counts.novelty).toBe(2);
  });

  test("ideas with null subscores are skipped", () => {
    const r = aggregateMeanSubscores([idea("a", "idea", null)]);
    expect(r.novelty).toBeNull();
    expect(r.counts.novelty).toBe(0);
  });
});

// ── aggregateOutcomeRates ───────────────────────────────────────────────────────

describe("aggregateOutcomeRates", () => {
  function outcome(
    ideaId: string,
    kind: string,
    actor: string | null,
  ): EvalOutcomeRow {
    return { idea_id: ideaId, kind, actor };
  }

  test("empty ideas → zeroed rates", () => {
    const r = aggregateOutcomeRates([], []);
    expect(r.killedRate).toBe(0);
    expect(r.humanValidatedRate).toBe(0);
    expect(r.validatedRate).toBe(0);
    expect(r.totalIdeas).toBe(0);
  });

  test("human vs pipeline validation distinguished by actor", () => {
    const ideas = [
      idea("a", "idea", null),
      idea("b", "idea", null),
      idea("c", "idea", null),
      idea("d", "idea", null),
    ];
    const outcomes = [
      outcome("a", "validated", "user-123"), // human
      outcome("b", "validated", "pipeline"), // automated
      outcome("c", "built", null), // null actor → not human
      outcome("d", "archived", "pipeline"), // killed
    ];
    const r = aggregateOutcomeRates(ideas, outcomes);
    // validated: a, b, c
    expect(r.validatedCount).toBe(3);
    expect(r.validatedRate).toBe(0.75);
    // human validated: only a
    expect(r.humanValidatedCount).toBe(1);
    expect(r.humanValidatedRate).toBe(0.25);
    // killed: d
    expect(r.killedCount).toBe(1);
    expect(r.killedRate).toBe(0.25);
  });

  test("falls back to pipeline_stage when no events", () => {
    const ideas = [
      idea("a", "validated", null),
      idea("b", "archived", null),
      idea("c", "idea", null),
    ];
    const r = aggregateOutcomeRates(ideas, []);
    expect(r.validatedCount).toBe(1);
    expect(r.killedCount).toBe(1);
    // stage fallback can't know human-ness → not human-validated
    expect(r.humanValidatedCount).toBe(0);
  });

  test("outcomes for unknown ideas are ignored", () => {
    const ideas = [idea("a", "idea", null)];
    const outcomes = [outcome("ghost", "validated", "user")];
    const r = aggregateOutcomeRates(ideas, outcomes);
    expect(r.validatedCount).toBe(0);
    expect(r.totalIdeas).toBe(1);
  });

  test("multiple events on one idea count it once per bucket", () => {
    const ideas = [idea("a", "idea", null)];
    const outcomes = [
      outcome("a", "validated", "user"),
      outcome("a", "validated", "user2"),
      outcome("a", "built", "user"),
    ];
    const r = aggregateOutcomeRates(ideas, outcomes);
    expect(r.validatedCount).toBe(1);
    expect(r.validatedRate).toBe(1);
  });
});

// ── aggregateDedupQuality ───────────────────────────────────────────────────────

describe("aggregateDedupQuality", () => {
  function label(
    id: string,
    predicted: boolean,
    actual: boolean,
  ): DedupLabel {
    return { idea_id: id, predicted_duplicate: predicted, actual_duplicate: actual };
  }

  test("empty set → null", () => {
    expect(aggregateDedupQuality([])).toBeNull();
  });

  test("classic confusion matrix", () => {
    const labels = [
      label("a", true, true), // TP
      label("b", true, true), // TP
      label("c", true, false), // FP
      label("d", false, true), // FN
      label("e", false, false), // TN
    ];
    const r = aggregateDedupQuality(labels)!;
    expect(r.truePositives).toBe(2);
    expect(r.falsePositives).toBe(1);
    expect(r.falseNegatives).toBe(1);
    expect(r.trueNegatives).toBe(1);
    // precision = 2/3
    expect(r.precision).toBe(0.6667);
    // recall = 2/3
    expect(r.recall).toBe(0.6667);
    // f1 = 2/3
    expect(r.f1).toBe(0.6667);
    expect(r.labeled).toBe(5);
  });

  test("no predicted duplicates → precision null", () => {
    const labels = [label("a", false, true), label("b", false, false)];
    const r = aggregateDedupQuality(labels)!;
    expect(r.precision).toBeNull();
    expect(r.recall).toBe(0); // 0 / (0 + 1)
    expect(r.f1).toBeNull();
  });

  test("no actual duplicates → recall null", () => {
    const labels = [label("a", true, false), label("b", false, false)];
    const r = aggregateDedupQuality(labels)!;
    expect(r.recall).toBeNull();
    expect(r.precision).toBe(0);
    expect(r.f1).toBeNull();
  });

  test("perfect dedup → all 1", () => {
    const labels = [label("a", true, true), label("b", false, false)];
    const r = aggregateDedupQuality(labels)!;
    expect(r.precision).toBe(1);
    expect(r.recall).toBe(1);
    expect(r.f1).toBe(1);
  });
});

// ── aggregateEval ───────────────────────────────────────────────────────────────

describe("aggregateEval", () => {
  test("combines all aggregates and omits dedup when no labels", () => {
    const ideas = [idea("a", "validated", { novelty: 0.7 })];
    const r = aggregateEval({ ideas, outcomes: [] });
    expect(r.totalIdeas).toBe(1);
    expect(r.meanSubscores.novelty).toBe(0.7);
    expect(r.dedupQuality).toBeNull();
    expect(r.outcomeRates.validatedCount).toBe(1);
  });

  test("includes dedup when labels supplied", () => {
    const r = aggregateEval({
      ideas: [],
      outcomes: [],
      dedupLabels: [{ idea_id: "a", predicted_duplicate: true, actual_duplicate: true }],
    });
    expect(r.dedupQuality).not.toBeNull();
    expect(r.dedupQuality!.precision).toBe(1);
  });
});
