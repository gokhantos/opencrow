/**
 * Source-credibility learning model (Beta-Bernoulli / Thompson sampling).
 *
 * Learns how trustworthy each information source is — keyed by
 * (source_table, signal_type, category) — from the downstream fate of the
 * ideas that source helped produce.
 *
 *   success = idea reached pipeline_stage 'validated', OR an idea_feedback row
 *             with kind 'validated' / 'built' exists for that idea.
 *   failure = idea was 'archived' / 'dismissed'.
 *
 * Each (source_table, signal_type, category) tuple gets a Beta(α, β) posterior
 * over its latent "this source yields good ideas" probability. Collector
 * ordering can either rank by the posterior mean (exploit) or Thompson-sample
 * from the posterior (explore/exploit), so under-observed sources still get a
 * chance to prove themselves.
 *
 * The math is intentionally PURE and dependency-free so it can be unit tested
 * without a DB or network. The DB-reading wrapper at the bottom degrades
 * gracefully: any failure returns an empty result and never throws.
 */

import { getDb } from "../../store/db";
import { createLogger } from "../../logger";
import { getUsedSourceIds } from "../../sources/ideas/store";

const log = createLogger("pipeline:credibility");

// ── Priors ───────────────────────────────────────────────────────────────────

/**
 * Uniform Beta(1,1) prior — every source starts assumed neither good nor bad.
 * Using a weak prior keeps cold-start sources near 0.5 with high variance, so
 * Thompson sampling naturally explores them.
 */
export const PRIOR_ALPHA = 1;
export const PRIOR_BETA = 1;

// ── Types ─────────────────────────────────────────────────────────────────────

/** Outcome of a single idea attributed to a source, from the feedback join. */
export interface SourceOutcomeRow {
  readonly source_table: string;
  readonly signal_type: string;
  readonly category: string;
  /** true = validated/built (success), false = archived/dismissed (failure). */
  readonly success: boolean;
}

/** A Beta posterior for one (source_table, signal_type, category) tuple. */
export interface SourceCredibility {
  readonly source_table: string;
  readonly signal_type: string;
  readonly category: string;
  readonly alpha: number;
  readonly beta: number;
  readonly successes: number;
  readonly failures: number;
  /** Posterior mean E[p] = alpha / (alpha + beta). */
  readonly mean: number;
}

/** Injected RNG for deterministic, testable sampling. Returns [0, 1). */
export type Rng = () => number;

// ── Pure Beta-Bernoulli math ──────────────────────────────────────────────────

/**
 * Posterior mean of a Beta(alpha, beta) distribution: alpha / (alpha + beta).
 * Both shape params must be > 0.
 */
export function betaPosteriorMean(alpha: number, beta: number): number {
  if (!(alpha > 0) || !(beta > 0)) {
    throw new Error(
      `betaPosteriorMean requires alpha>0 and beta>0, got alpha=${alpha} beta=${beta}`,
    );
  }
  return alpha / (alpha + beta);
}

/**
 * Posterior variance of Beta(alpha, beta):
 *   (alpha*beta) / ((alpha+beta)^2 * (alpha+beta+1))
 * Useful for ranking by uncertainty (e.g. tie-breaks / exploration bonus).
 */
export function betaPosteriorVariance(alpha: number, beta: number): number {
  if (!(alpha > 0) || !(beta > 0)) {
    throw new Error(
      `betaPosteriorVariance requires alpha>0 and beta>0, got alpha=${alpha} beta=${beta}`,
    );
  }
  const sum = alpha + beta;
  return (alpha * beta) / (sum * sum * (sum + 1));
}

/**
 * Bayesian update of a Beta prior with one Bernoulli observation.
 * Returns a NEW prior (immutable). success → alpha+1, failure → beta+1.
 */
export function updatePosterior(
  prior: { readonly alpha: number; readonly beta: number },
  success: boolean,
): { readonly alpha: number; readonly beta: number } {
  return success
    ? { alpha: prior.alpha + 1, beta: prior.beta }
    : { alpha: prior.alpha, beta: prior.beta + 1 };
}

/**
 * Draw a single sample from Beta(alpha, beta) using two Gamma draws:
 *   X ~ Gamma(alpha,1), Y ~ Gamma(beta,1)  ⇒  X/(X+Y) ~ Beta(alpha,beta).
 *
 * The Gamma sampler is the Marsaglia–Tsang method, which consumes the injected
 * `rng` so callers can seed it for deterministic tests. Falls back to the
 * posterior mean if the draw degenerates (both gammas ~0).
 */
export function thompsonSample(
  alpha: number,
  beta: number,
  rng: Rng = Math.random,
): number {
  if (!(alpha > 0) || !(beta > 0)) {
    throw new Error(
      `thompsonSample requires alpha>0 and beta>0, got alpha=${alpha} beta=${beta}`,
    );
  }
  const x = sampleGamma(alpha, rng);
  const y = sampleGamma(beta, rng);
  const denom = x + y;
  if (denom <= 0 || !Number.isFinite(denom)) {
    return betaPosteriorMean(alpha, beta);
  }
  return x / denom;
}

/**
 * Standard-normal sample via Box–Muller, consuming the injected rng.
 * Guards against log(0) by flooring the uniform draw.
 */
function sampleStandardNormal(rng: Rng): number {
  const u1 = Math.max(rng(), Number.EPSILON);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Sample from Gamma(shape, scale=1) using Marsaglia & Tsang (2000).
 * Handles shape < 1 via the boosting trick. Pure given the injected rng.
 */
function sampleGamma(shape: number, rng: Rng): number {
  if (shape <= 0) return 0;

  // Boost shapes < 1: Gamma(a) = Gamma(a+1) * U^(1/a)
  if (shape < 1) {
    const g = sampleGamma(shape + 1, rng);
    const u = Math.max(rng(), Number.EPSILON);
    return g * Math.pow(u, 1 / shape);
  }

  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);

  // Bounded loop: rejection sampling almost always succeeds in a few tries;
  // the cap guarantees termination even with a pathological rng.
  for (let i = 0; i < 1000; i++) {
    let v: number;
    let z: number;
    do {
      z = sampleStandardNormal(rng);
      v = 1 + c * z;
    } while (v <= 0);

    v = v * v * v;
    const u = rng();
    const z2 = z * z;

    if (u < 1 - 0.0331 * z2 * z2) {
      return d * v;
    }
    if (Math.log(Math.max(u, Number.EPSILON)) < 0.5 * z2 + d * (1 - v + Math.log(v))) {
      return d * v;
    }
  }

  // Fallback: deterministic mean of the distribution.
  return d;
}

// ── Aggregation: outcomes → per-source posteriors ─────────────────────────────

/** Composite key for a (source_table, signal_type, category) tuple. */
export function credibilityKey(
  source_table: string,
  signal_type: string,
  category: string,
): string {
  return `${source_table}::${signal_type}::${category}`;
}

/**
 * Aggregate per-idea source outcomes into Beta posteriors, one per
 * (source_table, signal_type, category). PURE — no DB, no clock, no rng.
 *
 * @param outcomeRows  flattened outcomes (one row per source attribution per idea)
 * @param priorAlpha   Beta prior alpha (default PRIOR_ALPHA)
 * @param priorBeta    Beta prior beta (default PRIOR_BETA)
 */
export function computeSourceCredibility(
  outcomeRows: readonly SourceOutcomeRow[],
  priorAlpha: number = PRIOR_ALPHA,
  priorBeta: number = PRIOR_BETA,
): readonly SourceCredibility[] {
  if (!(priorAlpha > 0) || !(priorBeta > 0)) {
    throw new Error(
      `computeSourceCredibility requires positive priors, got alpha=${priorAlpha} beta=${priorBeta}`,
    );
  }

  interface Tally {
    readonly source_table: string;
    readonly signal_type: string;
    readonly category: string;
    readonly successes: number;
    readonly failures: number;
  }

  const tallies = new Map<string, Tally>();

  for (const row of outcomeRows) {
    if (
      typeof row?.source_table !== "string" ||
      typeof row?.signal_type !== "string" ||
      typeof row?.category !== "string"
    ) {
      continue; // skip malformed rows defensively
    }
    const key = credibilityKey(row.source_table, row.signal_type, row.category);
    const prev = tallies.get(key);
    if (prev) {
      tallies.set(key, {
        ...prev,
        successes: prev.successes + (row.success ? 1 : 0),
        failures: prev.failures + (row.success ? 0 : 1),
      });
    } else {
      tallies.set(key, {
        source_table: row.source_table,
        signal_type: row.signal_type,
        category: row.category,
        successes: row.success ? 1 : 0,
        failures: row.success ? 0 : 1,
      });
    }
  }

  return [...tallies.values()].map((t) => {
    const alpha = priorAlpha + t.successes;
    const beta = priorBeta + t.failures;
    return {
      source_table: t.source_table,
      signal_type: t.signal_type,
      category: t.category,
      alpha,
      beta,
      successes: t.successes,
      failures: t.failures,
      mean: betaPosteriorMean(alpha, beta),
    };
  });
}

/**
 * Rank credibilities for collector ordering. When `explore` is true, ranks by
 * a Thompson sample (explore/exploit) drawn with the injected rng; otherwise
 * ranks by the posterior mean (pure exploit). Returns a NEW sorted array.
 */
export function rankBySourceCredibility(
  credibilities: readonly SourceCredibility[],
  options?: { readonly explore?: boolean; readonly rng?: Rng },
): readonly SourceCredibility[] {
  const explore = options?.explore ?? false;
  const rng = options?.rng ?? Math.random;
  const scored = credibilities.map((c) => ({
    cred: c,
    score: explore ? thompsonSample(c.alpha, c.beta, rng) : c.mean,
  }));
  return [...scored]
    .sort((a, b) => b.score - a.score)
    .map((s) => s.cred);
}

// ── DB-reading wrapper (graceful, read-only) ──────────────────────────────────

/**
 * Map an idea_feedback `kind` to a Bernoulli outcome.
 *   validated / built → success (true)
 *   archived / dismissed → failure (false)
 *   anything else → undefined (ignored — not a terminal credibility signal)
 */
function kindToOutcome(kind: string): boolean | undefined {
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

/** Raw row shape returned by the feedback↔idea provenance join. */
interface FeedbackProvenanceRow {
  readonly idea_id: string;
  readonly kind: string;
  readonly category: string;
  readonly source_ids_json: string | null;
}

/**
 * Read idea_feedback joined to generated_ideas provenance and flatten into
 * per-source outcome rows. Each idea contributes one outcome row per
 * (source_table) attribution it carries. signal_type is best-effort and may be
 * 'unknown' when not recoverable from provenance.
 *
 * NOTE: `getUsedSourceIds` is imported read-only to keep this module aligned
 * with the canonical provenance parser; it is not invoked on the hot path here.
 *
 * Degrades gracefully: returns [] on any error (missing table, parse failure).
 */
export async function loadSourceOutcomes(): Promise<readonly SourceOutcomeRow[]> {
  // Reference the canonical provenance accessor so future callers can reuse it;
  // touching it here keeps the import meaningful without a hot-path DB hit.
  void getUsedSourceIds;

  try {
    const db = getDb();
    // Prefer explicit feedback; fall back to terminal pipeline_stage so the
    // model still learns even before any idea_feedback rows exist.
    const rows = (await db`
      SELECT
        gi.id AS idea_id,
        COALESCE(fb.kind, gi.pipeline_stage) AS kind,
        gi.category AS category,
        gi.source_ids_json AS source_ids_json
      FROM generated_ideas gi
      LEFT JOIN LATERAL (
        SELECT kind
        FROM idea_feedback
        WHERE idea_feedback.idea_id = gi.id
        ORDER BY created_at DESC
        LIMIT 1
      ) fb ON true
      WHERE COALESCE(fb.kind, gi.pipeline_stage) IN
        ('validated', 'built', 'archived', 'dismissed')
        AND gi.source_ids_json IS NOT NULL
        AND gi.source_ids_json != '[]'
    `) as FeedbackProvenanceRow[];

    return flattenFeedbackRows(rows);
  } catch (err) {
    log.warn("loadSourceOutcomes failed; returning empty credibility set", err);
    return [];
  }
}

/**
 * Pure flattening of joined feedback/provenance rows into outcome rows.
 * Exported for unit testing without a DB. Skips malformed JSON/entries.
 */
export function flattenFeedbackRows(
  rows: readonly FeedbackProvenanceRow[],
): readonly SourceOutcomeRow[] {
  const out: SourceOutcomeRow[] = [];

  for (const row of rows) {
    const success = kindToOutcome(row.kind);
    if (success === undefined) continue;
    if (!row.source_ids_json) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(row.source_ids_json);
    } catch {
      continue; // skip malformed provenance JSON
    }
    if (!Array.isArray(parsed)) continue;

    for (const entry of parsed) {
      if (typeof entry?.table !== "string") continue;
      out.push({
        source_table: entry.table,
        signal_type:
          typeof entry?.signal_type === "string" ? entry.signal_type : "unknown",
        category: typeof row.category === "string" ? row.category : "unknown",
        success,
      });
    }
  }

  return out;
}

/**
 * Full DB-backed credibility computation: read outcomes, aggregate to
 * posteriors. Never throws — returns [] on failure.
 */
export async function getSourceCredibility(): Promise<readonly SourceCredibility[]> {
  try {
    const outcomes = await loadSourceOutcomes();
    return computeSourceCredibility(outcomes);
  } catch (err) {
    log.warn("getSourceCredibility failed; returning empty set", err);
    return [];
  }
}
