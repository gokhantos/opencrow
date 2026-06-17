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

export interface EvalAggregate {
  readonly meanSubscores: MeanSubscores;
  readonly outcomeRates: OutcomeRates;
  readonly dedupQuality: DedupQuality | null;
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
}): EvalAggregate {
  const { ideas, outcomes, dedupLabels, signalRanker, giant, embeddingNovelty } =
    params;
  return {
    meanSubscores: aggregateMeanSubscores(ideas),
    outcomeRates: aggregateOutcomeRates(ideas, outcomes),
    dedupQuality: dedupLabels ? aggregateDedupQuality(dedupLabels) : null,
    signalRanker: signalRanker ?? null,
    giant: giant ?? null,
    embeddingNovelty: embeddingNovelty ?? null,
    totalIdeas: ideas.length,
  };
}
