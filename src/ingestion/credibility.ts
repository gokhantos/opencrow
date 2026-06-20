/**
 * Deterministic credibility scoring for ingested content.
 *
 * Gives the graph agent a cheap, deterministic signal about how much to weight a
 * memory relative to others from the same project. NOT a full quality classifier
 * — just a sensible ordering proxy.
 */

/**
 * Per-source credibility signals passed to computeCredibility.
 *
 * Only include the fields that are meaningful for a given source; all are
 * optional so callers can pass a minimal object and the heuristic degrades
 * gracefully to a source-type floor.
 */
export interface CredibilityInputs {
  /** Source type string — used to select the right heuristic. */
  readonly source_type: string;
  /**
   * App-store/Play-store star rating (1–5).
   * Extreme ratings (1★ or 5★) carry higher signal than mid-range.
   */
  readonly rating?: number;
  /**
   * Play Store "thumbs-up" count on a review.
   * More upvotes → higher credibility, soft-capped at 100.
   */
  readonly thumbs_up?: number;
  /**
   * Reddit score (upvotes − downvotes). High positive scores indicate
   * community-validated content; capped at 500 for normalisation.
   */
  readonly score?: number;
  /**
   * Comment count (Reddit / HN). Engagement signals relevance.
   * Soft-capped at 200.
   */
  readonly num_comments?: number;
  /**
   * Product Hunt / HN points. Soft-capped at 500.
   */
  readonly points?: number;
  /**
   * Play Store install count string (e.g. "1,000,000+").
   * Higher installs → app is well-established → metadata is trustworthy.
   */
  readonly installs?: string | null;
}

/**
 * Parse a Play Store installs string ("1,000,000+", "500K+", etc.) into a
 * raw number. Returns 0 on parse failure so the heuristic degrades safely.
 */
export function parseInstalls(installs: string | null | undefined): number {
  if (!installs) return 0;
  // Remove commas, "+" suffix, and normalise K/M shorthand
  const clean = installs.replace(/,/g, "").replace(/\+$/, "").trim().toUpperCase();
  if (clean.endsWith("M")) return Number.parseFloat(clean) * 1_000_000;
  if (clean.endsWith("K")) return Number.parseFloat(clean) * 1_000;
  const n = Number.parseFloat(clean);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Clamp a value to [0, 1].
 */
export function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * Compute a credibility score in [0, 1] for a piece of ingested content.
 *
 * Heuristics (all clamped to [0, 1]):
 *
 * - appstore_review / playstore_review
 *     Floor 0.5 (it is a verified purchase, not anonymous noise).
 *     Extreme ratings (1★, 2★ or 5★) are higher signal than mid-range
 *     because the ingestion gate already filters to ≤2★, so we amplify by
 *     proximity to 1★.  A 1★ review ⇒ 1.0, a 2★ ⇒ 0.75.
 *     For Play Store: thumbs_up count adds up to +0.2 (capped at 100 upvotes).
 *
 * - reddit_post
 *     Score and engagement both contribute.  Score/500 (soft cap) contributes
 *     up to 0.6; num_comments/200 contributes up to 0.4.  Floor 0.15.
 *
 * - producthunt
 *     votes_count/500 (soft cap) contributes up to 0.8.  Floor 0.2.
 *
 * - hackernews
 *     points/500 (soft cap) contributes up to 0.7; num_comments/200 up to
 *     0.3.  Floor 0.2.
 *
 * - news_article
 *     Fixed 0.6 — editorial content is generally credible but varies by
 *     source; we do not have a source-rank list, so a mid-high floor is
 *     appropriate.
 *
 * - appstore_app / playstore_app
 *     App listings are factual (name, category, description).
 *     For Play Store apps: installs parsed to a count drives up to 0.8 (soft
 *     cap 10M+); app rating drives up to 0.2 (5★ max).  Floor 0.3.
 *     For App Store apps: fixed 0.5 (no install count available).
 */
export function computeCredibility(inputs: CredibilityInputs): number {
  const { source_type } = inputs;

  switch (source_type) {
    case "appstore_review": {
      // 1★ → 1.0, 2★ → 0.75, 3★ → 0.5, higher → 0.5 floor
      const rating = inputs.rating ?? 3;
      const ratingScore = rating <= 1 ? 1.0 : rating <= 2 ? 0.75 : 0.5;
      return clamp01(ratingScore);
    }

    case "playstore_review": {
      // Same star heuristic as App Store, plus thumbs_up bonus.
      const rating = inputs.rating ?? 3;
      const ratingScore = rating <= 1 ? 1.0 : rating <= 2 ? 0.75 : 0.5;
      const thumbsBonus = Math.min((inputs.thumbs_up ?? 0) / 100, 1) * 0.2;
      return clamp01(ratingScore + thumbsBonus);
    }

    case "reddit_post": {
      const scoreComponent = Math.min(Math.max(inputs.score ?? 0, 0) / 500, 1) * 0.6;
      const engagementComponent = Math.min((inputs.num_comments ?? 0) / 200, 1) * 0.4;
      return clamp01(Math.max(0.15, scoreComponent + engagementComponent));
    }

    case "producthunt": {
      const pts = inputs.points ?? 0;
      // 0 → 0.2 floor; 500 → 0.8 (soft cap); 1000 → 1.0 (hard cap).
      const base = Math.min(pts / 500, 1) * 0.8;
      const bonus = pts > 500 ? Math.min((pts - 500) / 500, 1) * 0.2 : 0;
      return clamp01(Math.max(0.2, base + bonus));
    }

    case "hackernews": {
      const pointsComponent = Math.min(Math.max(inputs.points ?? 0, 0) / 500, 1) * 0.7;
      const engagementComponent = Math.min((inputs.num_comments ?? 0) / 200, 1) * 0.3;
      return clamp01(Math.max(0.2, pointsComponent + engagementComponent));
    }

    case "news_article": {
      // Editorial content — mid-high fixed floor; no per-row signal available.
      return 0.6;
    }

    case "appstore_app": {
      // Factual listing with no install/rating signal; conservative mid-point.
      return 0.5;
    }

    case "playstore_app": {
      // Installs are the strongest signal; app rating contributes a small bonus.
      const installCount = parseInstalls(inputs.installs);
      const installsComponent = Math.min(installCount / 10_000_000, 1) * 0.8;
      const ratingComponent = Math.min((inputs.rating ?? 0) / 5, 1) * 0.2;
      return clamp01(Math.max(0.3, installsComponent + ratingComponent));
    }

    default: {
      // Unknown source type — conservative default.
      return 0.4;
    }
  }
}
