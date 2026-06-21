/**
 * Pure quality gate for ingested content — no side effects, no DB.
 */

/** Default minimum trimmed content length to pass the quality gate. */
export const MIN_CONTENT_LENGTH = 40;

/**
 * Minimum credibility score.  Reviews are always ≥0.5 so they are unaffected;
 * this only drops low-engagement Reddit / HN / PH rows.
 */
export const CREDIBILITY_FLOOR = 0.25;

/**
 * Minimum fraction of characters (out of non-space chars) that must be
 * alphabetic.  Catches emoji-/punctuation-only strings like "🥰🥰🥰".
 */
export const ALPHA_RATIO_MIN = 0.45;

/**
 * Positive-sentiment lexicon for the review sentiment filter.
 * Matches whole words (or common emoji) case-insensitively.
 */
const POSITIVE_REVIEW_PATTERN =
  /great|love|excellent|perfect|awesome|amazing|best|wonderful|👍|🥰|❤|😍|good/i;

/**
 * Negative-token guard: presence of ANY of these overrides the positive
 * match and lets the review through (real complaint, keep it).
 *
 * Uses a word-start boundary (\b prefix) but no word-end boundary so that
 * inflected forms are caught ("crashing" → "crash", "failing" → "fail", etc.).
 */
const NEGATIVE_REVIEW_PATTERN =
  /\b(?:not|no|never|bad|crash|broken|worst|terrible|hate|bug|error|doesn't|won't|can't|fail|slow|annoying|scam|useless)/i;

/**
 * Maximum length (chars) at which the short-positive-review filter applies.
 * Longer positive reviews are let through — they likely contain context.
 */
const REVIEW_SENTIMENT_MAX_LEN = 60;

export interface QualityGateResult {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * Pure quality gate — no side effects, no DB.
 *
 * Returns `{ ok: false, reason }` when the content should be dropped;
 * `{ ok: true }` when it should proceed to dedup + mem0.
 *
 * Rejection criteria (in order):
 * 1. Content too short (< minContentLength).
 * 2. Alpha-ratio too low (emoji/punctuation spam).
 * 3. Credibility below floor (zero-engagement community content).
 * 4. Short positive-only review (sourceType is appstore_review / playstore_review,
 *    content ≤ REVIEW_SENTIMENT_MAX_LEN, matches positive lexicon, no negative tokens).
 *
 * `minContentLength` is configurable (config.ingestion.minContentLength) and
 * defaults to MIN_CONTENT_LENGTH for callers (e.g. unit tests) that pass none.
 */
export function passesQualityGate(
  content: string,
  sourceType: string,
  credibility: number,
  minContentLength: number = MIN_CONTENT_LENGTH,
): QualityGateResult {
  const trimmed = content.trim();

  // 1. Length check
  if (trimmed.length < minContentLength) {
    return { ok: false, reason: "content_too_short" };
  }

  // 2. Alphabetic-ratio check
  const nonSpace = trimmed.replace(/\s+/g, "");
  if (nonSpace.length > 0) {
    const alphaCount = (nonSpace.match(/[a-zA-Z]/g) ?? []).length;
    const ratio = alphaCount / nonSpace.length;
    if (ratio < ALPHA_RATIO_MIN) {
      return { ok: false, reason: "alpha_ratio_too_low" };
    }
  }

  // 3. Credibility floor
  if (credibility < CREDIBILITY_FLOOR) {
    return { ok: false, reason: "credibility_below_floor" };
  }

  // 4. Short positive-only review sentiment filter (review sources only)
  if (sourceType === "appstore_review" || sourceType === "playstore_review") {
    if (
      trimmed.length <= REVIEW_SENTIMENT_MAX_LEN &&
      POSITIVE_REVIEW_PATTERN.test(trimmed) &&
      !NEGATIVE_REVIEW_PATTERN.test(trimmed)
    ) {
      return { ok: false, reason: "short_positive_review_no_complaint" };
    }
  }

  return { ok: true };
}
