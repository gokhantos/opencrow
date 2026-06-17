/**
 * Offline ideas-pipeline eval harness.
 *
 * Reads generated_ideas + idea_feedback, emits run-level aggregates (mean
 * novelty/feasibility/groundedness from persisted critique sub-scores, %killed,
 * %human-validated, dedup precision/recall), optionally re-scores with an
 * LLM-as-judge, compares against a trailing baseline for regression alerts, and
 * persists an immutable snapshot to idea_eval_runs.
 *
 * NOT on the pipeline hot path. The LLM judge is OFF unless explicitly enabled.
 */

export {
  aggregateEval,
  aggregateMeanSubscores,
  aggregateOutcomeRates,
  aggregateDedupQuality,
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
  type CritiqueSubscores,
  type DedupLabel,
  type EvalAggregate,
  type MeanSubscores,
  type OutcomeRates,
  type DedupQuality,
  type GiantScoredIdea,
  type GiantRunAggregate,
  type DemandCoverage,
  type NoveltyItem,
  type NoveltyEmbedDep,
  type NoveltySearchDep,
  type EmbeddingNoveltyMetric,
  type SigeAbPair,
  type SigeAbReport,
  type DistributionSummary,
} from "./aggregate";

export {
  aggregateSignalRanker,
  type RankerEvalRow,
  type BucketPrecision,
  type SignalRankerReport,
} from "./signal-ranker";

export {
  detectRegressions,
  computeBaseline,
  extractMetrics,
  TRACKED_METRICS,
  type RegressionAlert,
  type RegressionOptions,
  type MetricDirection,
  type MetricSnapshot,
} from "./regression";

export {
  judgeIdeas,
  parseJudgeVerdicts,
  verdictToSubscores,
  giantScoresToLegacy,
  type JudgeIdeaInput,
  type JudgeVerdict,
  type JudgeOptions,
} from "./judge";

export {
  loadEvalIdeas,
  loadEvalOutcomes,
  loadSignalRankerRows,
  loadTrailingAggregates,
  persistEvalSnapshot,
  parseCritiqueSubscores,
  projectSignalRankerRows,
  type LoadIdeasOptions,
  type PersistEvalSnapshotParams,
} from "./store";

export {
  runEval,
  reJudgeStoredIdeas,
  runSigeAb,
  type RunEvalOptions,
  type RunEvalResult,
  type ReJudgeOptions,
  type ReJudgeResult,
  type GiantWeightOverrides,
  type RunSigeAbOptions,
  type RunSigeAbResult,
} from "./harness";
