/**
 * Cold-start BOOTSTRAP for the taste loop — Phase 4 of the great-idea-pipeline.
 *
 * The calibration machinery (signal-calibration.ts, credibility.ts) is built,
 * but `idea_feedback` is EMPTY: zero human labels, so every learning loop is
 * inert. This module breaks the cold-start WITHOUT waiting for humans, in two
 * complementary pieces — both PURE-first so they are fully unit-testable:
 *
 *   PART A — AUTO-PROXY LABELS ({@link deriveProxyLabels}).
 *     Derive cheap bootstrap feedback events from the SCORES the pipeline
 *     already persisted on each idea (GIANT composite, demand_score, whitespace,
 *     convergence-veto). These are clearly tagged `actor: "proxy:<reason>"` so
 *     they never masquerade as human labels. The pipeline inserts them via
 *     insertIdeaFeedback; downstream calibration treats human labels as strictly
 *     dominant (a proxy label is NEVER emitted that contradicts an existing
 *     HUMAN label for the same idea).
 *
 *       AUTO-ARCHIVE (kind "archived") when the idea has strong COUNTER-evidence:
 *         - demand counter-evidence: whitespace ≈ 0 AND demand_score low AND a
 *           supply signal present (the market is crowded — a generic me-too), OR
 *         - very low GIANT composite, OR
 *         - convergence-veto flagged (the independent jury converged to kill).
 *
 *       weak AUTO-VALIDATE (kind "validated", actor "proxy:high-giant") only when
 *       the idea is high-GIANT AND grounded AND multi-segment-distinct. Kept
 *       deliberately rare and conservative — false-positive validations are more
 *       corrosive to the taste loop than a missed one.
 *
 *   PART B — GIANT AXIS-WEIGHT CALIBRATION ({@link computeGiantWeightCalibration},
 *     {@link loadGiantWeights}). For each GIANT axis, a Beta-Bernoulli posterior
 *     over "ideas scoring HIGH on this axis get VALIDATED", reusing the
 *     credibility.ts math. The posterior means become a BOUNDED, low-weight
 *     multiplier on GIANT_DEFAULT_WEIGHTS — a nudge near 1.0, never a wholesale
 *     re-rank. The rubric spine (acuteProblem / whyNow) can never be zeroed out:
 *     nudges are clamped to a tight band AND the spine axes carry a higher floor.
 *     Gated behind smart.taste.calibrateGiantWeights (default OFF) and returns
 *     NEUTRAL (= default weights) until enough labels accrue.
 *
 * Graceful by construction: every DB-touching wrapper is wrapped in try/catch
 * and degrades to a no-op / neutral result so a failing bootstrap path can NEVER
 * break the pipeline's default path.
 */

import { createLogger } from "../../logger";
import { loadConfig } from "../../config/loader";
import { getDb } from "../../store/db";
import {
  PRIOR_ALPHA,
  PRIOR_BETA,
  betaPosteriorMean,
  updatePosterior,
} from "./credibility";
import {
  GIANT_AXIS_KEYS,
  GIANT_AXES,
  GIANT_DEFAULT_WEIGHTS,
  AXIS_MAX,
  type GiantAxisKey,
} from "./giant";
import type { FeedbackKind, IdeaFeedbackEvent } from "../../sources/ideas/feedback";

const log = createLogger("pipeline:feedback-bootstrap");

// ════════════════════════════════════════════════════════════════════════════
// PART A — proxy label rules (PURE)
// ════════════════════════════════════════════════════════════════════════════

/**
 * The minimal scored-idea projection the proxy rules read. The pipeline maps a
 * `generated_ideas` row (giant_composite / demand_score / whitespace / archetype
 * / segment / convergence-veto) onto this shape. All score fields are optional
 * so a partially-scored idea never crashes the rules — a missing score simply
 * can't trigger the threshold that depends on it.
 */
export interface ScoredIdeaForProxy {
  readonly id: string;
  /** Non-compensatory GIANT composite in [0, 5]. */
  readonly giantComposite?: number | null;
  /** Cited demand axis score in [0, 5]. */
  readonly demandScore?: number | null;
  /** Whitespace (uncontested headroom) in [0, 1]; ≈0 means a crowded market. */
  readonly whitespace?: number | null;
  /** true when a supply/competitor signal was found for this idea's space. */
  readonly hasSupplySignal?: boolean | null;
  /** true when the independent SIGE jury converged to KILL (convergence veto). */
  readonly convergenceVeto?: boolean | null;
  /** true when the idea's evidence is chain-of-evidence grounded (signal-bound). */
  readonly grounded?: boolean | null;
  /** Count of DISTINCT segments the idea credibly addresses (multi-segment). */
  readonly distinctSegments?: number | null;
  /** Existing terminal HUMAN label for this idea, if any (proxy never overrides). */
  readonly humanLabel?: FeedbackKind | null;
}

/** Tunable thresholds for the proxy rules. Conservative by default. */
export interface ProxyLabelOptions {
  /** GIANT composite at/below this ⇒ "very low" ⇒ auto-archive. Default 1.5. */
  readonly veryLowGiant: number;
  /** demand_score at/below this counts as "low demand" for counter-evidence. Default 1.5. */
  readonly lowDemand: number;
  /** whitespace at/below this counts as "no headroom" (crowded). Default 0.1. */
  readonly noWhitespace: number;
  /** GIANT composite at/above this is required for a weak auto-validate. Default 4.0. */
  readonly highGiant: number;
  /** Distinct segments at/above this counts as multi-segment. Default 2. */
  readonly multiSegmentMin: number;
}

export const DEFAULT_PROXY_OPTIONS: ProxyLabelOptions = {
  veryLowGiant: 1.5,
  lowDemand: 1.5,
  noWhitespace: 0.1,
  highGiant: 4.0,
  multiSegmentMin: 2,
};

/** A proxy feedback event to insert, plus the reason that produced it (for logs). */
export interface ProxyLabel {
  readonly event: IdeaFeedbackEvent;
  /** Machine-readable reason token, e.g. "very-low-giant", "demand-counter". */
  readonly reason: string;
}

/**
 * The set of terminal HUMAN kinds. A proxy label is NEVER emitted for an idea
 * that already carries one of these (human labels are strictly dominant), and a
 * proxy label that would CONTRADICT it is suppressed.
 */
const TERMINAL_HUMAN_KINDS: ReadonlySet<FeedbackKind> = new Set<FeedbackKind>([
  "validated",
  "archived",
  "dismissed",
  "built",
]);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Decide the proxy label (if any) for a SINGLE scored idea. Pure — no DB, no
 * clock, no rng. Returns `null` when no proxy label is warranted.
 *
 * Human dominance: if the idea already has any terminal HUMAN label, return null
 * outright. We never second-guess a human with a cheap proxy, even when the two
 * would AGREE — re-asserting a human verdict adds noise without information.
 *
 * Precedence among proxy outcomes: ARCHIVE evidence is checked first (counter-
 * evidence is cheaper to trust and safer to act on than a positive bet), and a
 * weak VALIDATE is only emitted when NO archive trigger fired.
 */
export function deriveProxyLabel(
  idea: ScoredIdeaForProxy,
  opts: ProxyLabelOptions = DEFAULT_PROXY_OPTIONS,
  runId?: string | null,
): ProxyLabel | null {
  if (typeof idea?.id !== "string" || idea.id.length === 0) {
    return null;
  }

  // Human labels are strictly dominant: never emit a proxy for a human-labeled
  // idea (avoids contradiction AND redundant re-assertion).
  if (idea.humanLabel != null && TERMINAL_HUMAN_KINDS.has(idea.humanLabel)) {
    return null;
  }

  const archive = archiveReason(idea, opts);
  if (archive) {
    return makeProxyLabel(idea.id, "archived", archive, runId);
  }

  if (shouldAutoValidate(idea, opts)) {
    return makeProxyLabel(idea.id, "validated", "high-giant", runId);
  }

  return null;
}

/**
 * The strongest archive reason for an idea, or null. Order encodes severity:
 * convergence-veto (the jury actively killed) > very-low-GIANT > demand
 * counter-evidence.
 */
function archiveReason(
  idea: ScoredIdeaForProxy,
  opts: ProxyLabelOptions,
): string | null {
  if (idea.convergenceVeto === true) {
    return "convergence-veto";
  }
  if (isFiniteNumber(idea.giantComposite) && idea.giantComposite <= opts.veryLowGiant) {
    return "very-low-giant";
  }
  if (hasDemandCounterEvidence(idea, opts)) {
    return "demand-counter";
  }
  return null;
}

/**
 * Strong demand COUNTER-evidence: the market is crowded (whitespace ≈ 0) AND
 * buyer-intent is weak (demand_score low) AND a supply signal is present (real
 * competitors exist). All three must hold — a low demand_score alone might just
 * be missing evidence, not a crowded-out generic.
 */
function hasDemandCounterEvidence(
  idea: ScoredIdeaForProxy,
  opts: ProxyLabelOptions,
): boolean {
  return (
    isFiniteNumber(idea.whitespace) &&
    idea.whitespace <= opts.noWhitespace &&
    isFiniteNumber(idea.demandScore) &&
    idea.demandScore <= opts.lowDemand &&
    idea.hasSupplySignal === true
  );
}

/**
 * Weak auto-validate gate: high GIANT composite AND chain-of-evidence grounded
 * AND multi-segment-distinct. Deliberately conjunctive and rare.
 */
function shouldAutoValidate(
  idea: ScoredIdeaForProxy,
  opts: ProxyLabelOptions,
): boolean {
  return (
    isFiniteNumber(idea.giantComposite) &&
    idea.giantComposite >= opts.highGiant &&
    idea.grounded === true &&
    isFiniteNumber(idea.distinctSegments) &&
    idea.distinctSegments >= opts.multiSegmentMin
  );
}

function makeProxyLabel(
  ideaId: string,
  kind: Extract<FeedbackKind, "archived" | "validated">,
  reason: string,
  runId?: string | null,
): ProxyLabel {
  return {
    reason,
    event: {
      idea_id: ideaId,
      kind,
      actor: `proxy:${reason}`,
      run_id: runId ?? null,
    },
  };
}

/**
 * Derive proxy labels for a BATCH of scored ideas. Pure. Returns only the ideas
 * that earned a label, in input order. The pipeline calls insertIdeaFeedback for
 * each `event`.
 */
export function deriveProxyLabels(
  ideas: readonly ScoredIdeaForProxy[],
  opts: ProxyLabelOptions = DEFAULT_PROXY_OPTIONS,
  runId?: string | null,
): readonly ProxyLabel[] {
  if (!Array.isArray(ideas)) return [];
  const out: ProxyLabel[] = [];
  for (const idea of ideas) {
    const label = deriveProxyLabel(idea, opts, runId);
    if (label) out.push(label);
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════════════
// PART B — GIANT axis-weight calibration (PURE) + DB wrapper
// ════════════════════════════════════════════════════════════════════════════

/**
 * One labeled outcome for axis-weight calibration: per-axis GIANT scores joined
 * to the downstream VALIDATED/ARCHIVED fate of the idea. Pure input to
 * {@link computeGiantWeightCalibration}.
 */
export interface GiantLabeledRow {
  /** The 7 GIANT axis scores in [0, 5]. Missing/NaN axes are skipped per-axis. */
  readonly scores: Partial<Record<GiantAxisKey, number>>;
  /** true = idea reached validated/built; false = archived/dismissed. */
  readonly success: boolean;
  /** Label provenance — HUMAN labels outweigh PROXY ones (see weighting). */
  readonly source: "human" | "proxy";
}

/** A Beta posterior + derived nudge for one GIANT axis. */
export interface GiantAxisCalibrationCell {
  readonly alpha: number;
  readonly beta: number;
  /** Effective (provenance-weighted) high-score successes. */
  readonly successes: number;
  /** Effective (provenance-weighted) high-score failures. */
  readonly failures: number;
  /** Posterior mean E[p] that a HIGH score on this axis predicts validation. */
  readonly mean: number;
  /** Bounded multiplier applied to the axis's default weight (near 1.0). */
  readonly nudge: number;
}

/** The full axis-weight calibration: nudged weights + per-axis posterior detail. */
export interface GiantWeightCalibration {
  /** axis → calibrated (nudged, renormalized) weight. Sums to 1.0. */
  readonly weights: Readonly<Record<GiantAxisKey, number>>;
  /** axis → posterior cell (mean + raw nudge before renormalization). */
  readonly cells: Readonly<Record<GiantAxisKey, GiantAxisCalibrationCell>>;
  /** true when the result is the neutral default (insufficient labels / off). */
  readonly neutral: boolean;
  /** Effective (provenance-weighted) label count that fed the calibration. */
  readonly effectiveLabelCount: number;
}

export interface GiantWeightCalibrationOptions {
  /**
   * A GIANT axis score at/above this (in [0,5]) counts as "HIGH" for the
   * Bernoulli trial "does a high score on this axis predict validation?".
   * Default 3.5 (clearly above the 0..5 midpoint).
   */
  readonly highAxisThreshold: number;
  /**
   * Maximum fractional deviation of any nudge from 1.0. A LOW-WEIGHT cap so the
   * learned signal only nudges — it can never re-rank the rubric. Default 0.15
   * ⇒ nudges live in [0.85, 1.15].
   */
  readonly maxNudge: number;
  /**
   * Tighter cap for the rubric SPINE axes (acuteProblem, whyNow) so the spine
   * can never be down-weighted into irrelevance. Default 0.05 ⇒ spine nudges in
   * [0.95, 1.05].
   */
  readonly maxSpineNudge: number;
  /**
   * Minimum effective (provenance-weighted) label count before any calibration
   * is applied. Below this the result is NEUTRAL. Default 20.
   */
  readonly minLabels: number;
  /** Relative weight of a PROXY label vs a HUMAN label. Default 0.25. */
  readonly proxyWeight: number;
  /** Beta prior alpha (shared with credibility). */
  readonly priorAlpha: number;
  /** Beta prior beta (shared with credibility). */
  readonly priorBeta: number;
}

export const DEFAULT_GIANT_WEIGHT_OPTIONS: GiantWeightCalibrationOptions = {
  highAxisThreshold: 3.5,
  maxNudge: 0.15,
  maxSpineNudge: 0.05,
  minLabels: 20,
  proxyWeight: 0.25,
  priorAlpha: PRIOR_ALPHA,
  priorBeta: PRIOR_BETA,
};

/** The rubric SPINE: hard-gate axes that must always stay dominant. */
const SPINE_AXES: ReadonlySet<GiantAxisKey> = new Set<GiantAxisKey>(
  GIANT_AXIS_KEYS.filter((k) => GIANT_AXES[k].hardGate),
);

/**
 * The fully-neutral calibration: default GIANT weights, every nudge exactly 1.0.
 * Used cold-start and whenever calibration is gated off or under-powered.
 */
export function neutralGiantWeightCalibration(): GiantWeightCalibration {
  const cells = {} as Record<GiantAxisKey, GiantAxisCalibrationCell>;
  const weights = {} as Record<GiantAxisKey, number>;
  for (const axis of GIANT_AXIS_KEYS) {
    const alpha = PRIOR_ALPHA;
    const beta = PRIOR_BETA;
    cells[axis] = {
      alpha,
      beta,
      successes: 0,
      failures: 0,
      mean: betaPosteriorMean(alpha, beta),
      nudge: 1,
    };
    weights[axis] = GIANT_DEFAULT_WEIGHTS[axis];
  }
  return {
    weights,
    cells,
    neutral: true,
    effectiveLabelCount: 0,
  };
}

interface AxisTally {
  successes: number;
  failures: number;
}

/**
 * Compute per-axis Beta posteriors over "a HIGH score on this axis predicts a
 * VALIDATED outcome", then map each posterior mean to a BOUNDED multiplier on
 * the axis's default weight, and renormalize so the weights sum to 1.0. PURE —
 * deterministic, no DB / clock / rng.
 *
 * The nudge is anchored at the NEUTRAL prior mean (0.5): an axis whose high
 * scores predict validation BETTER than chance nudges UP, one that predicts
 * WORSE nudges DOWN, and an uninformative axis stays at 1.0. The deviation is
 * clamped to ±maxNudge (±maxSpineNudge for spine axes) so the learned signal can
 * only NUDGE, never override the rubric — the spine (acuteProblem/whyNow) stays
 * dominant by construction.
 *
 * Below `minLabels` effective labels the whole result is NEUTRAL (default
 * weights), so an under-powered loop never perturbs the rubric.
 */
export function computeGiantWeightCalibration(
  rows: readonly GiantLabeledRow[],
  opts: GiantWeightCalibrationOptions = DEFAULT_GIANT_WEIGHT_OPTIONS,
): GiantWeightCalibration {
  if (!(opts.priorAlpha > 0) || !(opts.priorBeta > 0)) {
    throw new Error(
      `computeGiantWeightCalibration requires positive priors, got alpha=${opts.priorAlpha} beta=${opts.priorBeta}`,
    );
  }

  const proxyWeight = Number.isFinite(opts.proxyWeight)
    ? Math.max(0, opts.proxyWeight)
    : 0;

  // Per-axis effective-weighted tallies of (high-score → success/failure).
  const tallies = new Map<GiantAxisKey, AxisTally>();
  for (const axis of GIANT_AXIS_KEYS) {
    tallies.set(axis, { successes: 0, failures: 0 });
  }

  let effectiveLabelCount = 0;
  for (const row of rows ?? []) {
    if (typeof row?.success !== "boolean") continue;
    const w = row.source === "proxy" ? proxyWeight : 1;
    if (w <= 0) continue;
    effectiveLabelCount += w;

    for (const axis of GIANT_AXIS_KEYS) {
      const raw = row.scores?.[axis];
      if (!isFiniteNumber(raw)) continue;
      // Only HIGH scores are the "treatment" arm of the trial.
      if (raw < opts.highAxisThreshold) continue;
      const tally = tallies.get(axis)!;
      if (row.success) tally.successes += w;
      else tally.failures += w;
    }
  }

  if (effectiveLabelCount < opts.minLabels) {
    const neutral = neutralGiantWeightCalibration();
    return { ...neutral, effectiveLabelCount };
  }

  const neutralMean = betaPosteriorMean(opts.priorAlpha, opts.priorBeta); // 0.5

  // Build per-axis posterior cells + raw nudges, then renormalize the weights.
  const cells = {} as Record<GiantAxisKey, GiantAxisCalibrationCell>;
  const rawWeights = {} as Record<GiantAxisKey, number>;
  let weightSum = 0;

  for (const axis of GIANT_AXIS_KEYS) {
    const tally = tallies.get(axis)!;
    const { alpha, beta } = foldTally(tally, opts.priorAlpha, opts.priorBeta);
    const mean = betaPosteriorMean(alpha, beta);

    const cap = SPINE_AXES.has(axis) ? opts.maxSpineNudge : opts.maxNudge;
    const nudge = nudgeFromMean(mean, neutralMean, cap);

    cells[axis] = {
      alpha,
      beta,
      successes: tally.successes,
      failures: tally.failures,
      mean,
      nudge,
    };

    const nudged = GIANT_DEFAULT_WEIGHTS[axis] * nudge;
    rawWeights[axis] = nudged;
    weightSum += nudged;
  }

  const weights = {} as Record<GiantAxisKey, number>;
  for (const axis of GIANT_AXIS_KEYS) {
    weights[axis] = weightSum > 0 ? rawWeights[axis] / weightSum : GIANT_DEFAULT_WEIGHTS[axis];
  }

  return {
    weights,
    cells,
    neutral: false,
    effectiveLabelCount,
  };
}

/**
 * Fold a (possibly fractional, provenance-weighted) tally into a Beta posterior.
 * Whole counts replay {@link updatePosterior}; any fractional remainder is added
 * directly to the shape params (a Beta posterior's shape params are continuous,
 * so fractional pseudo-counts are well-defined). Pure.
 */
function foldTally(
  tally: AxisTally,
  priorAlpha: number,
  priorBeta: number,
): { readonly alpha: number; readonly beta: number } {
  let posterior = { alpha: priorAlpha, beta: priorBeta };
  const wholeS = Math.floor(tally.successes);
  const wholeF = Math.floor(tally.failures);
  for (let i = 0; i < wholeS; i++) posterior = updatePosterior(posterior, true);
  for (let i = 0; i < wholeF; i++) posterior = updatePosterior(posterior, false);
  const fracS = tally.successes - wholeS;
  const fracF = tally.failures - wholeF;
  return {
    alpha: posterior.alpha + fracS,
    beta: posterior.beta + fracF,
  };
}

/**
 * Map a posterior mean (probability that a high score predicts validation) to a
 * bounded multiplier centered on 1.0. A mean above the neutral prior nudges up,
 * below nudges down; the deviation is scaled by `cap` and clamped to ±cap.
 *
 *   mean == neutralMean ⇒ 1.0
 *   mean == 1           ⇒ 1 + cap
 *   mean == 0           ⇒ 1 - cap
 *
 * Always in [1 - cap, 1 + cap]; never zero or negative (cap < 1).
 */
function nudgeFromMean(mean: number, neutralMean: number, cap: number): number {
  if (!Number.isFinite(mean) || !Number.isFinite(neutralMean)) return 1;
  const boundedCap = Math.max(0, Math.min(cap, 0.99));
  // Normalize the deviation from neutral into [-1, 1] using the larger of the
  // two half-ranges so a neutral of 0.5 maps symmetrically.
  const span = Math.max(neutralMean, 1 - neutralMean) || 1;
  const deviation = (mean - neutralMean) / span; // in [-1, 1]
  const clampedDeviation = Math.max(-1, Math.min(1, deviation));
  return 1 + clampedDeviation * boundedCap;
}

// ── DB-reading wrapper (graceful, read-only, cached, gated) ───────────────────

/** Raw row shape returned by the GIANT-scores ↔ idea-outcome join. */
interface GiantOutcomeJoinRow {
  readonly giant_scores_json: unknown;
  readonly kind: string | null;
  readonly actor: string | null;
}

/**
 * Map a terminal feedback kind to a Bernoulli outcome for calibration.
 *   validated / built → success; archived / dismissed → failure; else undefined.
 */
function kindToOutcome(kind: string | null | undefined): boolean | undefined {
  switch (kind) {
    case "validated":
    case "built":
      return true;
    case "archived":
    case "dismissed":
      return false;
    default:
      return undefined;
  }
}

/** A proxy label is one whose actor is tagged "proxy:<reason>". */
function isProxyActor(actor: string | null | undefined): boolean {
  return typeof actor === "string" && actor.startsWith("proxy:");
}

/**
 * Coerce a persisted giant_scores_json blob into a partial axis-score map. The
 * blob may be a JSON string OR an already-parsed object (driver-dependent), and
 * may nest the axes under a `scores` key (mirroring GiantEvaluation). Only
 * finite numbers for known axes are kept. Pure. Exported for unit testing.
 */
export function parseGiantScores(
  blob: unknown,
): Partial<Record<GiantAxisKey, number>> {
  let obj: unknown = blob;
  if (typeof blob === "string") {
    try {
      obj = JSON.parse(blob);
    } catch {
      return {};
    }
  }
  if (obj == null || typeof obj !== "object") return {};
  const record = obj as Record<string, unknown>;
  const scores =
    record.scores != null && typeof record.scores === "object"
      ? (record.scores as Record<string, unknown>)
      : record;

  const out: Partial<Record<GiantAxisKey, number>> = {};
  for (const axis of GIANT_AXIS_KEYS) {
    const v = scores[axis];
    if (isFiniteNumber(v)) {
      out[axis] = Math.max(0, Math.min(AXIS_MAX, v));
    }
  }
  return out;
}

/**
 * Project joined DB rows into pure {@link GiantLabeledRow}s. Skips rows with a
 * non-terminal kind or no parseable GIANT axis scores. Pure — exported for tests.
 */
export function projectGiantOutcomeRows(
  rows: readonly GiantOutcomeJoinRow[],
): readonly GiantLabeledRow[] {
  const out: GiantLabeledRow[] = [];
  for (const row of rows) {
    const success = kindToOutcome(row?.kind);
    if (success === undefined) continue;
    const scores = parseGiantScores(row?.giant_scores_json);
    if (Object.keys(scores).length === 0) continue;
    out.push({
      scores,
      success,
      source: isProxyActor(row?.actor) ? "proxy" : "human",
    });
  }
  return out;
}

/**
 * Read GIANT scores joined to terminal idea outcomes (human + proxy feedback,
 * falling back to terminal pipeline_stage) and project into labeled rows.
 * Degrades gracefully: returns [] on any error.
 */
export async function loadGiantLabeledRows(): Promise<readonly GiantLabeledRow[]> {
  try {
    const db = getDb();
    const rows = (await db`
      SELECT
        gi.giant_scores_json AS giant_scores_json,
        COALESCE(fb.kind, gi.pipeline_stage) AS kind,
        fb.actor AS actor
      FROM generated_ideas gi
      LEFT JOIN LATERAL (
        SELECT kind, actor
        FROM idea_feedback
        WHERE idea_feedback.idea_id = gi.id
        ORDER BY created_at DESC
        LIMIT 1
      ) fb ON true
      WHERE COALESCE(fb.kind, gi.pipeline_stage) IN
        ('validated', 'built', 'archived', 'dismissed')
        AND gi.giant_scores_json IS NOT NULL
    `) as GiantOutcomeJoinRow[];

    return projectGiantOutcomeRows(rows);
  } catch (err) {
    log.warn("loadGiantLabeledRows failed; returning empty calibration set", err);
    return [];
  }
}

// ── Cached, gated public loader ────────────────────────────────────────────────

interface CacheEntry {
  readonly calibration: GiantWeightCalibration;
  readonly expiresAt: number;
}

let cache: CacheEntry | null = null;

/** Cache TTL: axis weights shift slowly; recompute at most once per interval. */
const CALIBRATION_TTL_MS = 5 * 60_000;

/** Reset the in-memory weight-calibration cache. Exposed for tests + refresh. */
export function clearGiantWeightCache(): void {
  cache = null;
}

/**
 * Load the current GIANT axis weights, gated behind
 * `smart.taste.calibrateGiantWeights` and cached for {@link CALIBRATION_TTL_MS}.
 *
 * Returns NEUTRAL (= GIANT_DEFAULT_WEIGHTS) when:
 *   - calibration is disabled (the default), or
 *   - there are insufficient labels, or the DB read fails.
 *
 * Never throws. The caller threads `calibration.weights` into
 * {@link aggregateGiant}'s `weights` option.
 */
export async function loadGiantWeights(
  now: number = Date.now(),
): Promise<GiantWeightCalibration> {
  let gated = false;
  try {
    gated = loadConfig().pipelines.ideas.smart.taste.calibrateGiantWeights === true;
  } catch (err) {
    log.warn("loadGiantWeights: config load failed; using neutral weights", err);
    return neutralGiantWeightCalibration();
  }
  if (!gated) {
    return neutralGiantWeightCalibration();
  }

  if (cache && cache.expiresAt > now) {
    return cache.calibration;
  }

  try {
    const rows = await loadGiantLabeledRows();
    const calibration =
      rows.length > 0
        ? computeGiantWeightCalibration(rows)
        : neutralGiantWeightCalibration();
    cache = { calibration, expiresAt: now + CALIBRATION_TTL_MS };
    return calibration;
  } catch (err) {
    log.warn("loadGiantWeights failed; returning neutral weights", err);
    return neutralGiantWeightCalibration();
  }
}
