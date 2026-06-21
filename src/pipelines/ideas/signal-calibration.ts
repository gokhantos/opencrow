/**
 * Feedback-loop CALIBRATION for the signal-ranking layer (the differentiator).
 *
 * The LLM ranker stamps every scraped signal with a categorical importance
 * bucket (noise|low|medium|high) and a relevanceToIdeas score in [0,1]. Those
 * are *assertions*, not ground truth. This module checks them against reality:
 * did a signal the model called "high" actually go on to seed a VALIDATED idea?
 *
 *   success = the signal contributed to an idea that reached pipeline_stage
 *             'validated' (or an idea_feedback row with kind validated/built).
 *   failure = its idea was archived/dismissed.
 *
 * For each importance bucket (and optionally each category) we maintain a
 * Beta-Bernoulli posterior over "signals in this bucket yield validated ideas",
 * REUSING the math in {@link ./credibility}. The posterior mean becomes a
 * calibrated weight in [0,1]: a miscalibrated 'high' bucket with a poor real
 * validation rate gets down-weighted, a genuinely productive bucket boosted.
 *
 * The aggregation math is intentionally PURE and dependency-free so it can be
 * unit tested without a DB or network. The DB-reading wrapper degrades
 * gracefully: any failure (or no feedback yet) yields a NEUTRAL calibration
 * (every bucket weight 0.5), so callers never break and never over-trust a
 * cold-start model.
 */

import { getDb } from "../../store/db";
import { createLogger } from "../../logger";
import { loadConfig } from "../../config/loader";
import {
  PRIOR_ALPHA,
  PRIOR_BETA,
  betaPosteriorMean,
  updatePosterior,
} from "./credibility";
import type { SignalFacets, SignalImportance } from "../../memory/signal-facets";

const log = createLogger("pipeline:signal-calibration");

// ── Constants ────────────────────────────────────────────────────────────────

/** Importance buckets, ordered noise < low < medium < high. */
export const IMPORTANCE_BUCKETS: readonly SignalImportance[] = [
  "noise",
  "low",
  "medium",
  "high",
] as const;

/**
 * Neutral calibrated weight used when a bucket has no observations yet — the
 * Beta(1,1) prior mean. Keeps an un-calibrated bucket at "no opinion" rather
 * than trusting or distrusting the LLM's raw rank.
 */
export const NEUTRAL_WEIGHT = PRIOR_ALPHA / (PRIOR_ALPHA + PRIOR_BETA); // 0.5

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * One labeled signal outcome: the LLM's importance/category stamp joined to the
 * downstream fate of the idea it helped produce. This is the pure input to
 * {@link computeSignalCalibration}.
 */
export interface LabeledSignalRow {
  /** Importance bucket the LLM assigned to the signal. */
  readonly importance: SignalImportance;
  /** Optional coarse category the LLM assigned (secondary grouping key). */
  readonly category?: string;
  /** true = idea reached validated/built (success); false = archived/dismissed. */
  readonly success: boolean;
}

/** A Beta posterior + derived weight for one calibration group. */
export interface SignalCalibrationCell {
  readonly alpha: number;
  readonly beta: number;
  readonly successes: number;
  readonly failures: number;
  /** Posterior mean E[p] = alpha / (alpha + beta) — the calibrated weight. */
  readonly weight: number;
}

/**
 * The full calibration result: per-importance-bucket weights (always present
 * for every bucket, neutral when unobserved) plus optional per-category cells.
 */
export interface SignalCalibration {
  /** bucket → calibrated weight in [0,1]. Every bucket key is present. */
  readonly byImportance: Readonly<Record<SignalImportance, number>>;
  /** Full posterior detail per bucket (for debugging / eval). */
  readonly importanceCells: Readonly<Record<SignalImportance, SignalCalibrationCell>>;
  /** Optional secondary grouping: "importance::category" → cell. */
  readonly byCategory: ReadonlyMap<string, SignalCalibrationCell>;
}

// ── Pure aggregation ───────────────────────────────────────────────────────────

interface Tally {
  successes: number;
  failures: number;
}

function emptyTally(): Tally {
  return { successes: 0, failures: 0 };
}

/**
 * Fold a tally of successes/failures into a Beta posterior cell by replaying
 * Bernoulli updates over the Beta(priorAlpha, priorBeta) prior, REUSING
 * {@link updatePosterior} / {@link betaPosteriorMean} from credibility.ts.
 * Pure.
 */
function tallyToCell(
  tally: Tally,
  priorAlpha: number,
  priorBeta: number,
): SignalCalibrationCell {
  let posterior = { alpha: priorAlpha, beta: priorBeta };
  for (let i = 0; i < tally.successes; i++) {
    posterior = updatePosterior(posterior, true);
  }
  for (let i = 0; i < tally.failures; i++) {
    posterior = updatePosterior(posterior, false);
  }
  return {
    alpha: posterior.alpha,
    beta: posterior.beta,
    successes: tally.successes,
    failures: tally.failures,
    weight: betaPosteriorMean(posterior.alpha, posterior.beta),
  };
}

/** Composite key for an (importance, category) calibration cell. */
export function calibrationCategoryKey(
  importance: SignalImportance,
  category: string,
): string {
  return `${importance}::${category}`;
}

/**
 * Aggregate labeled signal outcomes into a per-bucket (and per-category) Beta
 * calibration. PURE — no DB, no clock, no rng — so it is fully unit-testable
 * with injected rows and is deterministic.
 *
 * Every importance bucket is represented in the output (neutral prior mean when
 * unobserved), so callers can look up any bucket without a missing-key guard.
 *
 * @param rows        labeled outcomes (one row per signal attribution per idea)
 * @param priorAlpha  Beta prior alpha (default PRIOR_ALPHA, shared with credibility)
 * @param priorBeta   Beta prior beta (default PRIOR_BETA)
 */
export function computeSignalCalibration(
  rows: readonly LabeledSignalRow[],
  priorAlpha: number = PRIOR_ALPHA,
  priorBeta: number = PRIOR_BETA,
): SignalCalibration {
  if (!(priorAlpha > 0) || !(priorBeta > 0)) {
    throw new Error(
      `computeSignalCalibration requires positive priors, got alpha=${priorAlpha} beta=${priorBeta}`,
    );
  }

  const importanceTallies = new Map<SignalImportance, Tally>();
  for (const bucket of IMPORTANCE_BUCKETS) {
    importanceTallies.set(bucket, emptyTally());
  }
  const categoryTallies = new Map<string, { importance: SignalImportance; category: string; tally: Tally }>();

  for (const row of rows) {
    if (!isImportanceBucket(row?.importance)) {
      continue; // skip malformed rows defensively
    }
    const tally = importanceTallies.get(row.importance)!;
    if (row.success) {
      tally.successes += 1;
    } else {
      tally.failures += 1;
    }

    const category = typeof row.category === "string" ? row.category.trim() : "";
    if (category.length > 0) {
      const key = calibrationCategoryKey(row.importance, category);
      const existing =
        categoryTallies.get(key) ??
        { importance: row.importance, category, tally: emptyTally() };
      if (row.success) {
        existing.tally.successes += 1;
      } else {
        existing.tally.failures += 1;
      }
      categoryTallies.set(key, existing);
    }
  }

  const importanceCells = {} as Record<SignalImportance, SignalCalibrationCell>;
  const byImportance = {} as Record<SignalImportance, number>;
  for (const bucket of IMPORTANCE_BUCKETS) {
    const cell = tallyToCell(importanceTallies.get(bucket)!, priorAlpha, priorBeta);
    importanceCells[bucket] = cell;
    byImportance[bucket] = cell.weight;
  }

  const byCategory = new Map<string, SignalCalibrationCell>();
  for (const [key, { tally }] of categoryTallies) {
    byCategory.set(key, tallyToCell(tally, priorAlpha, priorBeta));
  }

  return {
    byImportance,
    importanceCells,
    byCategory,
  };
}

/** A fully-neutral calibration: every bucket at the prior mean, no categories. */
export function neutralSignalCalibration(): SignalCalibration {
  return computeSignalCalibration([]);
}

function isImportanceBucket(value: unknown): value is SignalImportance {
  return (
    typeof value === "string" &&
    (IMPORTANCE_BUCKETS as readonly string[]).includes(value)
  );
}

// ── Apply: combine LLM relevance with the calibrated bucket weight ────────────

/**
 * Combine the LLM's `relevanceToIdeas` with the calibrated weight of its
 * importance bucket into a single bounded [0,1] score for retrieval ranking.
 *
 * The combination is a simple geometric-style blend: the raw LLM relevance is
 * scaled toward the bucket's learned validation rate. A bucket the model
 * over-rated (low real validation) pulls the score DOWN; a productive bucket
 * pulls it UP. With a neutral calibration (weight 0.5 everywhere) the result is
 * the LLM relevance scaled by 1.0 at the midpoint, i.e. unchanged when the
 * model is at 0.5 and gently regressed otherwise — never inflated past 1.
 *
 * Pure (no DB) so it is unit-testable. Falls back to the raw relevance when the
 * bucket is missing from the calibration map (defensive).
 *
 * @param facets       the LLM facet profile (uses importance + relevanceToIdeas)
 * @param calibration  per-bucket calibrated weights
 */
export function calibratedRelevance(
  facets: Pick<SignalFacets, "importance" | "relevanceToIdeas">,
  calibration: SignalCalibration,
): number {
  const relevance = clamp01(facets.relevanceToIdeas);
  const weight = calibration.byImportance[facets.importance];
  if (typeof weight !== "number" || !Number.isFinite(weight)) {
    return relevance;
  }

  // Blend: midpoint-anchored multiplicative adjustment. The bucket weight acts
  // as a gain factor normalised around the neutral prior (NEUTRAL_WEIGHT). A
  // weight above neutral boosts, below neutral attenuates — always bounded.
  const gain = weight / NEUTRAL_WEIGHT; // 1.0 at neutral
  return clamp01(relevance * gain);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

// ── DB-reading wrapper (graceful, read-only, cached, gated) ───────────────────

/** Raw row shape returned by the signal_facets ↔ idea-outcome join. */
interface SignalOutcomeJoinRow {
  readonly importance: string | null;
  readonly category: string | null;
  /** Latest terminal kind for the idea this signal contributed to. */
  readonly kind: string | null;
}

/**
 * Map a terminal idea kind/stage to a Bernoulli outcome for calibration.
 *   validated / built → success
 *   archived / dismissed → failure
 *   anything else → undefined (ignored — not terminal)
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

/**
 * Pure projection of joined DB rows into labeled calibration rows. Exported for
 * unit testing without a DB. Skips rows with a non-terminal/unknown kind or an
 * unparseable importance bucket.
 */
export function projectSignalOutcomeRows(
  rows: readonly SignalOutcomeJoinRow[],
): readonly LabeledSignalRow[] {
  const out: LabeledSignalRow[] = [];
  for (const row of rows) {
    const success = kindToOutcome(row?.kind);
    if (success === undefined) continue;
    if (!isImportanceBucket(row?.importance)) continue;
    out.push({
      importance: row.importance,
      category:
        typeof row.category === "string" && row.category.trim().length > 0
          ? row.category.trim()
          : undefined,
      success,
    });
  }
  return out;
}

/**
 * Read signal_facets joined to idea outcomes and project into labeled rows.
 *
 * The join walks generated_ideas.source_ids_json (an array of {table,id}) back
 * to the signal_facets rows that produced each terminal idea, then attaches the
 * latest terminal feedback kind (falling back to pipeline_stage so the model
 * learns even before idea_feedback rows exist) — mirroring the credibility.ts
 * provenance join so the two stay consistent.
 *
 * Degrades gracefully: returns [] on any error (missing table, parse failure).
 */
export async function loadLabeledSignalRows(): Promise<readonly LabeledSignalRow[]> {
  try {
    const db = getDb();
    const rows = (await db`
      SELECT
        sf.importance AS importance,
        sf.category AS category,
        COALESCE(fb.kind, gi.pipeline_stage) AS kind
      FROM generated_ideas gi
      CROSS JOIN LATERAL jsonb_array_elements(
        COALESCE(NULLIF(gi.source_ids_json, ''), '[]')::jsonb
      ) AS src
      JOIN signal_facets sf
        ON sf.source_table = src->>'table'
       AND sf.source_id = src->>'id'
      LEFT JOIN LATERAL (
        SELECT kind
        FROM idea_feedback
        WHERE idea_feedback.idea_id = gi.id
        ORDER BY created_at DESC
        LIMIT 1
      ) fb ON true
      WHERE COALESCE(fb.kind, gi.pipeline_stage) IN
        ('validated', 'built', 'archived', 'dismissed')
        AND sf.importance IS NOT NULL
    `) as SignalOutcomeJoinRow[];

    return projectSignalOutcomeRows(rows);
  } catch (err) {
    log.warn("loadLabeledSignalRows failed; returning empty calibration set", err);
    return [];
  }
}

// ── Cached, gated public loader ────────────────────────────────────────────────

interface CacheEntry {
  readonly calibration: SignalCalibration;
  readonly expiresAt: number;
}

let cache: CacheEntry | null = null;

/** Cache TTL: calibration shifts slowly; recompute at most once per interval. */
const CALIBRATION_TTL_MS = 5 * 60_000;

/**
 * Load the current signal calibration, gated on `signalRanking` (layered on
 * `signalFacets`) and cached for {@link CALIBRATION_TTL_MS}.
 *
 * Returns a NEUTRAL calibration (every bucket 0.5) when:
 *   - ranking is disabled (so callers can unconditionally apply it), or
 *   - there is no feedback yet / the DB read fails.
 *
 * Never throws.
 */
export async function loadSignalCalibration(
  now: number = Date.now(),
): Promise<SignalCalibration> {
  const smart = loadConfig().pipelines.ideas.smart;
  if (!(smart.signalFacets && smart.signalRanking)) {
    return neutralSignalCalibration();
  }

  if (cache && cache.expiresAt > now) {
    return cache.calibration;
  }

  try {
    const rows = await loadLabeledSignalRows();
    const calibration =
      rows.length > 0
        ? computeSignalCalibration(rows)
        : neutralSignalCalibration();
    cache = { calibration, expiresAt: now + CALIBRATION_TTL_MS };
    return calibration;
  } catch (err) {
    log.warn("loadSignalCalibration failed; returning neutral calibration", err);
    return neutralSignalCalibration();
  }
}
