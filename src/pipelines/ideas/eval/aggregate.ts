/**
 * Pure aggregation math for the offline ideas eval harness.
 *
 * This module is intentionally PURE and dependency-free (no DB, no network, no
 * clock) so the run-level aggregates can be unit-tested in the unit lane and
 * reused by callers that already hold the raw rows in memory.
 *
 * The aggregation concepts mirror the SIGE taste-filter stats (mean per-criterion
 * scores, pass/eliminate counts) but operate over PERSISTED critique sub-scores
 * (migration 010 `critique_subscores_json`) and the append-only idea_feedback
 * event log (migration 008) rather than over a live LLM verdict.
 */

import type { SignalRankerReport } from "./signal-ranker";
import {
  GIANT_AXIS_KEYS,
  aggregateGiant,
  type GiantAxisKey,
  type GiantAxisScores,
} from "../giant";
import { hasCitedDemand, type DemandArtifact } from "../demand";

// ── Input row shapes (subset of generated_ideas / idea_feedback) ───────────────

/**
 * A single generated idea as far as the eval harness cares about it. Only the
 * fields used for aggregation are required; callers can pass richer rows.
 */
export interface EvalIdeaRow {
  readonly id: string;
  readonly category: string;
  /** Latest projected pipeline_stage (e.g. 'idea' | 'validated' | 'archived'). */
  readonly pipeline_stage: string | null;
  /** Persisted critique sub-scores in [0,1] (migration 010). May be partial. */
  readonly critique_subscores: CritiqueSubscores | null;
  readonly created_at: number;
  /** Idea title — only needed by the optional LLM judge. */
  readonly title?: string;
  /** Idea summary — only needed by the optional LLM judge. */
  readonly summary?: string;
  /**
   * Persisted deterministic demand artifact (migration 015 `demand_json`), or
   * null when the idea predates demand-grounding / carried no signal. Optional +
   * null so pre-feature rows stay shape-compatible. The artifact's evidence[]
   * carries auditable reddit_posts/news_articles citations.
   */
  readonly demand?: DemandArtifact | null;
  /**
   * Persisted demand strength score 0..5 (migration 015 `demand_score`). When
   * absent, falls back to `demand.score`. Optional + null pre-feature.
   */
  readonly demand_score?: number | null;
  /**
   * Persisted whitespace 0..1 = demand intensity minus supply density (migration
   * 015 `whitespace`). When absent, falls back to `demand.whitespace`.
   */
  readonly whitespace?: number | null;
}

/**
 * Persisted per-idea critique sub-scores. Every field is optional because the
 * pipeline only stamps what it computed (today: signalGrounding). Missing
 * fields are simply excluded from the corresponding mean.
 */
export interface CritiqueSubscores {
  /** How novel / non-obvious the idea is, [0,1]. */
  readonly novelty?: number;
  /** How buildable / shippable the idea is, [0,1]. */
  readonly feasibility?: number;
  /** How well-grounded in real signals the idea is, [0,1]. */
  readonly signalGrounding?: number;
  /** Allow forward-compatible extra sub-scores without losing them. */
  readonly [key: string]: number | undefined;
}

/**
 * A terminal-outcome event for an idea. Maps onto idea_feedback rows but is kept
 * minimal so it can be constructed from either the event log or a projected
 * pipeline_stage.
 */
export interface EvalOutcomeRow {
  readonly idea_id: string;
  /** Feedback kind, e.g. 'validated' | 'archived' | 'built' | 'dismissed'. */
  readonly kind: string;
  /** Who produced the event ('pipeline' = automated, anything else = human). */
  readonly actor: string | null;
}

// ── Labeled dedup set (for precision / recall) ─────────────────────────────────

/**
 * A single labeled dedup decision: did the pipeline treat `idea_id` as a
 * duplicate, and was it ACTUALLY a duplicate per the human/gold label?
 */
export interface DedupLabel {
  readonly idea_id: string;
  /** What the dedup system decided. */
  readonly predicted_duplicate: boolean;
  /** Ground-truth label. */
  readonly actual_duplicate: boolean;
}

// ── Output aggregate shape ─────────────────────────────────────────────────────

export interface MeanSubscores {
  /** Mean novelty across ideas that carry a novelty sub-score, or null. */
  readonly novelty: number | null;
  readonly feasibility: number | null;
  readonly signalGrounding: number | null;
  /** Count of ideas contributing to each mean (denominators). */
  readonly counts: {
    readonly novelty: number;
    readonly feasibility: number;
    readonly signalGrounding: number;
  };
}

export interface OutcomeRates {
  /** Fraction of ideas that ended up killed (archived/dismissed), [0,1]. */
  readonly killedRate: number;
  /** Fraction of ideas validated by a HUMAN actor, [0,1]. */
  readonly humanValidatedRate: number;
  /** Fraction of ideas validated by anyone (human or pipeline), [0,1]. */
  readonly validatedRate: number;
  readonly totalIdeas: number;
  readonly killedCount: number;
  readonly humanValidatedCount: number;
  readonly validatedCount: number;
}

export interface DedupQuality {
  /** TP / (TP + FP), or null when nothing was predicted duplicate. */
  readonly precision: number | null;
  /** TP / (TP + FN), or null when there were no actual duplicates. */
  readonly recall: number | null;
  /** Harmonic mean of precision & recall, or null when either is null. */
  readonly f1: number | null;
  readonly truePositives: number;
  readonly falsePositives: number;
  readonly falseNegatives: number;
  readonly trueNegatives: number;
  readonly labeled: number;
}

/**
 * Run-level demand-grounding coverage. Proves the GIANT demand axis stopped
 * being a hallucination: it reports what FRACTION of ideas carry a CITED demand
 * artifact (deterministic, row-counted buyer-intent) versus none, the mean
 * deterministic demand score / whitespace, and the evidence-gated (capped) vs
 * evidenced split. A LOW `demandCoverage` means most ideas are still
 * demand-blind (their demand axis is evidence-capped <= 2, not earned).
 */
export interface DemandCoverage {
  /**
   * Fraction of ideas carrying a CITED demand artifact (>=1 real evidence row
   * AND score cleared the absence cap), [0,1]. This is the headline metric.
   */
  readonly demandCoverage: number;
  /** Mean deterministic demand score (0..5) over ideas with an artifact, or null. */
  readonly meanDemandScore: number | null;
  /** Mean whitespace (0..1) over ideas with an artifact, or null. */
  readonly meanWhitespace: number | null;
  /** Mean artifact confidence (0..1) over ideas with an artifact, or null. */
  readonly meanConfidence: number | null;
  /** Ideas whose demand axis is backed by cited evidence (gate opened). */
  readonly evidencedCount: number;
  /**
   * Ideas with a demand artifact present but NOT cited (absence-capped) — the
   * demand axis stays evidence-gated <= cap for these.
   */
  readonly evidenceGatedCount: number;
  /** Ideas that carried any demand artifact at all (evidenced + gated). */
  readonly withArtifactCount: number;
  /** Ideas with no demand artifact persisted (pre-feature / not yet enriched). */
  readonly missingArtifactCount: number;
  readonly totalIdeas: number;
}

export interface EvalAggregate {
  readonly meanSubscores: MeanSubscores;
  readonly outcomeRates: OutcomeRates;
  readonly dedupQuality: DedupQuality | null;
  /**
   * Run-level demand-grounding coverage (cited-artifact rate, mean demand
   * score/whitespace, evidence-gated vs evidenced split). Optional + null until
   * demand-grounding (migration 015) is populated, so existing snapshots stay
   * shape-compatible.
   */
  readonly demand?: DemandCoverage | null;
  /**
   * Ranker-precision section for the signal-ranking layer: per-bucket validation
   * rate, calibration gap, and ranker lift. null when no labeled signal rows
   * exist yet (ranking disabled / cold start / pre-migration). See
   * ./signal-ranker.
   */
  readonly signalRanker: SignalRankerReport | null;
  /**
   * Run-level GIANT aggregates (per-axis means, gate-kill rate, geometric-mean
   * composite distribution). Optional + null until GIANT scores are available
   * for the batch, so existing snapshots stay shape-compatible.
   */
  readonly giant?: GiantRunAggregate | null;
  /**
   * Objective embedding-novelty metric (mean intra-batch + corpus distance).
   * Optional + null when no embedding dep was supplied / memory unavailable.
   */
  readonly embeddingNovelty?: EmbeddingNoveltyMetric | null;
  /**
   * Hardened-SIGE vs self-critique A/B comparison over the SAME ideas (per-axis
   * GIANT deltas, groundedness delta, jury agreement / dissent distribution,
   * convergence-veto rate). This is the GATE for ever defaulting
   * `smart.sigeValuation` on. Optional + null on default (SIGE-off) runs, so
   * existing snapshots stay shape-compatible.
   */
  readonly sigeAb?: SigeAbReport | null;
  readonly totalIdeas: number;
}

// ── Constants ──────────────────────────────────────────────────────────────────

/** Feedback kinds that mean "the idea was killed". */
const KILLED_KINDS: ReadonlySet<string> = new Set(["archived", "dismissed"]);
/** Feedback kinds that mean "the idea was validated/accepted". */
const VALIDATED_KINDS: ReadonlySet<string> = new Set(["validated", "built"]);
/** Actor value the pipeline stamps on its own automated transitions. */
const PIPELINE_ACTOR = "pipeline";

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Clamp a finite number into [0,1]; returns null for non-finite input. */
function clamp01(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Mean of a non-empty list, or null when empty. */
function meanOrNull(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sum = values.reduce((acc, v) => acc + v, 0);
  return sum / values.length;
}

/** Round a nullable number to a fixed number of decimals (keeps null). */
export function roundOrNull(value: number | null, decimals = 4): number | null {
  if (value === null) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

// ── Mean critique sub-scores ───────────────────────────────────────────────────

/**
 * Compute the mean novelty / feasibility / signalGrounding across ideas that
 * carry each (clamped, finite) sub-score. Each mean has its own denominator so
 * a sparsely-stamped sub-score does not get diluted by ideas that lack it.
 */
export function aggregateMeanSubscores(
  ideas: readonly EvalIdeaRow[],
): MeanSubscores {
  const novelty: number[] = [];
  const feasibility: number[] = [];
  const signalGrounding: number[] = [];

  for (const idea of ideas) {
    const sub = idea.critique_subscores;
    if (!sub) continue;
    const n = clamp01(sub.novelty);
    if (n !== null) novelty.push(n);
    const f = clamp01(sub.feasibility);
    if (f !== null) feasibility.push(f);
    const g = clamp01(sub.signalGrounding);
    if (g !== null) signalGrounding.push(g);
  }

  return {
    novelty: roundOrNull(meanOrNull(novelty)),
    feasibility: roundOrNull(meanOrNull(feasibility)),
    signalGrounding: roundOrNull(meanOrNull(signalGrounding)),
    counts: {
      novelty: novelty.length,
      feasibility: feasibility.length,
      signalGrounding: signalGrounding.length,
    },
  };
}

// ── Outcome rates (%killed, %human-validated) ──────────────────────────────────

/**
 * Compute kill / validation rates over the idea set. An idea counts toward a
 * bucket if ANY of its outcome events falls in that bucket. Human validation
 * requires a validated/built event whose actor is NOT the pipeline.
 *
 * Outcomes are matched to ideas by id; outcomes for ideas absent from `ideas`
 * are ignored so the denominator is always the supplied idea population.
 */
export function aggregateOutcomeRates(
  ideas: readonly EvalIdeaRow[],
  outcomes: readonly EvalOutcomeRow[],
): OutcomeRates {
  const ideaIds = new Set(ideas.map((i) => i.id));

  const killedIds = new Set<string>();
  const validatedIds = new Set<string>();
  const humanValidatedIds = new Set<string>();

  for (const o of outcomes) {
    if (!ideaIds.has(o.idea_id)) continue;
    if (KILLED_KINDS.has(o.kind)) killedIds.add(o.idea_id);
    if (VALIDATED_KINDS.has(o.kind)) {
      validatedIds.add(o.idea_id);
      const isHuman = o.actor !== null && o.actor !== PIPELINE_ACTOR;
      if (isHuman) humanValidatedIds.add(o.idea_id);
    }
  }

  // Fall back to the projected pipeline_stage for ideas with no events, so the
  // harness still reports sensible rates before/without idea_feedback rows.
  for (const idea of ideas) {
    const stage = idea.pipeline_stage;
    if (!stage) continue;
    if (KILLED_KINDS.has(stage)) killedIds.add(idea.id);
    if (VALIDATED_KINDS.has(stage)) validatedIds.add(idea.id);
  }

  const total = ideas.length;
  const rate = (n: number): number => (total === 0 ? 0 : n / total);

  return {
    killedRate: roundOrNull(rate(killedIds.size)) ?? 0,
    humanValidatedRate: roundOrNull(rate(humanValidatedIds.size)) ?? 0,
    validatedRate: roundOrNull(rate(validatedIds.size)) ?? 0,
    totalIdeas: total,
    killedCount: killedIds.size,
    humanValidatedCount: humanValidatedIds.size,
    validatedCount: validatedIds.size,
  };
}

// ── Dedup precision / recall on a labeled set ──────────────────────────────────

/**
 * Compute dedup precision/recall/F1 on a labeled set of dedup decisions.
 * Returns null when the set is empty (nothing to score).
 *
 *   precision = TP / (TP + FP)  — of the things we called duplicate, how many were
 *   recall    = TP / (TP + FN)  — of the actual duplicates, how many we caught
 */
export function aggregateDedupQuality(
  labels: readonly DedupLabel[],
): DedupQuality | null {
  if (labels.length === 0) return null;

  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;

  for (const l of labels) {
    if (l.predicted_duplicate && l.actual_duplicate) tp += 1;
    else if (l.predicted_duplicate && !l.actual_duplicate) fp += 1;
    else if (!l.predicted_duplicate && l.actual_duplicate) fn += 1;
    else tn += 1;
  }

  const precision = tp + fp > 0 ? tp / (tp + fp) : null;
  const recall = tp + fn > 0 ? tp / (tp + fn) : null;
  const f1 =
    precision !== null && recall !== null && precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : null;

  return {
    precision: roundOrNull(precision),
    recall: roundOrNull(recall),
    f1: roundOrNull(f1),
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    trueNegatives: tn,
    labeled: labels.length,
  };
}

// ── Demand-grounding coverage ──────────────────────────────────────────────────

/**
 * Resolve the demand score for an idea: prefer the persisted scalar
 * `demand_score`, fall back to the artifact's score. Returns null when neither
 * is a finite number. PURE.
 */
function resolveDemandScore(idea: EvalIdeaRow): number | null {
  const scalar = idea.demand_score;
  if (typeof scalar === "number" && Number.isFinite(scalar)) return scalar;
  const fromArtifact = idea.demand?.score;
  if (typeof fromArtifact === "number" && Number.isFinite(fromArtifact)) {
    return fromArtifact;
  }
  return null;
}

/**
 * Resolve the whitespace for an idea: prefer the persisted scalar `whitespace`,
 * fall back to the artifact's whitespace. Returns null when neither is finite. PURE.
 */
function resolveWhitespace(idea: EvalIdeaRow): number | null {
  const scalar = idea.whitespace;
  if (typeof scalar === "number" && Number.isFinite(scalar)) return scalar;
  const fromArtifact = idea.demand?.whitespace;
  if (typeof fromArtifact === "number" && Number.isFinite(fromArtifact)) {
    return fromArtifact;
  }
  return null;
}

/**
 * Compute run-level demand-grounding coverage over the idea set.
 *
 * The headline `demandCoverage` is the fraction of ideas carrying a CITED demand
 * artifact (>=1 real evidence row AND score cleared the absence cap, per
 * {@link hasCitedDemand}). This is exactly the signal that lets the GIANT demand
 * axis score 3-5 instead of being evidence-capped <= 2, so a low coverage means
 * most ideas are still demand-blind.
 *
 * Means are taken over ideas that carry an artifact (so a sea of pre-feature
 * rows without demand_json does not dilute them toward zero). Ideas with no
 * artifact are counted in `missingArtifactCount` and excluded from the means but
 * INCLUDED in the `totalIdeas` denominator of `demandCoverage` — absence is not
 * a free pass. PURE; safe on empty input.
 */
export function aggregateDemandCoverage(
  ideas: readonly EvalIdeaRow[],
): DemandCoverage {
  const total = ideas.length;

  const demandScores: number[] = [];
  const whitespaces: number[] = [];
  const confidences: number[] = [];

  let evidencedCount = 0;
  let evidenceGatedCount = 0;
  let withArtifactCount = 0;

  for (const idea of ideas) {
    const artifact = idea.demand ?? null;
    if (!artifact) continue;

    withArtifactCount += 1;

    const score = resolveDemandScore(idea);
    if (score !== null) demandScores.push(score);
    const ws = resolveWhitespace(idea);
    if (ws !== null) whitespaces.push(ws);
    const conf = artifact.confidence;
    if (typeof conf === "number" && Number.isFinite(conf)) confidences.push(conf);

    if (hasCitedDemand(artifact)) evidencedCount += 1;
    else evidenceGatedCount += 1;
  }

  const missingArtifactCount = total - withArtifactCount;

  return {
    demandCoverage: total === 0 ? 0 : roundOrNull(evidencedCount / total) ?? 0,
    meanDemandScore: roundOrNull(meanOrNull(demandScores)),
    meanWhitespace: roundOrNull(meanOrNull(whitespaces)),
    meanConfidence: roundOrNull(meanOrNull(confidences)),
    evidencedCount,
    evidenceGatedCount,
    withArtifactCount,
    missingArtifactCount,
    totalIdeas: total,
  };
}

// ── Run-level GIANT aggregates ─────────────────────────────────────────────────

/**
 * One scored idea as far as the GIANT run-level aggregation cares: the full
 * 7-axis vector plus whether a cited demand artifact backed the demand axis.
 * `hasDemandEvidence` defaults to false at the call site (un-evidenced demand is
 * evidence-capped) — callers with a real artifact check pass true.
 */
export interface GiantScoredIdea {
  readonly id: string;
  readonly scores: GiantAxisScores;
  readonly hasDemandEvidence?: boolean;
}

/** Run-level GIANT aggregates over a batch of scored ideas. */
export interface GiantRunAggregate {
  /** Mean of each axis across the batch, or null per-axis when batch empty. */
  readonly axisMeans: Readonly<Record<GiantAxisKey, number | null>>;
  /** Mean non-compensatory composite across the batch, or null when empty. */
  readonly compositeMean: number | null;
  /** Composite distribution percentiles {p10,p50,p90}, or null when empty. */
  readonly compositeDistribution: {
    readonly p10: number | null;
    readonly p50: number | null;
    readonly p90: number | null;
  };
  /** Fraction of ideas a hard gate would kill, [0,1]. */
  readonly gateKillRate: number;
  /** Count of ideas a hard gate would kill. */
  readonly gatedCount: number;
  /** Count of ideas whose demand axis hit the evidence-gate cap. */
  readonly demandEvidenceCappedCount: number;
  readonly totalIdeas: number;
}

/** Nearest-rank percentile of a list (sorted ascending), or null when empty. */
function percentileOrNull(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[rank] ?? null;
}

/**
 * Aggregate run-level GIANT stats over a batch of scored ideas: per-axis means,
 * the geometric-mean composite distribution, and the hard-gate kill rate.
 *
 * PURE — re-runs the shared {@link aggregateGiant} per idea (so gate semantics
 * stay identical to scoring time) and rolls the results up. `weights` is
 * forwarded so the run uses the same configured weighting as scoring.
 */
export function aggregateGiantRun(
  ideas: readonly GiantScoredIdea[],
  opts?: { readonly weights?: Partial<Record<GiantAxisKey, number>> },
): GiantRunAggregate {
  const total = ideas.length;

  // Per-axis sums for means.
  const axisSums = {} as Record<GiantAxisKey, number>;
  for (const key of GIANT_AXIS_KEYS) axisSums[key] = 0;

  const composites: number[] = [];
  let gatedCount = 0;
  let demandCappedCount = 0;

  for (const idea of ideas) {
    for (const key of GIANT_AXIS_KEYS) {
      const v = idea.scores[key];
      axisSums[key] += Number.isFinite(v) ? v : 0;
    }
    const agg = aggregateGiant(idea.scores, {
      weights: opts?.weights,
      hasDemandEvidence: idea.hasDemandEvidence === true,
    });
    composites.push(agg.composite);
    if (agg.gated) gatedCount += 1;
    if (agg.gateReasons.some((r) => r.startsWith("demand-evidence-gate:"))) {
      demandCappedCount += 1;
    }
  }

  const axisMeans = {} as Record<GiantAxisKey, number | null>;
  for (const key of GIANT_AXIS_KEYS) {
    axisMeans[key] = total === 0 ? null : roundOrNull(axisSums[key] / total);
  }

  return {
    axisMeans,
    compositeMean: roundOrNull(meanOrNull(composites)),
    compositeDistribution: {
      p10: roundOrNull(percentileOrNull(composites, 10)),
      p50: roundOrNull(percentileOrNull(composites, 50)),
      p90: roundOrNull(percentileOrNull(composites, 90)),
    },
    gateKillRate: total === 0 ? 0 : roundOrNull(gatedCount / total) ?? 0,
    gatedCount,
    demandEvidenceCappedCount: demandCappedCount,
    totalIdeas: total,
  };
}

// ── SIGE-hardened vs self-critique A/B comparison ──────────────────────────────

/**
 * One idea scored TWICE on the SAME GIANT rubric: once by the hardened SIGE jury
 * (cross-family, anonymized, dissent-aware) and once by the synthesizer's own
 * self-critique. The pairing is by idea id so the comparison controls for the
 * idea itself — we are measuring the JUDGE, not the candidates.
 *
 * `juryAgreement` (0..1, conformity) and `dissent` (0..5, polarization) are the
 * jury-side signals carried through from {@link import("../jury").JuryVerdict}.
 * They are surfaced (distribution + mean) — never used to penalize a candidate
 * here — so the A/B can show whether lift comes WITH or WITHOUT consensus.
 */
export interface SigeAbPair {
  readonly id: string;
  /** Hardened-SIGE / jury GIANT 7-axis scores (0..5). */
  readonly sigeScores: GiantAxisScores;
  /** Synthesizer self-critique GIANT 7-axis scores (0..5). */
  readonly critiqueScores: GiantAxisScores;
  /** Inter-judge agreement for this idea, [0,1]. Optional (no jury → omit). */
  readonly juryAgreement?: number;
  /** Jury dissent magnitude for this idea, [0,5]. Optional. */
  readonly dissent?: number;
}

/** Distribution summary (mean + nearest-rank percentiles) of a scalar. */
export interface DistributionSummary {
  readonly mean: number | null;
  readonly p10: number | null;
  readonly p50: number | null;
  readonly p90: number | null;
  readonly count: number;
}

/**
 * Run-level comparison of hardened SIGE vs self-critique over the SAME ideas.
 *
 * This is the GATE that decides whether `smart.sigeValuation` should ever be
 * defaulted on: a real win is `sigeLift > 0` (GIANT axes go up) WITHOUT a
 * groundedness regression (`groundednessDelta >= -tolerance`). The demand axis is
 * the groundedness proxy — it is the only axis that is evidence-gated, so a SIGE
 * judge that inflates scores by hallucinating demand shows up as a NEGATIVE
 * groundedness delta even when the headline lift is positive.
 */
export interface SigeAbReport {
  /** Per-axis mean delta = mean(sige - critique) over paired ideas, or null. */
  readonly axisDeltas: Readonly<Record<GiantAxisKey, number | null>>;
  /**
   * Headline lift: the mean of the per-axis deltas (overall GIANT movement).
   * Positive ⇒ SIGE scored ideas higher on average. null when no pairs.
   */
  readonly sigeLift: number | null;
  /**
   * Groundedness delta = mean(sige.demand - critique.demand). MUST be flat-or-up
   * for a SIGE rollout to be safe; a negative value means SIGE traded
   * groundedness for headline lift. null when no pairs.
   */
  readonly groundednessDelta: number | null;
  /**
   * True iff sigeLift > 0 AND groundednessDelta >= -groundednessTolerance. This
   * is the single boolean the rollout decision keys off.
   */
  readonly liftWithoutGroundednessRegression: boolean;
  /** Mean inter-judge agreement across paired ideas that carried a jury, or null. */
  readonly meanJuryAgreement: number | null;
  /** Dissent distribution (mean + p10/p50/p90) across paired ideas, or nulls. */
  readonly dissentDistribution: DistributionSummary;
  /**
   * Fraction of evaluated rounds the convergence-veto fired on, [0,1]. A high
   * veto rate means SIGE rounds keep collapsing into conformity (sycophancy),
   * which undercuts the value of the jury even if lift looks good.
   */
  readonly convergenceVetoRate: number;
  readonly vetoedRounds: number;
  readonly totalRounds: number;
  /** Number of id-paired ideas that contributed to the deltas. */
  readonly pairedCount: number;
}

/** Tolerance below which a negative groundedness delta is still "flat". */
const DEFAULT_GROUNDEDNESS_TOLERANCE = 0.05;

/** Build a distribution summary (mean + p10/p50/p90) over a scalar list. */
function summarizeDistribution(values: readonly number[]): DistributionSummary {
  return {
    mean: roundOrNull(meanOrNull(values)),
    p10: roundOrNull(percentileOrNull(values, 10)),
    p50: roundOrNull(percentileOrNull(values, 50)),
    p90: roundOrNull(percentileOrNull(values, 90)),
    count: values.length,
  };
}

/**
 * Compare hardened-SIGE GIANT scores against self-critique GIANT scores over the
 * SAME, id-paired ideas, plus the round-level convergence-veto outcomes.
 *
 * PURE. Safe on empty input (yields null deltas, zeroed rates). Non-finite axis
 * scores are skipped per-axis so a partial vector does not poison a mean. The
 * `vetoes` list is one boolean per evaluated SIGE round (true = vetoed); it is
 * independent of the pairs because a veto is a round property, not a per-idea one.
 */
export function compareSigeAb(
  pairs: readonly SigeAbPair[],
  vetoes: readonly boolean[] = [],
  opts?: { readonly groundednessTolerance?: number },
): SigeAbReport {
  const tolerance =
    opts?.groundednessTolerance ?? DEFAULT_GROUNDEDNESS_TOLERANCE;

  // Per-axis delta accumulation. Each axis has its own denominator so a missing
  // axis on one side does not bias another axis's mean.
  const axisDeltaLists = {} as Record<GiantAxisKey, number[]>;
  for (const key of GIANT_AXIS_KEYS) axisDeltaLists[key] = [];

  const agreements: number[] = [];
  const dissents: number[] = [];

  for (const pair of pairs) {
    for (const key of GIANT_AXIS_KEYS) {
      const s = pair.sigeScores[key];
      const c = pair.critiqueScores[key];
      if (Number.isFinite(s) && Number.isFinite(c)) {
        axisDeltaLists[key].push(s - c);
      }
    }
    if (
      typeof pair.juryAgreement === "number" &&
      Number.isFinite(pair.juryAgreement)
    ) {
      agreements.push(pair.juryAgreement);
    }
    if (typeof pair.dissent === "number" && Number.isFinite(pair.dissent)) {
      dissents.push(pair.dissent);
    }
  }

  const axisDeltas = {} as Record<GiantAxisKey, number | null>;
  const axisMeanValues: number[] = [];
  for (const key of GIANT_AXIS_KEYS) {
    const mean = meanOrNull(axisDeltaLists[key]);
    axisDeltas[key] = roundOrNull(mean);
    if (mean !== null) axisMeanValues.push(mean);
  }

  const sigeLift = roundOrNull(meanOrNull(axisMeanValues));
  const groundednessDelta = roundOrNull(meanOrNull(axisDeltaLists.demand));

  const liftWithoutGroundednessRegression =
    sigeLift !== null &&
    sigeLift > 0 &&
    groundednessDelta !== null &&
    groundednessDelta >= -tolerance;

  const totalRounds = vetoes.length;
  const vetoedRounds = vetoes.reduce((n, v) => n + (v ? 1 : 0), 0);

  return {
    axisDeltas,
    sigeLift,
    groundednessDelta,
    liftWithoutGroundednessRegression,
    meanJuryAgreement: roundOrNull(meanOrNull(agreements)),
    dissentDistribution: summarizeDistribution(dissents),
    convergenceVetoRate:
      totalRounds === 0 ? 0 : roundOrNull(vetoedRounds / totalRounds) ?? 0,
    vetoedRounds,
    totalRounds,
    pairedCount: pairs.length,
  };
}

// ── Objective embedding-novelty metric ─────────────────────────────────────────

/** A batch item carrying the text we embed for the novelty metric. */
export interface NoveltyItem {
  readonly id: string;
  readonly text: string;
}

/**
 * Injected embedding dependency for the novelty metric. Mirrors the memory
 * {@link import("../../../memory/types").EmbeddingProvider} surface (embed(texts)
 * → vectors) but is accepted by interface so the pure distance math stays
 * unit-testable with a stub.
 */
export interface NoveltyEmbedDep {
  embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
}

/**
 * Injected corpus-search dependency: given a query vector, return the nearest
 * known-product/idea corpus vectors' similarity scores (cosine in [0,1] or a
 * raw distance — see `corpusScoresAreDistances`). Graceful: may return [] when
 * the corpus / Qdrant is unavailable.
 */
export interface NoveltySearchDep {
  /** Nearest-neighbour scores for one query vector against the known corpus. */
  nearestCorpusScores(vector: readonly number[]): Promise<readonly number[]>;
}

export interface EmbeddingNoveltyMetric {
  /** Mean pairwise embedding distance WITHIN the batch, [0,..], or null. */
  readonly meanPairwiseDistance: number | null;
  /** Mean distance from each item to the nearest known-corpus item, or null. */
  readonly meanCorpusDistance: number | null;
  /** Number of batch items that were successfully embedded. */
  readonly embeddedCount: number;
  /** Number of items that had a corpus neighbour to measure against. */
  readonly corpusComparedCount: number;
  /** True when corpus distance could not be measured (memory unavailable). */
  readonly corpusUnavailable: boolean;
}

const ZERO_NOVELTY: EmbeddingNoveltyMetric = {
  meanPairwiseDistance: null,
  meanCorpusDistance: null,
  embeddedCount: 0,
  corpusComparedCount: 0,
  corpusUnavailable: true,
};

/** Cosine similarity of two equal-length vectors, in [-1,1]; 0 when degenerate. PURE. */
export function cosineSimilarity(
  a: readonly number[],
  b: readonly number[],
): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < n; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Cosine DISTANCE in [0,2] (1 - similarity). A bigger value = more novel /
 * further apart. PURE.
 */
export function cosineDistance(
  a: readonly number[],
  b: readonly number[],
): number {
  return 1 - cosineSimilarity(a, b);
}

/**
 * Mean pairwise cosine distance over all unordered pairs of vectors. Returns
 * null when fewer than two vectors (no pair to compare). PURE.
 */
export function meanPairwiseCosineDistance(
  vectors: readonly (readonly number[])[],
): number | null {
  if (vectors.length < 2) return null;
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < vectors.length; i += 1) {
    for (let j = i + 1; j < vectors.length; j += 1) {
      sum += cosineDistance(vectors[i]!, vectors[j]!);
      pairs += 1;
    }
  }
  return pairs === 0 ? null : sum / pairs;
}

/**
 * Compute the OBJECTIVE embedding-novelty metric for a batch: mean pairwise
 * distance within the batch + mean distance from the known-product/idea corpus.
 *
 * Both deps are INJECTED so the distance math above stays pure/unit-testable;
 * this wrapper owns the IO orchestration and degrades gracefully — any embed
 * failure or missing corpus yields a partial/zeroed metric rather than throwing.
 *
 * `nearestCorpusScores` is expected to return cosine SIMILARITIES in [0,1]; we
 * convert to distance (1 - max similarity) so "no near neighbour" reads as max
 * novelty. When the search dep is absent or returns nothing for every item, the
 * corpus distance is null and `corpusUnavailable` is true.
 */
export async function computeEmbeddingNovelty(
  items: readonly NoveltyItem[],
  deps: {
    readonly embed: NoveltyEmbedDep | null;
    readonly search?: NoveltySearchDep | null;
  },
): Promise<EmbeddingNoveltyMetric> {
  if (!deps.embed || items.length === 0) return ZERO_NOVELTY;

  let vectors: readonly (readonly number[])[];
  try {
    vectors = await deps.embed.embed(items.map((i) => i.text));
  } catch {
    return ZERO_NOVELTY;
  }

  // Keep only well-formed, non-empty vectors (and their alignment with items).
  const usable: { readonly vector: readonly number[] }[] = [];
  for (const v of vectors) {
    if (Array.isArray(v) && v.length > 0) usable.push({ vector: v });
  }
  const usableVectors = usable.map((u) => u.vector);

  const meanPairwiseDistance = meanPairwiseCosineDistance(usableVectors);

  // Corpus distance (optional + graceful).
  let corpusDistances: number[] = [];
  let corpusUnavailable = true;
  if (deps.search) {
    corpusUnavailable = false;
    for (const v of usableVectors) {
      try {
        const scores = await deps.search.nearestCorpusScores(v);
        if (scores.length === 0) continue;
        const maxSim = Math.max(...scores.filter((s) => Number.isFinite(s)));
        if (!Number.isFinite(maxSim)) continue;
        corpusDistances.push(1 - Math.max(0, Math.min(1, maxSim)));
      } catch {
        // skip this item; keep the run alive
      }
    }
    if (corpusDistances.length === 0) corpusUnavailable = true;
  }

  return {
    meanPairwiseDistance: roundOrNull(meanPairwiseDistance),
    meanCorpusDistance: roundOrNull(meanOrNull(corpusDistances)),
    embeddedCount: usableVectors.length,
    corpusComparedCount: corpusDistances.length,
    corpusUnavailable,
  };
}

// ── Top-level aggregation ──────────────────────────────────────────────────────

/**
 * Combine all aggregates into a single run-level summary. Pure; safe to call
 * with empty inputs (yields zeroed rates and null sub-scores).
 */
export function aggregateEval(params: {
  readonly ideas: readonly EvalIdeaRow[];
  readonly outcomes: readonly EvalOutcomeRow[];
  readonly dedupLabels?: readonly DedupLabel[];
  /**
   * Pre-computed ranker-precision report (built from labeled signal rows by the
   * harness). Optional & graceful: omit/null when no signal facets/feedback
   * exist yet or the ranking layer is off.
   */
  readonly signalRanker?: SignalRankerReport | null;
  /**
   * Pre-computed run-level GIANT aggregate (built by the harness from GIANT
   * scores). Optional & graceful: omit/null when no GIANT scores exist.
   */
  readonly giant?: GiantRunAggregate | null;
  /**
   * Pre-computed objective embedding-novelty metric (built by the harness via
   * an injected embed/search dep). Optional & graceful: omit/null when memory
   * is unavailable.
   */
  readonly embeddingNovelty?: EmbeddingNoveltyMetric | null;
  /**
   * Pre-computed hardened-SIGE vs self-critique A/B report (built by the harness
   * from paired GIANT scores). Optional & graceful: omit/null on default
   * (SIGE-off) runs.
   */
  readonly sigeAb?: SigeAbReport | null;
}): EvalAggregate {
  const {
    ideas,
    outcomes,
    dedupLabels,
    signalRanker,
    giant,
    embeddingNovelty,
    sigeAb,
  } = params;
  return {
    meanSubscores: aggregateMeanSubscores(ideas),
    outcomeRates: aggregateOutcomeRates(ideas, outcomes),
    dedupQuality: dedupLabels ? aggregateDedupQuality(dedupLabels) : null,
    demand: aggregateDemandCoverage(ideas),
    signalRanker: signalRanker ?? null,
    giant: giant ?? null,
    embeddingNovelty: embeddingNovelty ?? null,
    sigeAb: sigeAb ?? null,
    totalIdeas: ideas.length,
  };
}
