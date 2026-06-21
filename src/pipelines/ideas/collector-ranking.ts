/**
 * Pure collector-side ranking & field-promotion helpers.
 *
 * All functions here are dependency-free, side-effect-free, and deterministic
 * (given an injected `rng` where randomness is used). They power the
 * credibility × velocity × corroboration × recency weighted top-K selection in
 * collectors.ts and the promotion of structured JSON columns (Product Hunt
 * makers/topics, Reddit/HN top-comments) into the Capability shape.
 *
 * Extracted from collectors.ts to keep that file focused and these primitives
 * independently unit-testable in the fast unit lane.
 */

import type { CapabilityMaker } from "./types";
import { credibilityKey } from "./credibility";

/** Clamp a number into the inclusive [0, 1] range; NaN → 0. */
export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Coerce an unknown DB cell to a finite number (default 0). */
export function toNumber(value: unknown, fallback = 0): number {
  if (value == null) return fallback;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Min-max normalize a set of raw velocity values into [0, 1] keyed by row id.
 *
 * Negative velocities (decelerating) clamp to 0; a flat batch (all equal)
 * yields 0 for every row (no momentum signal). Pure and deterministic.
 */
export function normalizeVelocities(
  entries: readonly { readonly id: string; readonly velocity: number }[],
): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  if (entries.length === 0) return out;

  const positive = entries.map((e) => Math.max(0, toNumber(e.velocity)));
  const max = Math.max(...positive);
  if (max <= 0) {
    for (const e of entries) out.set(e.id, 0);
    return out;
  }
  entries.forEach((e, i) => {
    out.set(e.id, clamp01(positive[i]! / max));
  });
  return out;
}

/**
 * Recency factor in [0, 1] from an epoch-seconds timestamp using exponential
 * decay with a half-life in days. Missing/zero timestamps → neutral 0.5.
 */
export function recencyFactor(
  epochSeconds: number | null | undefined,
  nowSeconds: number,
  halfLifeDays = 7,
): number {
  const ts = toNumber(epochSeconds);
  if (ts <= 0) return 0.5;
  const ageDays = Math.max(0, (nowSeconds - ts) / 86_400);
  const halfLife = Math.max(0.1, halfLifeDays);
  return clamp01(Math.pow(0.5, ageDays / halfLife));
}

/**
 * Default engagement scale (the raw-engagement value that maps to roughly the
 * midpoint of the obscurity curve). Tuned so that small-community signals (tens
 * of upvotes/stars) score HIGH obscurity and viral ones (thousands) score ~0.
 */
export const OBSCURITY_ENGAGEMENT_SCALE = 200;

/**
 * Map a raw absolute engagement metric (upvotes / stars / likes) to an
 * inverse-popularity "obscurity" factor in [0, 1] via a log curve: 0 engagement
 * → 1.0 (maximally underserved), and engagement grows the popularity term so a
 * viral row trends toward 0. PURE — deterministic.
 *
 *   obscurity = 1 - log1p(engagement) / log1p(engagement + scale)
 *
 * The denominator grows with engagement so the curve is smooth and bounded; a
 * larger `scale` makes more rows count as "niche". Negative/NaN engagement → 1.
 */
export function obscurityFromEngagement(
  engagement: number | null | undefined,
  scale = OBSCURITY_ENGAGEMENT_SCALE,
): number {
  const e = Math.max(0, toNumber(engagement));
  const s = Math.max(1, scale);
  const popularity = Math.log1p(e) / Math.log1p(e + s);
  return clamp01(1 - popularity);
}

/**
 * Neutral learned-credibility posterior mean. A Beta(1,1) cold-start source
 * sits at 0.5, so treating 0.5 (or an absent posterior) as neutral makes the
 * learned-credibility multiplier a no-op until real feedback moves a source
 * above/below the midpoint. Keeps the default path identical to before #157.
 */
export const NEUTRAL_LEARNED_CREDIBILITY = 0.5;

/**
 * Layer A — DE-BIAS RANK WEIGHTS.
 *
 * The base rank blend is rebalanced AWAY from raw popularity (credibility +
 * velocity) and TOWARD recency + an inverse-popularity "niche bonus" so a sharp
 * pain in a small community can out-rank a viral post. All weights are exported,
 * named, and sum to 1.0 before the bounded learned-credibility multiplier.
 *
 *   old: 0.45*credibility + 0.25*velocityNorm + 0.20*corroBoost + 0.10*recency
 *   new: 0.30*credibility + 0.15*velocityNorm + 0.15*corroBoost + 0.20*recency
 *        + 0.20*nicheBonus
 *
 * The niche bonus is the inverse of absolute engagement: a row with little raw
 * engagement (an underserved long-tail signal) gets a high bonus; a viral row
 * gets ~0. It is derived from an optional `obscurity` input (1 = maximally
 * obscure / underserved) which callers compute from raw engagement.
 */
export const RANK_WEIGHT_CREDIBILITY = 0.3;
export const RANK_WEIGHT_VELOCITY = 0.15;
export const RANK_WEIGHT_CORRO = 0.15;
export const RANK_WEIGHT_RECENCY = 0.2;
export const RANK_WEIGHT_NICHE = 0.2;

/** Inputs to the combined per-row rank score. */
export interface RankInputs {
  /** Source-credibility weight in [0, 1]. Defaults to 0.5 when absent. */
  readonly credibility?: number;
  /** Normalized momentum in [0, 1]. Defaults to 0 when absent. */
  readonly velocityNorm?: number;
  /** Distinct-source corroboration count (1 = single source). */
  readonly corroborationCount?: number;
  /** Recency factor in [0, 1]. Defaults to 0.5 when absent. */
  readonly recency?: number;
  /**
   * Inverse-popularity / "underserved" factor in [0, 1] (1 = maximally obscure,
   * low absolute engagement; 0 = viral). Rewards sharp pains in small
   * communities. Optional — defaults to a NEUTRAL 0.5 so existing callers/tests
   * that don't pass it are unchanged in RELATIVE ordering. Compute via
   * {@link obscurityFromEngagement} at the call site.
   */
  readonly obscurity?: number;
  /**
   * Learned Beta-Bernoulli posterior mean in [0, 1] for this row's
   * (source_table, signal_type, category) tuple, from downstream idea fate.
   * Absent (or 0.5) ⇒ no learned signal ⇒ neutral multiplier of 1.0, so the
   * score is unchanged from the static-credibility-only behavior. A posterior
   * above 0.5 boosts the row; below 0.5 dampens it.
   */
  readonly learnedCredibility?: number;
}

/**
 * Map a learned posterior mean in [0, 1] to a BOUNDED multiplier centered on
 * 1.0. 0.5 → 1.0 (neutral), 1.0 → 1 + `swing`, 0.0 → 1 − `swing`. Absent ⇒ 1.0.
 *
 * The swing is intentionally small (default 0.3) so a learned source can nudge
 * but never dominate the static credibility × momentum × corroboration × recency
 * blend — under-observed sources (near 0.5) stay essentially neutral.
 */
export function learnedCredibilityMultiplier(
  posteriorMean: number | undefined,
  swing = 0.3,
): number {
  if (posteriorMean == null) return 1;
  const p = clamp01(posteriorMean);
  return 1 + swing * (p - NEUTRAL_LEARNED_CREDIBILITY) * 2;
}

/**
 * Look up a learned posterior mean for a row from a posterior map keyed by
 * {@link credibilityKey}(`source_table`, `signal_type`, `category`).
 *
 * Provenance written by the pipeline only carries {table, id}, so the learned
 * model's `signal_type` is typically the literal `"unknown"` and `category` is
 * the downstream idea's category. To maximise hit-rate from the collector side
 * (which knows its sub-source but not the future idea category) this tries the
 * exact key first, then progressively looser fallbacks. Returns `undefined`
 * when the map is absent/empty or no candidate key matches — callers then treat
 * it as neutral (multiplier 1.0), preserving the default path.
 */
export function lookupLearnedCredibility(
  posteriors: ReadonlyMap<string, number> | undefined,
  sourceTable: string,
  signalType: string,
  category: string,
): number | undefined {
  if (!posteriors || posteriors.size === 0) return undefined;
  const candidates = [
    credibilityKey(sourceTable, signalType, category),
    credibilityKey(sourceTable, signalType, "unknown"),
    credibilityKey(sourceTable, "unknown", category),
    credibilityKey(sourceTable, "unknown", "unknown"),
  ];
  for (const key of candidates) {
    const value = posteriors.get(key);
    if (typeof value === "number") return value;
  }
  return undefined;
}

/**
 * Combine credibility × velocity × corroboration × recency into a single
 * additive rank score, then fold in a small exploration jitter so the top-K is
 * not perfectly deterministic (exploration/exploitation). Pure given `rng`.
 *
 * Weighting (Layer A de-bias, documented intentionally): the blend is rebalanced
 * AWAY from raw popularity and TOWARD recency + an inverse-popularity niche bonus
 * (credibility 0.30, velocity 0.15, corroboration 0.15, recency 0.20, niche
 * 0.20 — summing to 1.0) so a sharp pain in a small community can out-rank a
 * viral post. Corroboration is log-scaled so a 3rd source matters less than the
 * 2nd. The result is in roughly [0, 1] before jitter.
 *
 * Learned credibility (optional): the additive base is scaled by a bounded
 * multiplier derived from the row's posterior mean (0.5 ⇒ ×1.0 no-op), then the
 * scaled base is re-clamped to [0, 1] before jitter so the score stays bounded.
 * When no posterior is supplied the multiplier is exactly 1.0 → identical to the
 * pre-existing behavior.
 */
export function computeRankScore(
  inputs: RankInputs,
  rng: () => number = Math.random,
  explorationWeight = 0.15,
): number {
  const credibility = clamp01(inputs.credibility ?? 0.5);
  const velocityNorm = clamp01(inputs.velocityNorm ?? 0);
  const recency = clamp01(inputs.recency ?? 0.5);
  // Neutral 0.5 default so callers that don't supply obscurity keep their
  // relative ordering (the term is the same constant for every row).
  const obscurity = clamp01(inputs.obscurity ?? 0.5);
  const corro = Math.max(1, toNumber(inputs.corroborationCount, 1));
  // log2(corro): 1→0, 2→1, 4→2 … scaled into [0, ~0.6].
  const corroBoost = clamp01(Math.log2(corro) / 3);

  const base =
    RANK_WEIGHT_CREDIBILITY * credibility +
    RANK_WEIGHT_VELOCITY * velocityNorm +
    RANK_WEIGHT_CORRO * corroBoost +
    RANK_WEIGHT_RECENCY * recency +
    RANK_WEIGHT_NICHE * obscurity;

  // Fold in the learned posterior as a bounded, re-clamped multiplier.
  const learned = clamp01(base * learnedCredibilityMultiplier(inputs.learnedCredibility));

  const jitter = explorationWeight * rng();
  return learned + jitter;
}

/**
 * Filter rows to unconsumed (fresh) ones, then select the top-`target` by a
 * caller-supplied combined score (descending). Falls back to input order when
 * `adaptive` is false (preserves the legacy raw-popularity selection).
 *
 * Returns the selected rows in ranked order plus their ids. Pure given `score`.
 */
export function selectRanked<T>(
  rows: readonly T[],
  consumed: ReadonlySet<string>,
  idExtractor: (row: T) => string,
  target: number,
  score: (row: T) => number,
  adaptive: boolean,
): { readonly selected: readonly T[]; readonly selectedIds: readonly string[] } {
  const fresh: T[] = [];
  for (const row of rows) {
    if (!consumed.has(idExtractor(row))) fresh.push(row);
  }

  const ordered = adaptive
    ? [...fresh]
        .map((row, i) => ({ row, i, s: score(row) }))
        // Stable: tie-break by original index to keep determinism.
        .sort((a, b) => b.s - a.s || a.i - b.i)
        .map((x) => x.row)
    : fresh;

  const selected = ordered.slice(0, target);
  return { selected, selectedIds: selected.map(idExtractor) };
}

/**
 * Theme-Stratified Intake (Component 3) — derive the stratified bucket key for a
 * collector candidate, honoring the `stratifiedIntake.bucketBy` flag.
 *
 *  - "signalType" (legacy): the exact pre-theme key `${table}:${signalType}` —
 *    spreads the pool across sources and sub-sources only.
 *  - "signalCategory" (default, hybrid): an enriched row (its LLM-extracted
 *    `category` is present and not "unknown") buckets on its THEME,
 *    `${category}:${table}`, so a hot theme can't monopolize the seeds; an
 *    un-enriched row falls back to the legacy source/sub-source key
 *    `${signalType}:${table}` (NOT a single "uncategorized" bucket), so the
 *    un-enriched tail keeps today's source spread until enrichment coverage
 *    grows.
 *
 * Pure and side-effect-free so the key derivation is unit-testable in isolation.
 */
export function stratifiedBucketKey(
  c: { readonly table: string; readonly signalType: string; readonly category: string },
  bucketBy: "signalType" | "signalCategory",
): string {
  if (bucketBy === "signalType") {
    return `${c.table}:${c.signalType}`;
  }
  const enriched = Boolean(c.category) && c.category !== "unknown";
  return enriched ? `${c.category}:${c.table}` : `${c.signalType}:${c.table}`;
}

/**
 * STAGE 1 — quota-based cross-bucket selection. Globally ranks rows by score,
 * then admits them while capping each bucket at `perBucketCap`, until `totalCap`
 * is reached. Anti-starvation: if buckets exhaust before `totalCap`, back-fill
 * the highest-scored deferred rows so the result never shrinks below
 * `min(totalCap, rows.length)`. Pure; mirrors selectDiverseBy's guarantees.
 */
export function selectStratified<T>(
  rows: readonly T[],
  opts: {
    readonly idOf: (row: T) => string;
    readonly bucketOf: (row: T) => string;
    readonly scoreOf: (row: T) => number;
    readonly perBucketCap: number;
    readonly totalCap: number;
  },
): { readonly selected: readonly T[]; readonly selectedIds: readonly string[] } {
  const { idOf, bucketOf, scoreOf, perBucketCap, totalCap } = opts;
  if (totalCap <= 0 || rows.length === 0) return { selected: [], selectedIds: [] };

  // Global rank, stable by original index for determinism.
  const ordered = [...rows]
    .map((row, i) => ({ row, i, s: scoreOf(row) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.row);

  // Compute natural bucket sizes (needed for anti-starvation dominant detection).
  const naturalSizes = new Map<string, number>();
  for (const row of rows) {
    const b = bucketOf(row);
    naturalSizes.set(b, (naturalSizes.get(b) ?? 0) + 1);
  }

  // Find the "dominant" bucket (largest natural pool). Used to prevent the
  // dominant from flooding the backfill phase when alternatives exist.
  let dominantBucket = "";
  let dominantSize = -1;
  for (const [b, size] of naturalSizes) {
    if (size > dominantSize) {
      dominantSize = size;
      dominantBucket = b;
    }
  }
  const hasTrueAlternatives = naturalSizes.size > 1;

  // Build per-bucket queues (highest score first).
  const bucketQueues = new Map<string, T[]>();
  for (const row of ordered) {
    const bucket = bucketOf(row);
    const q = bucketQueues.get(bucket);
    if (q !== undefined) {
      q.push(row);
    } else {
      bucketQueues.set(bucket, [row]);
    }
  }

  // Phase 1 — round-robin across active buckets: in each round take one row per
  // bucket until each bucket hits perBucketCap or is exhausted, or totalCap reached.
  const counts = new Map<string, number>();
  const admitted: T[] = [];

  let anyAdmitted = true;
  while (anyAdmitted && admitted.length < totalCap) {
    anyAdmitted = false;
    // Active = rows left AND under cap. Sort by next-row score desc for determinism.
    const activeBuckets = [...bucketQueues.entries()]
      .filter(([b, q]) => q.length > 0 && (counts.get(b) ?? 0) < perBucketCap)
      .sort((a, b) => {
        const sa = a[1][0] !== undefined ? scoreOf(a[1][0]) : -Infinity;
        const sb = b[1][0] !== undefined ? scoreOf(b[1][0]) : -Infinity;
        return sb - sa;
      });

    for (const [bucket, queue] of activeBuckets) {
      if (admitted.length >= totalCap) break;
      const next = queue.shift();
      if (next === undefined) continue;
      counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
      admitted.push(next);
      anyAdmitted = true;
    }
  }

  // Phase 2 — anti-starvation backfill: fill remaining slots from non-dominant
  // buckets so small alternative pools contribute their full natural rows.
  // When multiple buckets exist the dominant's cap is absolute; when only one
  // bucket exists (no alternatives) backfill from it past the cap to avoid
  // shrinking the output below min(totalCap, rows.length).
  if (admitted.length < totalCap) {
    if (hasTrueAlternatives) {
      // Multi-bucket: fill from every non-dominant bucket's remaining rows.
      const nonDominantRemaining = [...bucketQueues.entries()]
        .filter(([b]) => b !== dominantBucket)
        .flatMap(([, q]) => q)
        .sort((a, b) => scoreOf(b) - scoreOf(a));

      for (const row of nonDominantRemaining) {
        if (admitted.length >= totalCap) break;
        admitted.push(row);
      }
      // Dominant cap is enforced — no further backfill from dominant.
    } else {
      // Single-bucket: backfill from dominant past per-bucket cap.
      const dominantRemaining = bucketQueues.get(dominantBucket) ?? [];
      for (const row of dominantRemaining) {
        if (admitted.length >= totalCap) break;
        admitted.push(row);
      }
    }
  }

  return { selected: admitted, selectedIds: admitted.map(idOf) };
}

// ── Structured-field promotion (best-effort JSON parsing, never throws) ───────

/** Safe JSON parse of a text column to an array; never throws → []. */
export function parseJsonArray<T = unknown>(raw: unknown): readonly T[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw as T[];
  if (typeof raw !== "string") return [];
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "[]") return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/** Extract Product Hunt makers from makers_json (best-effort, never throws). */
export function parseMakers(raw: unknown): readonly CapabilityMaker[] {
  const arr = parseJsonArray<Record<string, unknown>>(raw);
  const makers: CapabilityMaker[] = [];
  for (const m of arr) {
    if (!m || typeof m !== "object") continue;
    const name =
      typeof m.name === "string"
        ? m.name
        : typeof m.username === "string"
          ? m.username
          : "";
    if (!name) continue;
    const handle =
      typeof m.username === "string"
        ? m.username
        : typeof m.handle === "string"
          ? m.handle
          : undefined;
    makers.push(handle ? { name, handle } : { name });
  }
  return makers.slice(0, 5);
}

/** Extract topic/tag labels from topics_json (best-effort). */
export function parseTopics(raw: unknown): readonly string[] {
  const arr = parseJsonArray<unknown>(raw);
  const topics: string[] = [];
  for (const t of arr) {
    if (typeof t === "string" && t.trim()) topics.push(t.trim());
    else if (t && typeof t === "object") {
      const name = (t as Record<string, unknown>).name;
      if (typeof name === "string" && name.trim()) topics.push(name.trim());
    }
  }
  return topics.slice(0, 8);
}

/** Extract top comment texts from top_comments_json (best-effort, trimmed). */
export function parseTopComments(raw: unknown, max = 3): readonly string[] {
  const arr = parseJsonArray<unknown>(raw);
  const out: string[] = [];
  for (const c of arr) {
    let text = "";
    if (typeof c === "string") text = c;
    else if (c && typeof c === "object") {
      const obj = c as Record<string, unknown>;
      const candidate = obj.text ?? obj.content ?? obj.body;
      if (typeof candidate === "string") text = candidate;
    }
    text = text.replace(/\s+/g, " ").trim();
    if (text) out.push(text.slice(0, 240));
    if (out.length >= max) break;
  }
  return out;
}
