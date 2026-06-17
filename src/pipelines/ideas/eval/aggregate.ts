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

// ── Top-level aggregation ──────────────────────────────────────────────────────

/**
 * Combine all aggregates into a single run-level summary. Pure; safe to call
 * with empty inputs (yields zeroed rates and null sub-scores).
 */
export function aggregateEval(params: {
  readonly ideas: readonly EvalIdeaRow[];
  readonly outcomes: readonly EvalOutcomeRow[];
  readonly dedupLabels?: readonly DedupLabel[];
}): EvalAggregate {
  const { ideas, outcomes, dedupLabels } = params;
  return {
    meanSubscores: aggregateMeanSubscores(ideas),
    outcomeRates: aggregateOutcomeRates(ideas, outcomes),
    dedupQuality: dedupLabels ? aggregateDedupQuality(dedupLabels) : null,
    totalIdeas: ideas.length,
  };
}
