/**
 * WITHIN-RUN diversity / monoculture guard for the idea funnel (PURE).
 *
 * The de-bias layers + the competability gate can over-correct and collapse a
 * run's kept set into a single archetype/category (e.g. only B2B dev/vertical
 * SaaS). This module measures that collapse (a per-run diversity METRIC) and
 * applies a SOFT GUARD so no single bucket dominates the selected set.
 *
 * It COMPLEMENTS the across-run `saturatedThemes` n-gram dedup in
 * `pipeline-context.ts` (which prevents repeating themes ACROSS runs) — this is
 * a WITHIN-run spread guard and does not touch that.
 *
 * Everything here is PURE, immutable, deterministic (NO Date.now / Math.random),
 * and free of I/O. Structured logging happens at the wiring points (pipeline.ts
 * and sige/cross-write.ts), not here.
 *
 * Mirrors the `enforceSegmentSpread` / `summarizeSegmentSpread` structure from
 * `pipeline-sige-math.ts`: greedy per-bucket cap with anti-starvation back-fill.
 */

import type { GeneratedIdeaCandidate } from "./types";

// ── Named constants (no magic numbers) ───────────────────────────────────────

/** Bucket label for candidates whose `archetype` is undefined. */
export const UNKNOWN_BUCKET = "unknown";

/** Default share ceiling any single bucket may occupy in the selected set. */
export const DEFAULT_MAX_BUCKET_SHARE = 0.5;

/** Default bucketing key when none is supplied. */
export const DEFAULT_BUCKET_BY: DiversityBucketKey = "archetype";

/**
 * Default share ceiling any single SOURCE SIGNAL (seed) may occupy in the kept
 * set. ~0.34 => one signal may seed at most ⌈maxIdeas·0.34⌉ ideas (e.g. 2 of 5,
 * 3 of 8), so no single seed can spawn a majority of "reskins".
 */
export const DEFAULT_MAX_SIGNAL_SHARE = 0.34;

/** Minimum per-bucket cap — every present bucket may always keep at least 1. */
const MIN_BUCKET_CAP = 1;

/** Lower/upper clamp bounds for a share fraction. */
const MIN_SHARE = 0;
const MAX_SHARE = 1;

// ── Types ─────────────────────────────────────────────────────────────────────

/** Which candidate field is used to derive a diversity bucket. */
export type DiversityBucketKey = "archetype" | "category";

/**
 * PURE per-run diversity report. Archetype AND category metrics are ALWAYS
 * computed (so a single log/summary can carry both), while `bucketBy`,
 * `counts`, `dominantBucket`, `dominantShare` and `entropy` reflect the chosen
 * bucketing key. Entropy is Shannon entropy in BITS (log base 2).
 */
export interface DiversityReport {
  readonly total: number;
  /** The bucketing key the chosen-bucket fields below reflect. */
  readonly bucketBy: DiversityBucketKey;
  /** bucket label → count, for the chosen `bucketBy`. */
  readonly counts: Readonly<Record<string, number>>;
  /** Number of distinct buckets under the chosen `bucketBy`. */
  readonly distinctBuckets: number;
  /** Largest bucket label under the chosen `bucketBy` ("" when total === 0). */
  readonly dominantBucket: string;
  /** Fraction (0..1) of total in the largest chosen bucket; 0 when total === 0. */
  readonly dominantShare: number;
  /** Shannon entropy in BITS over the chosen-bucket distribution; 0 when total === 0 or single bucket. */
  readonly entropy: number;
  /** Shannon entropy (BITS) over the ARCHETYPE distribution. */
  readonly archetypeEntropy: number;
  /** Shannon entropy (BITS) over the CATEGORY distribution. */
  readonly categoryEntropy: number;
  readonly distinctArchetypes: number;
  readonly distinctCategories: number;
  /** Largest archetype bucket ("" when total === 0). */
  readonly dominantArchetype: string;
  /** Fraction (0..1) of total in the largest archetype bucket; 0 when total === 0. */
  readonly dominantArchetypeShare: number;
  /**
   * Largest SOURCE-SIGNAL bucket (seed) backing the kept set — the single signal
   * cited by the most ideas. "" when no idea carries a signal key. A single idea
   * can cite MANY signals, so signal counts are membership counts (an idea adds 1
   * to EACH signal it cites), and `dominantSignalShare` can exceed any archetype
   * share even when archetypes look diverse — this is the "one seed, many
   * reskins" axis the signal guard caps.
   */
  readonly dominantSignal: string;
  /** Fraction (0..1) of total ideas citing the dominant signal; 0 when total === 0. */
  readonly dominantSignalShare: number;
  /** Number of distinct source signals cited across the kept set. */
  readonly distinctSignals: number;
}

/** Options for {@link computeDiversityReport}. */
export interface DiversityReportOptions {
  /** Which candidate field drives the chosen-bucket fields. Default archetype. */
  readonly bucketBy?: DiversityBucketKey;
  /**
   * Override for how the CHOSEN bucket is derived per candidate (SIGE path:
   * resolve the bucket from idea text). Falls back to the archetype/category
   * field reader when absent.
   */
  readonly resolveBucket?: (candidate: GeneratedIdeaCandidate) => string;
  /**
   * Override for how a candidate's source-signal key SET is derived (for the
   * dominant-signal metrics). Falls back to {@link resolveSeedBuckets}.
   */
  readonly resolveSignalKeys?: (candidate: GeneratedIdeaCandidate) => readonly string[];
}

/** Options for {@link selectDiverse}. */
export interface DiverseSelectionOptions {
  readonly maxIdeas: number;
  /** Share ceiling (0..1) any one bucket may occupy in the kept set. */
  readonly maxBucketShare: number;
  readonly bucketBy: DiversityBucketKey;
  /** Override bucket resolver (SIGE path). Falls back to bucketBy field reader. */
  readonly resolveBucket?: (candidate: GeneratedIdeaCandidate) => string;
}

/** Options for the generic {@link selectDiverseBy}. */
export interface DiverseSelectionByOptions<T> {
  readonly maxIdeas: number;
  /** Share ceiling (0..1) any one bucket may occupy in the kept set. */
  readonly maxBucketShare: number;
  /** REQUIRED bucket resolver for the generic path. */
  readonly resolveBucket: (item: T) => string;
}

/**
 * Options for the SET-membership selector {@link selectDiverseByKeys}. Unlike
 * {@link selectDiverseBy} (one bucket per item), each item belongs to a SET of
 * keys (e.g. the source signals an idea cites). An item is admitted only when
 * EVERY one of its keys is still under the per-key cap; otherwise it is deferred.
 */
export interface DiverseSelectionByKeysOptions<T> {
  readonly maxIdeas: number;
  /**
   * Share ceiling (0..1) any single key may occupy. The per-key cap is
   * `max(1, ceil(maxIdeas · clamp(maxKeyShare)))`.
   */
  readonly maxKeyShare: number;
  /**
   * REQUIRED resolver returning the set of keys for an item. An item with NO
   * keys is unconstrained (it can never push a key over cap) and is always
   * admitted in input order.
   */
  readonly resolveKeys: (item: T) => readonly string[];
}

/** Options for the candidate-typed signal guard {@link selectDiverseBySignals}. */
export interface DiverseSignalSelectionOptions {
  readonly maxIdeas: number;
  /** Share ceiling (0..1) any single source signal may occupy. */
  readonly maxSignalShare: number;
  /**
   * Override for how a candidate's signal-key SET is derived. Falls back to
   * {@link resolveSeedBuckets} (supportingSignalIds → trendIntersection
   * fingerprint → segment).
   */
  readonly resolveKeys?: (candidate: GeneratedIdeaCandidate) => readonly string[];
}

// ── Bucket resolvers ──────────────────────────────────────────────────────────

/** Clamp a share fraction into [0, 1]; NaN falls back to the safe default. */
function clampShare(share: number): number {
  if (Number.isNaN(share)) return DEFAULT_MAX_BUCKET_SHARE;
  return Math.min(MAX_SHARE, Math.max(MIN_SHARE, share));
}

/**
 * The DEFAULT candidate bucket reader: `archetype` (→ {@link UNKNOWN_BUCKET}
 * when undefined) or `category`. PURE.
 */
export function defaultResolveBucket(
  bucketBy: DiversityBucketKey,
): (candidate: GeneratedIdeaCandidate) => string {
  if (bucketBy === "archetype") {
    return (candidate) => candidate.archetype ?? UNKNOWN_BUCKET;
  }
  return (candidate) => candidate.category;
}

/** Structural words from the "Trending X + Pain Y + Capability Z" anchor template. */
const ANCHOR_STOP_TOKENS: ReadonlySet<string> = new Set([
  "and",
  "the",
  "for",
  "with",
  "trending",
  "trend",
  "pain",
  "capability",
  "intersection",
]);

/**
 * Normalize a free-text anchor (`trendIntersection`) into a STABLE token-set
 * fingerprint so near-identical anchors collapse to the same key: lowercased,
 * non-alphanumeric stripped to spaces, short/noise tokens dropped, deduped, and
 * SORTED (order-independent). Returns "" for an empty/all-noise anchor. PURE.
 */
export function normalizeAnchorFingerprint(anchor: string): string {
  const tokens = anchor
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    // Keep tokens of length ≥ 2 so meaningful domain acronyms (ai, ar, vr, ml)
    // survive; only single-char noise and the template stop-words are dropped.
    .filter((t) => t.length >= 2 && !ANCHOR_STOP_TOKENS.has(t));
  if (tokens.length === 0) return "";
  return [...new Set(tokens)].sort().join(" ");
}

/**
 * Derive a candidate's SOURCE-SIGNAL key SET for the seed/reskin guard. PURE.
 *
 * Preference order (per the fix-#3 spec):
 *   1. Cited source signals (`supportingSignalIds`) — the most accurate seed
 *      identity. Lowercased + deduped; an idea citing N signals contributes to
 *      all N keys, so the overlap cap correctly handles multi-signal membership.
 *   2. Normalized `trendIntersection` fingerprint — collapses near-identical
 *      anchors when no signal ids are present (e.g. the SIGE path strips them).
 *   3. `segment` — coarsest fallback so the guard still has SOME axis.
 *
 * Returns `[]` when none of the above yields a key; such a candidate is
 * unconstrained by the signal guard (it cannot dominate any signal bucket).
 */
export function resolveSeedBuckets(candidate: GeneratedIdeaCandidate): readonly string[] {
  const cited = candidate.supportingSignalIds ?? [];
  if (cited.length > 0) {
    const keys = new Set<string>();
    for (const raw of cited) {
      const key = raw.trim().toLowerCase();
      if (key.length > 0) keys.add(`sig:${key}`);
    }
    if (keys.size > 0) return [...keys];
  }

  const fingerprint = normalizeAnchorFingerprint(candidate.trendIntersection);
  if (fingerprint.length > 0) return [`anchor:${fingerprint}`];

  const segment = candidate.segment?.trim();
  if (segment !== undefined && segment.length > 0) return [`seg:${segment.toLowerCase()}`];

  return [];
}

// ── Metric: entropy + distribution ─────────────────────────────────────────────

/** Tally a distribution from items via a bucket resolver. PURE. */
function tally<T>(items: readonly T[], resolveBucket: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const bucket = resolveBucket(item);
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  return counts;
}

/**
 * Tally a SET-membership distribution: each item contributes 1 to EACH of its
 * keys (so the same item lands in multiple buckets). PURE.
 */
function tallyKeys<T>(
  items: readonly T[],
  resolveKeys: (item: T) => readonly string[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const key of new Set(resolveKeys(item))) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Shannon entropy in BITS (`-Σ p_i·log2(p_i)`) over a distribution.
 * 0 when total === 0 or a single bucket holds everything. PURE.
 */
function shannonEntropyBits(counts: ReadonlyMap<string, number>, total: number): number {
  if (total <= 0 || counts.size <= 1) return 0;
  let entropy = 0;
  for (const count of counts.values()) {
    if (count <= 0) continue;
    const p = count / total;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** Largest bucket (label + count) — ties keep the first-seen (insertion-order) label. PURE. */
function dominant(counts: ReadonlyMap<string, number>): {
  readonly label: string;
  readonly count: number;
} {
  let label = "";
  let count = 0;
  for (const [bucket, n] of counts) {
    if (n > count) {
      count = n;
      label = bucket;
    }
  }
  return { label, count };
}

/**
 * Compute the PURE per-run {@link DiversityReport}. Archetype and category
 * metrics are computed regardless of `bucketBy`; the chosen-bucket fields use
 * `bucketBy` (and `resolveBucket` when supplied — the SIGE path overrides how a
 * bucket is derived from idea text). All-unknown archetypes collapse to a single
 * bucket with entropy 0; empty pool yields total 0, entropy 0, dominantShare 0.
 */
export function computeDiversityReport(
  candidates: readonly GeneratedIdeaCandidate[],
  opts: DiversityReportOptions = {},
): DiversityReport {
  const bucketBy = opts.bucketBy ?? DEFAULT_BUCKET_BY;
  const total = candidates.length;

  // Chosen-bucket distribution (resolver override wins).
  const chosenResolver = opts.resolveBucket ?? defaultResolveBucket(bucketBy);
  const chosenCounts = tally(candidates, chosenResolver);
  const chosenDominant = dominant(chosenCounts);

  // Archetype + category distributions (always, via field readers).
  const archetypeCounts = tally(candidates, defaultResolveBucket("archetype"));
  const categoryCounts = tally(candidates, defaultResolveBucket("category"));
  const archetypeDominant = dominant(archetypeCounts);

  // Source-signal (seed) SET-membership distribution — the "one seed, many
  // reskins" axis. resolveSeedBuckets unless an override is supplied.
  const signalResolver = opts.resolveSignalKeys ?? resolveSeedBuckets;
  const signalCounts = tallyKeys(candidates, signalResolver);
  const signalDominant = dominant(signalCounts);

  return {
    total,
    bucketBy,
    counts: Object.fromEntries(chosenCounts),
    distinctBuckets: chosenCounts.size,
    dominantBucket: chosenDominant.label,
    dominantShare: total > 0 ? chosenDominant.count / total : 0,
    entropy: shannonEntropyBits(chosenCounts, total),
    archetypeEntropy: shannonEntropyBits(archetypeCounts, total),
    categoryEntropy: shannonEntropyBits(categoryCounts, total),
    distinctArchetypes: archetypeCounts.size,
    distinctCategories: categoryCounts.size,
    dominantArchetype: archetypeDominant.label,
    dominantArchetypeShare: total > 0 ? archetypeDominant.count / total : 0,
    dominantSignal: signalDominant.label,
    dominantSignalShare: total > 0 ? signalDominant.count / total : 0,
    distinctSignals: signalCounts.size,
  };
}

// ── Selector: greedy per-bucket cap + anti-starvation back-fill ─────────────────

/**
 * GENERIC greedy diversity selector. Walks `items` in INPUT (quality) order,
 * admitting while the item's bucket is under the per-bucket cap, deferring
 * otherwise. Then ANTI-STARVATION back-fills from the deferred list, in
 * original order, until the output length reaches `min(maxIdeas, items.length)`.
 *
 * INVARIANT: when `maxIdeas > 0`, the returned length EQUALS
 * `min(maxIdeas, items.length)` — NEVER fewer (no starvation); the dominant
 * bucket fills remaining slots when no alternatives exist. Fully deterministic;
 * tie-break is input order, stable. Does NOT mutate the input.
 *
 * Edge cases: `maxIdeas <= 0` → []; `items.length <= maxIdeas` → `[...items]`
 * (tiny pools are returned whole, never over-constrained below pool size).
 *
 * Per-bucket cap = `max(1, ceil(maxIdeas · clamp(maxBucketShare)))`.
 */
export function selectDiverseBy<T>(
  items: readonly T[],
  options: DiverseSelectionByOptions<T>,
): readonly T[] {
  const { maxIdeas, resolveBucket } = options;
  if (maxIdeas <= 0) return [];
  if (items.length <= maxIdeas) return [...items];

  const share = clampShare(options.maxBucketShare);
  const perBucketCap = Math.max(MIN_BUCKET_CAP, Math.ceil(maxIdeas * share));

  const counts = new Map<string, number>();
  const admitted: T[] = [];
  const deferred: T[] = [];

  for (const item of items) {
    if (admitted.length >= maxIdeas) break;
    const bucket = resolveBucket(item);
    const used = counts.get(bucket) ?? 0;
    if (used < perBucketCap) {
      counts.set(bucket, used + 1);
      admitted.push(item);
    } else {
      deferred.push(item);
    }
  }

  // Anti-starvation: back-fill remaining slots with the highest-quality
  // deferred items so a tight cap never shrinks the output below the slice size.
  if (admitted.length < maxIdeas) {
    for (const item of deferred) {
      if (admitted.length >= maxIdeas) break;
      admitted.push(item);
    }
  }

  return admitted;
}

/**
 * Candidate-typed diversity selector. Delegates to {@link selectDiverseBy} with
 * the archetype/category field resolver (or the supplied `resolveBucket`
 * override). Same anti-starvation invariant + edge cases.
 */
export function selectDiverse(
  rankedCandidates: readonly GeneratedIdeaCandidate[],
  options: DiverseSelectionOptions,
): readonly GeneratedIdeaCandidate[] {
  const resolveBucket = options.resolveBucket ?? defaultResolveBucket(options.bucketBy);
  return selectDiverseBy(rankedCandidates, {
    maxIdeas: options.maxIdeas,
    maxBucketShare: options.maxBucketShare,
    resolveBucket,
  });
}

// ── Signal-overlap selector: SET-membership cap + anti-starvation back-fill ─────

/**
 * GENERIC SET-MEMBERSHIP diversity selector — the seed/reskin guard. Each item
 * belongs to a SET of keys (the source signals it cites). Walks `items` in INPUT
 * (quality) order, admitting an item only when EVERY one of its keys is still
 * under the per-key cap (so a single signal can't seed more than the cap), and
 * deferring it otherwise. Admitting an item then increments ALL of its keys.
 * Items with NO keys are unconstrained and admitted in order.
 *
 * Then ANTI-STARVATION back-fills from the deferred list, in original (quality)
 * order, until the output reaches `min(maxIdeas, items.length)`.
 *
 * INVARIANT: when `maxIdeas > 0`, the returned length EQUALS
 * `min(maxIdeas, items.length)` — NEVER fewer. Fully deterministic; tie-break is
 * input order, stable. Does NOT mutate the input.
 *
 * Edge cases: `maxIdeas <= 0` → []; `items.length <= maxIdeas` → `[...items]`.
 *
 * Per-key cap = `max(1, ceil(maxIdeas · clamp(maxKeyShare)))`.
 */
export function selectDiverseByKeys<T>(
  items: readonly T[],
  options: DiverseSelectionByKeysOptions<T>,
): readonly T[] {
  const { maxIdeas, resolveKeys } = options;
  if (maxIdeas <= 0) return [];
  if (items.length <= maxIdeas) return [...items];

  const share = clampShare(options.maxKeyShare);
  const perKeyCap = Math.max(MIN_BUCKET_CAP, Math.ceil(maxIdeas * share));

  const counts = new Map<string, number>();
  const admitted: T[] = [];
  const deferred: T[] = [];

  for (const item of items) {
    if (admitted.length >= maxIdeas) break;
    const keys = [...new Set(resolveKeys(item))];
    const overCap = keys.some((k) => (counts.get(k) ?? 0) >= perKeyCap);
    if (overCap) {
      deferred.push(item);
      continue;
    }
    for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
    admitted.push(item);
  }

  // Anti-starvation: back-fill remaining slots with the highest-quality deferred
  // items so a tight cap never shrinks the output below the slice size.
  if (admitted.length < maxIdeas) {
    for (const item of deferred) {
      if (admitted.length >= maxIdeas) break;
      admitted.push(item);
    }
  }

  return admitted;
}

/**
 * Candidate-typed signal/seed guard. Delegates to {@link selectDiverseByKeys}
 * with {@link resolveSeedBuckets} (or the supplied `resolveKeys` override) so no
 * single source signal can seed more than its share of the kept set. COMPOSES
 * WITH (does not replace) {@link selectDiverse}: apply the archetype/category
 * guard first, then this guard on its output. Same anti-starvation invariant.
 */
export function selectDiverseBySignals(
  rankedCandidates: readonly GeneratedIdeaCandidate[],
  options: DiverseSignalSelectionOptions,
): readonly GeneratedIdeaCandidate[] {
  return selectDiverseByKeys(rankedCandidates, {
    maxIdeas: options.maxIdeas,
    maxKeyShare: options.maxSignalShare,
    resolveKeys: options.resolveKeys ?? resolveSeedBuckets,
  });
}
