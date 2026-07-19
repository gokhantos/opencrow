// Newborn-velocity screener: flags App Store keywords crossing the validated
// "window-opening signature" — the shape of a market moments before it takes
// off, so an emerging opportunity is caught at month 1 instead of found
// manually. Runs AFTER the existing keyword-gap scanner's scan batches (see
// `scraper.ts`), reading the scans it already wrote (`appstore_keyword_scans`,
// migration 037) rather than fetching anything itself.
//
// Split like `keyword-scoring.ts` / `keyword-gaps.ts`: `computeSignature` is a
// PURE function (no I/O, no Date, no Math.random) so the signature logic is
// exhaustively unit-testable in isolation; `runScreener` is the thin
// orchestration shell that pulls candidates + persists hits via
// `signature-hits-store.ts`.
//
// Signature validated 2026-07-19 against real scan history: it retro-detects
// the two best manually-found opportunities this cycle turned up —
// "peptide tracker" (a comp-44.5-era analog of this signature) and
// "block shorts" (competitiveness 10.7, velocity ratio 4.88) — while staying
// selective against the rest of the ~100k-keyword corpus.

import { createLogger } from "../../logger";
import { isJunkKeyword } from "./keyword-junk";
import type { GapTrend, TopApp } from "./keyword-types";
import {
  getScreenerCandidates,
  upsertSignatureHit,
  type ScreenerCandidate,
} from "./signature-hits-store";

const log = createLogger("appstore:keyword-screener");

// ---------------------------------------------------------------------------
// Signature thresholds — named + commented per the validated design. Changing
// any of these changes what "hits" going forward; they are NOT re-tuned
// automatically from corpus stats.
// ---------------------------------------------------------------------------

/** Gate 1: field must not already be crowded. */
export const COMPETITIVENESS_MAX = 35;

/** Gate 2: demand must be measurably rising, not merely stable. */
export const REQUIRED_TREND: GapTrend = "heating";

/**
 * A "newcomer" app is younger than this (days) — roughly 18 months. Below
 * this age an app is still plausibly riding an early growth curve rather
 * than having settled into its steady-state velocity.
 */
export const NEWCOMER_AGE_DAYS_MAX = 540;

/**
 * A newcomer only counts toward the signature if it is already gaining
 * reviews at more than this rate (ratings/day) — filters out newcomers that
 * are simply new, not actually gaining traction.
 */
export const NEWCOMER_MIN_RATINGS_PER_DAY = 1;

/** Gate 3: at least this many qualifying newcomers must be in the SERP. */
export const MIN_FAST_NEWCOMERS = 2;

/**
 * Gate 4: newcomers must be gaining reviews at least this many times faster
 * (mean ratings/day) than the established incumbents (`ageDays >=
 * NEWCOMER_AGE_DAYS_MAX`) — the "velocity flip" that marks a genuinely
 * shifting field rather than an already-mature one. Corpus reference (median
 * recentVelocity/ratingsPerDay ~0.60, p90 ~2.76): 1.5x sits well above the
 * corpus's typical spread, and the retro-validated "block shorts" case (ratio
 * 4.88) clears it by a wide margin.
 */
export const VELOCITY_RATIO_MIN = 1.5;

/** An app at or above this age (days) counts as "established" for the ratio's denominator. */
export const ESTABLISHED_AGE_DAYS_MIN = NEWCOMER_AGE_DAYS_MAX;

/** Gate 5: no single app in the SERP may already be this entrenched. */
export const MAX_REVIEWS_CEILING = 120_000;

/** Gate 6: this genre zone is excluded — treated as noise for this signature. */
export const EXCLUDED_GENRE_ZONE = "entertainment";

// ---------------------------------------------------------------------------
// Suppression — the window has already closed. Distinct from the gates above:
// this can veto an otherwise-passing keyword.
// ---------------------------------------------------------------------------

/** An incumbent updated more recently than this (days) reads as actively maintained. */
export const SUPPRESSION_LEADER_MAX_LAST_UPDATED_DAYS = 90;
/** ...and with at least this many reviews... */
export const SUPPRESSION_LEADER_MIN_REVIEWS = 10_000;
/** ...and at least this rating is a "quality incumbent" that has already won the field. */
export const SUPPRESSION_LEADER_MIN_RATING = 4.7;

// ---------------------------------------------------------------------------
// Secondary signal — recorded on every hit, never gates it. Corpus reference:
// median recentVelocity/ratingsPerDay ~0.60, p90 ~2.76 — so a ratio of 4+ is
// a genuine outlier, not corpus noise.
// ---------------------------------------------------------------------------

export const ACCELERATING_MIN_REVIEWS = 100;
export const ACCELERATING_MAX_REVIEWS = 150_000;
export const ACCELERATING_VELOCITY_RATIO_MIN = 4;
export const ACCELERATING_MIN_RECENT_VELOCITY = 5;

// ---------------------------------------------------------------------------
// Pure signature computation
// ---------------------------------------------------------------------------

export interface SignatureScanInput {
  readonly keyword: string;
  readonly competitiveness: number;
  readonly trend: GapTrend;
  readonly topApps: readonly TopApp[];
  /** `null` when the keyword has no corresponding `appstore_keywords` corpus row. */
  readonly genreZone: string | null;
}

export interface SignatureResult {
  /** True iff every gate passes AND the keyword is not suppressed. */
  readonly hit: boolean;
  /** True iff the "window already closed" suppression rule fired. */
  readonly suppressed: boolean;
  /** Count of newcomer apps (ageDays < 540, ratingsPerDay > 1) — gate 3's input. */
  readonly fastNewcomers: number;
  /** Mean ratingsPerDay across the fast newcomers, or `null` if there are none. */
  readonly newcomerRpd: number | null;
  /** Mean ratingsPerDay across established apps (ageDays >= 540), or `null` if there are none. */
  readonly establishedRpd: number | null;
  /**
   * newcomerRpd / establishedRpd, or `null` when the ratio can't be
   * meaningfully expressed (no established baseline, or no newcomers) —
   * never `Infinity`. The GATE still treats a missing/zero established
   * baseline as satisfying the threshold (see `VELOCITY_RATIO_MIN`); this
   * field is purely the recorded value.
   */
  readonly velocityRatio: number | null;
  /** Max `reviews` across the whole SERP. */
  readonly maxReviews: number;
  /** Secondary signal: count of apps accelerating hard (see constants above). Not a gate. */
  readonly acceleratingApps: number;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/**
 * Evaluates the validated window-opening signature against one keyword's
 * latest scan. Pure — no I/O, no Date, no Math.random; every input is a
 * plain value already read from the DB by the caller (`runScreener`).
 */
export function computeSignature(input: SignatureScanInput): SignatureResult {
  const { keyword, competitiveness, trend, topApps, genreZone } = input;

  const newcomers = topApps.filter(
    (a) => a.ageDays < NEWCOMER_AGE_DAYS_MAX && a.ratingsPerDay > NEWCOMER_MIN_RATINGS_PER_DAY,
  );
  const established = topApps.filter((a) => a.ageDays >= ESTABLISHED_AGE_DAYS_MIN);

  const fastNewcomers = newcomers.length;
  const newcomerRpd = mean(newcomers.map((a) => a.ratingsPerDay));
  const establishedRpd = mean(established.map((a) => a.ratingsPerDay));

  // Missing/zero established baseline satisfies the ratio gate (nothing
  // established to be slower than); the recorded ratio VALUE is null in that
  // case rather than Infinity — see `SignatureResult.velocityRatio`.
  const hasUsableBaseline = establishedRpd !== null && establishedRpd > 0;
  const velocityRatio =
    hasUsableBaseline && newcomerRpd !== null
      ? newcomerRpd / (establishedRpd as number)
      : null;
  const ratioGatePass = !hasUsableBaseline || (velocityRatio !== null && velocityRatio >= VELOCITY_RATIO_MIN);

  const maxReviews = topApps.reduce((max, a) => Math.max(max, a.reviews), 0);

  const acceleratingApps = topApps.filter((a) => {
    if (a.recentVelocity === undefined) return false;
    if (a.reviews < ACCELERATING_MIN_REVIEWS || a.reviews > ACCELERATING_MAX_REVIEWS) return false;
    if (a.recentVelocity < ACCELERATING_MIN_RECENT_VELOCITY) return false;
    if (a.ratingsPerDay <= 0) return false;
    return a.recentVelocity / a.ratingsPerDay >= ACCELERATING_VELOCITY_RATIO_MIN;
  }).length;

  const suppressed = topApps.some(
    (a) =>
      a.lastUpdatedDays !== undefined &&
      a.lastUpdatedDays < SUPPRESSION_LEADER_MAX_LAST_UPDATED_DAYS &&
      a.reviews >= SUPPRESSION_LEADER_MIN_REVIEWS &&
      a.rating >= SUPPRESSION_LEADER_MIN_RATING,
  );

  const genreZoneOk = (genreZone ?? "").trim().toLowerCase() !== EXCLUDED_GENRE_ZONE;

  const gatesPass =
    competitiveness <= COMPETITIVENESS_MAX &&
    trend === REQUIRED_TREND &&
    fastNewcomers >= MIN_FAST_NEWCOMERS &&
    ratioGatePass &&
    maxReviews < MAX_REVIEWS_CEILING &&
    genreZoneOk &&
    !isJunkKeyword(keyword);

  return {
    hit: gatesPass && !suppressed,
    suppressed,
    fastNewcomers,
    newcomerRpd,
    establishedRpd,
    velocityRatio,
    maxReviews,
    acceleratingApps,
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface RunScreenerResult {
  /** Total candidates evaluated (post SQL prefilter — see `getScreenerCandidates`). */
  readonly evaluated: number;
  /** Count of keywords that hit the signature this run (new + re-hits). */
  readonly hits: number;
  /** Subset of `hits` that are genuinely NEW (first time ever hitting). */
  readonly newHits: number;
  readonly newHitKeywords: readonly string[];
}

function toUpsertInput(candidate: ScreenerCandidate, signature: SignatureResult) {
  return {
    keyword: candidate.keyword,
    competitiveness: candidate.competitiveness,
    demand: candidate.demand,
    trend: candidate.trend,
    newcomerRpd: signature.newcomerRpd,
    establishedRpd: signature.establishedRpd,
    velocityRatio: signature.velocityRatio,
    fastNewcomers: signature.fastNewcomers,
    acceleratingApps: signature.acceleratingApps,
    maxReviews: signature.maxReviews,
    genreZone: candidate.genreZone,
    topApps: candidate.topApps,
  };
}

/**
 * Evaluates the signature against the latest scan of every keyword that
 * clears the cheap SQL prefilter (`getScreenerCandidates`), and upserts a
 * hit row for every keyword whose full signature (including the per-app
 * gates SQL can't cheaply express, and suppression) passes. Never throws for
 * a single bad candidate — a upsert failure is logged and the run continues.
 */
export async function runScreener(): Promise<RunScreenerResult> {
  const candidates = await getScreenerCandidates({
    maxCompetitiveness: COMPETITIVENESS_MAX,
    requiredTrend: REQUIRED_TREND,
    excludedGenreZone: EXCLUDED_GENRE_ZONE,
  });

  const now = Math.floor(Date.now() / 1000);
  let hits = 0;
  let newHits = 0;
  const newHitKeywords: string[] = [];

  for (const candidate of candidates) {
    const signature = computeSignature({
      keyword: candidate.keyword,
      competitiveness: candidate.competitiveness,
      trend: candidate.trend,
      topApps: candidate.topApps,
      genreZone: candidate.genreZone,
    });
    if (!signature.hit) continue;

    hits++;
    try {
      const { isNew } = await upsertSignatureHit(toUpsertInput(candidate, signature), now);
      if (isNew) {
        newHits++;
        newHitKeywords.push(candidate.keyword);
      }
    } catch (err) {
      log.warn("Failed to upsert signature hit — skipping", { keyword: candidate.keyword, error: err });
    }
  }

  log.info("Newborn-velocity screener run complete", {
    evaluated: candidates.length,
    hits,
    newHits,
    newHitKeywords,
  });

  return { evaluated: candidates.length, hits, newHits, newHitKeywords };
}
