/**
 * Per-source credibility weighting (pure, standalone).
 *
 * Computes a single 0..1 weight for a collected row that combines:
 *
 *   1. A STATIC AUTHORITY PRIOR keyed by `source` and an optional `subSource`
 *      granularity. Higher-signal origins (e.g. a YC funding announcement, the
 *      HN front page, a heavily-starred GitHub repo, a reputable news domain)
 *      score higher than generic ones (a random subreddit, an unknown blog).
 *
 *   2. An ENGAGEMENT-PERCENTILE FACTOR — a pure mapping from a row's engagement
 *      metric (HN points, Reddit score, GitHub stars, upvotes, …) to a
 *      normalized 0..1 factor, either against a provided distribution (true
 *      empirical percentile) or via deterministic log-scaling when no
 *      distribution is supplied.
 *
 * The final weight is `authorityPrior × engagementFactor` clamped to [0, 1].
 *
 * This module is intentionally dependency-free and side-effect-free so it can
 * be unit-tested in the fast unit lane and reused by any collector without
 * pulling in config, IO, or the logger. Collectors (a separate phase) consume
 * {@link sourceCredibility}; this file does NOT touch collectors.
 */

/** A collected row's primary origin (matches scraper ids in `available.ts`). */
export type CredibilitySource =
  | "hackernews"
  | "reddit"
  | "github"
  | "github-search"
  | "producthunt"
  | "appstore"
  | "playstore"
  | "x"
  | "news"
  | string;

/**
 * Engagement signal for a single row plus an optional reference distribution.
 *
 * `metric` is the raw engagement count for the row (points, score, stars,
 * upvotes, reviews, …). When `distribution` is provided we compute a true
 * empirical percentile of `metric` within it; otherwise we fall back to a
 * deterministic log-scaling controlled by `logScaleSaturation`.
 */
export interface EngagementInput {
  /** Raw engagement count for this row. Negative values are clamped to 0. */
  readonly metric: number;
  /**
   * Optional reference distribution of comparable engagement values (e.g. the
   * engagement of every row in the same batch / sub-source). When present, the
   * factor is the fraction of the distribution this row meets or exceeds.
   */
  readonly distribution?: readonly number[];
  /**
   * Metric value treated as "saturated" (factor → ~1) under log-scaling when no
   * distribution is given. Defaults to {@link DEFAULT_LOG_SATURATION}.
   */
  readonly logScaleSaturation?: number;
}

/**
 * Static authority priors in [0, 1].
 *
 * Keys are either a bare `source` (the default/baseline prior for that source)
 * or a `source/subSource` granular override. Lookup prefers the most specific
 * `source/subSource` key, then falls back to the bare `source`, then to
 * {@link UNKNOWN_SOURCE_PRIOR}.
 *
 * Rationale for the ordering (documented intentionally):
 *   - `ycombinator/funding` is the single strongest startup-signal we collect.
 *   - HN front-page items clear a high community bar; `ask`/`show` are softer.
 *   - A top / trending GitHub repo is a strong build signal; search results and
 *     long-tail repos are weaker.
 *   - Product Hunt featured launches are curated; the generic feed less so.
 *   - Reputable news domains (reuters, bloomberg, …) outrank generic news,
 *     which outranks an unknown blog.
 *   - A topical/curated subreddit outranks a generic one.
 *   - Raw social (generic X timeline) is the noisiest and sits lowest.
 */
export const AUTHORITY_PRIORS: Readonly<Record<string, number>> = {
  // --- Y Combinator / startup-grade signals ---
  "ycombinator/funding": 0.98,
  "ycombinator/launch": 0.95,
  ycombinator: 0.9,

  // --- Hacker News ---
  "hackernews/front-page": 0.85,
  "hackernews/show": 0.7,
  "hackernews/ask": 0.68,
  "hackernews/new": 0.5,
  hackernews: 0.75,

  // --- GitHub ---
  "github/trending": 0.82,
  "github/top": 0.82,
  "github-search": 0.7,
  github: 0.72,

  // --- Product Hunt ---
  "producthunt/featured": 0.8,
  "producthunt/feed": 0.62,
  producthunt: 0.68,

  // --- News (domain-reputation weighted) ---
  "news/reuters": 0.88,
  "news/bloomberg": 0.88,
  "news/cointelegraph": 0.6,
  "news/cryptopanic": 0.55,
  "news/generic": 0.45,
  "news/blog": 0.35,
  news: 0.5,

  // --- App stores ---
  "appstore/featured": 0.72,
  appstore: 0.6,
  "playstore/featured": 0.68,
  playstore: 0.55,

  // --- Reddit (sub-source = subreddit tier) ---
  "reddit/curated": 0.65,
  "reddit/topical": 0.55,
  "reddit/generic": 0.4,
  reddit: 0.45,

  // --- X / raw social (noisiest) ---
  "x/verified": 0.5,
  "x/timeline": 0.3,
  x: 0.35,
};

/** Prior used when neither `source/subSource` nor `source` is known. */
export const UNKNOWN_SOURCE_PRIOR = 0.3;

/** Default saturation point for log-scaling when no distribution is supplied. */
export const DEFAULT_LOG_SATURATION = 1000;

/** Final credibility weight plus its components, for transparency/logging. */
export interface CredibilityResult {
  /** authorityPrior × engagementFactor, clamped to [0, 1]. */
  readonly weight: number;
  /** The looked-up static authority prior in [0, 1]. */
  readonly authorityPrior: number;
  /** The engagement-percentile / log-scale factor in [0, 1]. */
  readonly engagementFactor: number;
  /** The resolved prior key, for debugging which granularity matched. */
  readonly priorKey: string;
}

/** Clamp a number into the inclusive [0, 1] range. */
function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Normalize a source / sub-source pair into the candidate lookup keys, from
 * most specific to least specific.
 */
function priorKeyCandidates(
  source: string,
  subSource?: string,
): readonly string[] {
  const src = source.trim().toLowerCase();
  const sub = subSource?.trim().toLowerCase();
  if (sub) return [`${src}/${sub}`, src];
  return [src];
}

/**
 * Look up the static authority prior for a source (and optional sub-source).
 *
 * Resolution order: `source/subSource` → `source` → {@link UNKNOWN_SOURCE_PRIOR}.
 *
 * @returns the prior in [0, 1] and the key that matched.
 */
export function authorityPrior(
  source: string,
  subSource?: string,
): { readonly prior: number; readonly key: string } {
  for (const key of priorKeyCandidates(source, subSource)) {
    const value = AUTHORITY_PRIORS[key];
    if (typeof value === "number") {
      return { prior: clamp01(value), key };
    }
  }
  return { prior: UNKNOWN_SOURCE_PRIOR, key: "unknown" };
}

/**
 * Empirical percentile of `metric` within `distribution`: the fraction of
 * distribution values that `metric` meets or exceeds (a `<=`-rank / CDF).
 *
 * Pure and order-independent. An empty distribution yields 0.5 (no info →
 * neutral). Returns a value in [0, 1].
 */
export function engagementPercentile(
  metric: number,
  distribution: readonly number[],
): number {
  if (distribution.length === 0) return 0.5;
  const m = Math.max(0, metric);
  let atOrBelow = 0;
  for (const value of distribution) {
    if (m >= value) atOrBelow += 1;
  }
  return clamp01(atOrBelow / distribution.length);
}

/**
 * Deterministic log-scaling of a raw engagement metric into [0, 1], used when
 * no reference distribution is available.
 *
 * `factor = ln(1 + metric) / ln(1 + saturation)`, clamped. At `metric = 0` the
 * factor is 0; at `metric = saturation` it is 1; growth is sub-linear so a
 * 10× larger count is a modest, diminishing increase — matching how engagement
 * signal saturates in practice.
 */
export function engagementLogScale(
  metric: number,
  saturation: number = DEFAULT_LOG_SATURATION,
): number {
  const m = Math.max(0, metric);
  const sat = Math.max(1, saturation);
  return clamp01(Math.log1p(m) / Math.log1p(sat));
}

/**
 * Compute the engagement factor in [0, 1] for an {@link EngagementInput},
 * preferring a true empirical percentile when a distribution is supplied and
 * falling back to log-scaling otherwise.
 */
export function engagementFactor(input: EngagementInput): number {
  if (input.distribution && input.distribution.length > 0) {
    return engagementPercentile(input.metric, input.distribution);
  }
  return engagementLogScale(input.metric, input.logScaleSaturation);
}

/**
 * Compute a row's source-credibility weight in [0, 1].
 *
 * weight = {@link authorityPrior}(source, subSource) × {@link engagementFactor}.
 *
 * When `engagement` is omitted, the engagement factor defaults to 1 so the
 * weight is purely the authority prior (i.e. credibility is never penalized for
 * missing engagement data — it simply isn't boosted).
 *
 * Always returns a finite number in [0, 1]; never throws.
 *
 * @param source     Primary origin (scraper id), e.g. "hackernews", "reddit".
 * @param subSource  Optional granularity, e.g. "front-page", "funding",
 *                   "generic", a news domain, or a subreddit tier.
 * @param engagement Optional engagement signal + reference distribution.
 */
export function sourceCredibility(
  source: string,
  subSource?: string,
  engagement?: EngagementInput,
): CredibilityResult {
  const { prior, key } = authorityPrior(source, subSource);
  const factor = engagement ? engagementFactor(engagement) : 1;
  const weight = clamp01(prior * factor);
  return {
    weight,
    authorityPrior: prior,
    engagementFactor: clamp01(factor),
    priorKey: key,
  };
}
