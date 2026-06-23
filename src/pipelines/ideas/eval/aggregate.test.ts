import { test, expect, describe } from "bun:test";
import {
  aggregateMeanSubscores,
  aggregateOutcomeRates,
  aggregateDedupQuality,
  aggregateEval,
  aggregateGiantRun,
  aggregateDemandCoverage,
  compareSigeAb,
  computeEmbeddingNovelty,
  cosineSimilarity,
  cosineDistance,
  meanPairwiseCosineDistance,
  roundOrNull,
  type EvalIdeaRow,
  type EvalOutcomeRow,
  type DedupLabel,
  type GiantScoredIdea,
  type SigeAbPair,
} from "./aggregate";
import { GIANT_AXIS_KEYS, type GiantAxisScores } from "../giant";
import type { DemandArtifact, DemandEvidence } from "../demand";

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

function evidence(
  kind: DemandEvidence["kind"],
  count: number,
): DemandEvidence {
  return { kind, query: "k", count };
}

/** Build a demand artifact with sensible defaults. */
function artifact(over: Partial<DemandArtifact> = {}): DemandArtifact {
  return {
    score: 0,
    confidence: 0,
    whitespace: 0,
    evidence: [],
    ...over,
  };
}

/** An idea row carrying a persisted demand artifact (migration 015 fields). */
function demandIdea(
  id: string,
  demand: DemandArtifact | null,
  over: Partial<EvalIdeaRow> = {},
): EvalIdeaRow {
  return {
    id,
    category: "mobile_app",
    pipeline_stage: "idea",
    critique_subscores: null,
    created_at: 1000,
    demand,
    ...over,
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

  test("giant + embeddingNovelty default to null when not supplied", () => {
    const r = aggregateEval({ ideas: [], outcomes: [] });
    expect(r.giant).toBeNull();
    expect(r.embeddingNovelty).toBeNull();
  });

  test("always carries a demand-coverage section (computed from ideas)", () => {
    const r = aggregateEval({
      ideas: [
        demandIdea("a", artifact({ score: 4, evidence: [evidence("reddit_intent", 5)] })),
      ],
      outcomes: [],
    });
    expect(r.demand).not.toBeNull();
    expect(r.demand!.totalIdeas).toBe(1);
    expect(r.demand!.demandCoverage).toBe(1);
    expect(r.demand!.evidencedCount).toBe(1);
  });
});

// ── aggregateDemandCoverage ─────────────────────────────────────────────────────

describe("aggregateDemandCoverage", () => {
  test("empty → zeroed coverage with null means", () => {
    const r = aggregateDemandCoverage([]);
    expect(r.demandCoverage).toBe(0);
    expect(r.meanDemandScore).toBeNull();
    expect(r.meanWhitespace).toBeNull();
    expect(r.meanConfidence).toBeNull();
    expect(r.evidencedCount).toBe(0);
    expect(r.evidenceGatedCount).toBe(0);
    expect(r.withArtifactCount).toBe(0);
    expect(r.missingArtifactCount).toBe(0);
    expect(r.totalIdeas).toBe(0);
  });

  test("cited artifact (score>cap, evidence>0) counts as evidenced", () => {
    const r = aggregateDemandCoverage([
      demandIdea(
        "a",
        artifact({ score: 4, confidence: 0.8, whitespace: 0.5, evidence: [evidence("funding_news", 3)] }),
      ),
    ]);
    expect(r.demandCoverage).toBe(1);
    expect(r.evidencedCount).toBe(1);
    expect(r.evidenceGatedCount).toBe(0);
    expect(r.meanDemandScore).toBe(4);
    expect(r.meanWhitespace).toBe(0.5);
    expect(r.meanConfidence).toBe(0.8);
  });

  test("absence-capped artifact (score<=cap) is evidence-gated, NOT evidenced", () => {
    // score 1 == ABSENCE_SCORE_CAP → hasCitedDemand false even with evidence rows.
    const r = aggregateDemandCoverage([
      demandIdea("a", artifact({ score: 1, evidence: [evidence("reddit_intent", 1)] })),
    ]);
    expect(r.demandCoverage).toBe(0);
    expect(r.evidencedCount).toBe(0);
    expect(r.evidenceGatedCount).toBe(1);
    expect(r.withArtifactCount).toBe(1);
  });

  test("artifact with no evidence rows is evidence-gated (absence)", () => {
    const r = aggregateDemandCoverage([
      demandIdea("a", artifact({ score: 0, confidence: 0.1, evidence: [] })),
    ]);
    expect(r.evidencedCount).toBe(0);
    expect(r.evidenceGatedCount).toBe(1);
    expect(r.demandCoverage).toBe(0);
  });

  test("ideas missing an artifact penalize coverage (denominator), not means", () => {
    const r = aggregateDemandCoverage([
      demandIdea("cited", artifact({ score: 4, whitespace: 0.6, evidence: [evidence("hiring", 4)] })),
      demandIdea("missing", null), // pre-feature / not enriched
    ]);
    // 1 evidenced of 2 total → coverage 0.5 (absence is NOT a free pass)
    expect(r.demandCoverage).toBe(0.5);
    expect(r.evidencedCount).toBe(1);
    expect(r.withArtifactCount).toBe(1);
    expect(r.missingArtifactCount).toBe(1);
    // mean taken only over the idea that carried an artifact
    expect(r.meanWhitespace).toBe(0.6);
    expect(r.totalIdeas).toBe(2);
  });

  test("prefers persisted scalar demand_score/whitespace over artifact values", () => {
    const r = aggregateDemandCoverage([
      demandIdea(
        "a",
        artifact({ score: 2, whitespace: 0.2, evidence: [evidence("reddit_intent", 9)] }),
        { demand_score: 5, whitespace: 0.9 },
      ),
    ]);
    expect(r.meanDemandScore).toBe(5); // scalar wins over artifact.score=2
    expect(r.meanWhitespace).toBe(0.9); // scalar wins over artifact.whitespace=0.2
  });

  test("falls back to artifact values when scalars absent/non-finite", () => {
    const r = aggregateDemandCoverage([
      demandIdea(
        "a",
        artifact({ score: 3, whitespace: 0.4, evidence: [evidence("reddit_intent", 6)] }),
        { demand_score: null, whitespace: Number.NaN },
      ),
    ]);
    expect(r.meanDemandScore).toBe(3);
    expect(r.meanWhitespace).toBe(0.4);
  });

  test("mixed batch: coverage = evidenced / total, gated split is exact", () => {
    const r = aggregateDemandCoverage([
      demandIdea("e1", artifact({ score: 4, evidence: [evidence("reddit_intent", 5)] })),
      demandIdea("e2", artifact({ score: 3, evidence: [evidence("funding_news", 2)] })),
      demandIdea("g1", artifact({ score: 1, evidence: [evidence("reddit_intent", 1)] })), // capped
      demandIdea("g2", artifact({ score: 0, evidence: [] })), // absence
      demandIdea("m1", null), // missing
    ]);
    expect(r.totalIdeas).toBe(5);
    expect(r.withArtifactCount).toBe(4);
    expect(r.missingArtifactCount).toBe(1);
    expect(r.evidencedCount).toBe(2);
    expect(r.evidenceGatedCount).toBe(2);
    expect(r.demandCoverage).toBe(0.4); // 2 / 5
  });
});

// ── GIANT run aggregate ─────────────────────────────────────────────────────────

function scores(overrides: Partial<GiantAxisScores> = {}): GiantAxisScores {
  return {
    acuteProblem: 4,
    whyNow: 4,
    demand: 4,
    monetization: 4,
    feasibility: 4,
    nonObviousness: 3,
    defensibility: 3,
    marketShape: 3,
    founderFit: 3,
    ...overrides,
  };
}

function giantIdea(
  id: string,
  s: GiantAxisScores,
  hasDemandEvidence = true,
): GiantScoredIdea {
  return { id, scores: s, hasDemandEvidence };
}

describe("aggregateGiantRun", () => {
  test("empty batch → null means, zeroed rate", () => {
    const r = aggregateGiantRun([]);
    for (const key of GIANT_AXIS_KEYS) expect(r.axisMeans[key]).toBeNull();
    expect(r.compositeMean).toBeNull();
    expect(r.gateKillRate).toBe(0);
    expect(r.gatedCount).toBe(0);
    expect(r.totalIdeas).toBe(0);
    expect(r.compositeDistribution.p50).toBeNull();
  });

  test("per-axis means average across the batch", () => {
    const r = aggregateGiantRun([
      giantIdea("a", scores({ acuteProblem: 2 })),
      giantIdea("b", scores({ acuteProblem: 4 })),
    ]);
    expect(r.axisMeans.acuteProblem).toBe(3); // (2+4)/2
    expect(r.axisMeans.demand).toBe(4); // both 4
    expect(r.totalIdeas).toBe(2);
  });

  test("gate-kill rate counts hard-gated ideas", () => {
    const r = aggregateGiantRun([
      giantIdea("a", scores()), // not gated
      giantIdea("b", scores({ acuteProblem: 1 })), // hard-gated
      giantIdea("c", scores({ whyNow: 0 })), // hard-gated
      giantIdea("d", scores()), // not gated
    ]);
    expect(r.gatedCount).toBe(2);
    expect(r.gateKillRate).toBe(0.5);
  });

  test("non-compensatory: a near-zero axis tanks the composite", () => {
    const strong = aggregateGiantRun([giantIdea("a", scores())]).compositeMean!;
    // founderFit ~0 should drag the geomean composite well below the strong one,
    // even though every other axis is unchanged.
    const tanked = aggregateGiantRun([
      giantIdea("b", scores({ founderFit: 0 })),
    ]).compositeMean!;
    expect(tanked).toBeLessThan(strong);
  });

  test("demand evidence cap counted when un-evidenced demand exceeds cap", () => {
    const r = aggregateGiantRun([
      giantIdea("a", scores({ demand: 5 }), false), // capped
      giantIdea("b", scores({ demand: 5 }), true), // evidenced → not capped
      giantIdea("c", scores({ demand: 1 }), false), // below cap → not flagged
    ]);
    expect(r.demandEvidenceCappedCount).toBe(1);
  });

  test("composite distribution percentiles are ordered", () => {
    const ideas = [1, 2, 3, 4, 5].map((n) =>
      giantIdea(`i${n}`, scores({ defensibility: n, marketShape: n })),
    );
    const r = aggregateGiantRun(ideas);
    expect(r.compositeDistribution.p10).not.toBeNull();
    expect(r.compositeDistribution.p90).not.toBeNull();
    expect(r.compositeDistribution.p10!).toBeLessThanOrEqual(
      r.compositeDistribution.p50!,
    );
    expect(r.compositeDistribution.p50!).toBeLessThanOrEqual(
      r.compositeDistribution.p90!,
    );
  });
});

// ── Embedding-novelty math (pure) ───────────────────────────────────────────────

describe("cosineSimilarity / cosineDistance", () => {
  test("identical vectors → similarity 1, distance 0", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
    expect(cosineDistance([1, 2, 3], [1, 2, 3])).toBeCloseTo(0, 6);
  });

  test("orthogonal vectors → similarity 0, distance 1", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
    expect(cosineDistance([1, 0], [0, 1])).toBeCloseTo(1, 6);
  });

  test("opposite vectors → similarity -1, distance 2", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 6);
    expect(cosineDistance([1, 0], [-1, 0])).toBeCloseTo(2, 6);
  });

  test("zero / empty vectors → similarity 0 (no NaN)", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

describe("meanPairwiseCosineDistance", () => {
  test("fewer than two vectors → null", () => {
    expect(meanPairwiseCosineDistance([])).toBeNull();
    expect(meanPairwiseCosineDistance([[1, 0]])).toBeNull();
  });

  test("identical batch → 0 distance", () => {
    expect(
      meanPairwiseCosineDistance([
        [1, 0],
        [1, 0],
        [1, 0],
      ]),
    ).toBeCloseTo(0, 6);
  });

  test("averages over all unordered pairs", () => {
    // pairs: (e1,e2)=1, (e1,e1)=0, (e2,e1)=1 → mean over 3 pairs = 2/3
    const r = meanPairwiseCosineDistance([
      [1, 0],
      [0, 1],
      [1, 0],
    ])!;
    expect(r).toBeCloseTo(2 / 3, 6);
  });
});

describe("computeEmbeddingNovelty", () => {
  test("no embed dep → zeroed metric", async () => {
    const r = await computeEmbeddingNovelty([{ id: "a", text: "x" }], {
      embed: null,
    });
    expect(r.meanPairwiseDistance).toBeNull();
    expect(r.meanCorpusDistance).toBeNull();
    expect(r.corpusUnavailable).toBe(true);
    expect(r.embeddedCount).toBe(0);
  });

  test("embed failure degrades gracefully (no throw)", async () => {
    const r = await computeEmbeddingNovelty([{ id: "a", text: "x" }], {
      embed: {
        embed: async () => {
          throw new Error("boom");
        },
      },
    });
    expect(r.embeddedCount).toBe(0);
    expect(r.corpusUnavailable).toBe(true);
  });

  test("computes pairwise distance from injected embeddings", async () => {
    const r = await computeEmbeddingNovelty(
      [
        { id: "a", text: "a" },
        { id: "b", text: "b" },
      ],
      {
        embed: {
          embed: async () => [
            [1, 0],
            [0, 1],
          ],
        },
      },
    );
    expect(r.embeddedCount).toBe(2);
    expect(r.meanPairwiseDistance).toBeCloseTo(1, 6); // orthogonal
    expect(r.corpusUnavailable).toBe(true); // no search dep
  });

  test("corpus distance = 1 - max similarity from injected search dep", async () => {
    const r = await computeEmbeddingNovelty(
      [
        { id: "a", text: "a" },
        { id: "b", text: "b" },
      ],
      {
        embed: {
          embed: async () => [
            [1, 0],
            [0, 1],
          ],
        },
        search: {
          // pretend every item has a near-identical corpus neighbour (sim 0.9)
          nearestCorpusScores: async () => [0.9, 0.4],
        },
      },
    );
    expect(r.corpusUnavailable).toBe(false);
    expect(r.corpusComparedCount).toBe(2);
    expect(r.meanCorpusDistance).toBeCloseTo(0.1, 6); // 1 - 0.9
  });

  test("empty corpus results → corpus unavailable", async () => {
    const r = await computeEmbeddingNovelty([{ id: "a", text: "a" }], {
      embed: { embed: async () => [[1, 0]] },
      search: { nearestCorpusScores: async () => [] },
    });
    expect(r.corpusUnavailable).toBe(true);
    expect(r.meanCorpusDistance).toBeNull();
  });
});

// ── compareSigeAb (SIGE-hardened vs self-critique A/B) ──────────────────────────

/** Build a full 9-axis GIANT vector; every axis defaults to `base`. */
function giant(
  base: number,
  over: Partial<GiantAxisScores> = {},
): GiantAxisScores {
  const scores = {} as GiantAxisScores;
  for (const key of GIANT_AXIS_KEYS) scores[key] = base;
  return { ...scores, ...over };
}

function pair(
  id: string,
  sige: GiantAxisScores,
  critique: GiantAxisScores,
  over: Partial<SigeAbPair> = {},
): SigeAbPair {
  return { id, sigeScores: sige, critiqueScores: critique, ...over };
}

describe("compareSigeAb", () => {
  test("empty input → null deltas, zeroed rates", () => {
    const r = compareSigeAb([]);
    expect(r.sigeLift).toBeNull();
    expect(r.groundednessDelta).toBeNull();
    expect(r.liftWithoutGroundednessRegression).toBe(false);
    expect(r.meanJuryAgreement).toBeNull();
    expect(r.dissentDistribution.mean).toBeNull();
    expect(r.dissentDistribution.count).toBe(0);
    expect(r.convergenceVetoRate).toBe(0);
    expect(r.totalRounds).toBe(0);
    expect(r.pairedCount).toBe(0);
    for (const key of GIANT_AXIS_KEYS) expect(r.axisDeltas[key]).toBeNull();
  });

  test("uniform +1 lift across every axis", () => {
    const pairs = [
      pair("a", giant(4), giant(3)),
      pair("b", giant(5), giant(4)),
    ];
    const r = compareSigeAb(pairs);
    for (const key of GIANT_AXIS_KEYS) expect(r.axisDeltas[key]).toBe(1);
    expect(r.sigeLift).toBe(1);
    expect(r.groundednessDelta).toBe(1);
    expect(r.liftWithoutGroundednessRegression).toBe(true);
    expect(r.pairedCount).toBe(2);
  });

  test("sigeLift is the mean of per-axis deltas, not a per-idea mean", () => {
    // One axis up by 7, the rest flat → lift = 7 / (number of axes).
    const sige = giant(3, { acuteProblem: 10 });
    const critique = giant(3, { acuteProblem: 3 });
    const r = compareSigeAb([pair("a", sige, critique)]);
    expect(r.axisDeltas.acuteProblem).toBe(7);
    expect(r.axisDeltas.whyNow).toBe(0);
    expect(r.sigeLift).toBeCloseTo(7 / GIANT_AXIS_KEYS.length, 3);
  });

  test("groundedness regression vetoes the gate even when lift is positive", () => {
    // Big lift on non-demand axes, but demand axis DROPS by 1.
    const sige = giant(5, { demand: 2 });
    const critique = giant(3, { demand: 3 });
    const r = compareSigeAb([pair("a", sige, critique)]);
    expect(r.sigeLift).toBeGreaterThan(0);
    expect(r.groundednessDelta).toBe(-1);
    expect(r.liftWithoutGroundednessRegression).toBe(false);
  });

  test("tiny groundedness dip within tolerance still passes", () => {
    const sige = giant(5, { demand: 3.96 });
    const critique = giant(3, { demand: 4 });
    const r = compareSigeAb([pair("a", sige, critique)], [], {
      groundednessTolerance: 0.05,
    });
    expect(r.groundednessDelta).toBeCloseTo(-0.04, 6);
    expect(r.liftWithoutGroundednessRegression).toBe(true);
  });

  test("zero lift does not count as a win", () => {
    const r = compareSigeAb([pair("a", giant(3), giant(3))]);
    expect(r.sigeLift).toBe(0);
    expect(r.liftWithoutGroundednessRegression).toBe(false);
  });

  test("non-finite axis scores are skipped per-axis without poisoning others", () => {
    const sige = giant(4, { whyNow: Number.NaN });
    const critique = giant(3, { whyNow: 3 });
    const r = compareSigeAb([pair("a", sige, critique)]);
    // whyNow had a NaN on the sige side → that axis has no contributing pair.
    expect(r.axisDeltas.whyNow).toBeNull();
    expect(r.axisDeltas.acuteProblem).toBe(1);
    // lift averages only the axes that had a finite delta.
    expect(r.sigeLift).toBe(1);
  });

  test("jury agreement + dissent distribution surfaced (not penalized)", () => {
    const pairs = [
      pair("a", giant(4), giant(3), { juryAgreement: 0.9, dissent: 0.5 }),
      pair("b", giant(4), giant(3), { juryAgreement: 0.7, dissent: 2.5 }),
      pair("c", giant(4), giant(3), { juryAgreement: 0.5, dissent: 4.5 }),
    ];
    const r = compareSigeAb(pairs);
    expect(r.meanJuryAgreement).toBeCloseTo(0.7, 6);
    expect(r.dissentDistribution.count).toBe(3);
    expect(r.dissentDistribution.mean).toBeCloseTo((0.5 + 2.5 + 4.5) / 3, 6);
    expect(r.dissentDistribution.p10).toBe(0.5);
    expect(r.dissentDistribution.p90).toBe(4.5);
    // dissent never lowers the lift — these are pure +1 lifts.
    expect(r.sigeLift).toBe(1);
  });

  test("ideas without jury signals are excluded from agreement/dissent means", () => {
    const pairs = [
      pair("a", giant(4), giant(3), { juryAgreement: 0.8, dissent: 1 }),
      pair("b", giant(4), giant(3)), // no jury fields
    ];
    const r = compareSigeAb(pairs);
    expect(r.meanJuryAgreement).toBe(0.8);
    expect(r.dissentDistribution.count).toBe(1);
    expect(r.pairedCount).toBe(2);
  });

  test("convergence-veto rate counts vetoed rounds over total", () => {
    const r = compareSigeAb(
      [pair("a", giant(4), giant(3))],
      [true, false, true, false],
    );
    expect(r.totalRounds).toBe(4);
    expect(r.vetoedRounds).toBe(2);
    expect(r.convergenceVetoRate).toBe(0.5);
  });

  test("no rounds → veto rate is 0 not NaN", () => {
    const r = compareSigeAb([pair("a", giant(4), giant(3))], []);
    expect(r.convergenceVetoRate).toBe(0);
    expect(Number.isNaN(r.convergenceVetoRate)).toBe(false);
  });
});
