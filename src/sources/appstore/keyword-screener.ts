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

/**
 * Gate 1: field must not already be crowded.
 *
 * Widened 2026-07-19 from 35 to 50 after backtesting against real GO-grade
 * markets: "peptide tracker" (comp 44.5) and "card grading" (comp 44.0) are
 * both validated GO markets that the 35 bound was rejecting outright, while
 * "block shorts" (comp 10.7) still clears the widened bound with room to
 * spare — 50 recovers the false negatives without materially opening the
 * gate for the bulk of the corpus (competitiveness is heavily right-skewed).
 */
export const COMPETITIVENESS_MAX = 50;

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

// ---------------------------------------------------------------------------
// Alternative qualification path — "single-dominant-newcomer" / the "Yardly
// garage-sale" pattern: ONE newcomer growing fast against an ancient, stale
// incumbent field, rather than >=2 newcomers racing each other. The primary
// path's `MIN_FAST_NEWCOMERS` gate structurally cannot see this shape (a lone
// newcomer never reaches 2), so it was rejecting a real validated GO market
// (Yardly: one modern entrant at 13 ratings/day against a 17-year-old, stale
// incumbent) outright. This path is OR'd with the primary path below — it
// never replaces it — and bypasses the primary path's trend requirement and
// >=2-newcomer count, but still requires an actual established incumbent to
// be measurably slower than the newcomer (no incumbent means there's no
// "garage sale" to detect, so the ratio gate below demands a usable
// baseline). Gates outside competitiveness/trend/newcomer-count (max-reviews
// ceiling, suppression, junk, genre) still apply — see `gatesPass` below.
// ---------------------------------------------------------------------------

/**
 * The lone newcomer must be gaining reviews at least this fast to qualify —
 * deliberately stricter than the primary path's `NEWCOMER_MIN_RATINGS_PER_DAY`
 * (>1) because this path only requires ONE newcomer, so it must be
 * unambiguous, outlier-grade traction rather than merely-not-dead.
 *
 * Tuned 2026-07-19 against the live corpus (86k keywords): an initial floor
 * of 8 alone produced ~900 alt-path hits — root-caused to a broad, GENUINE
 * pattern (large, real incumbents — tens of thousands of reviews — that have
 * simply aged and slowed down, with `ratingsPerDay` mechanically diluted by
 * dividing lifetime reviews by a large `ageDays`), not corpus junk; a
 * materiality check on the established app's review COUNT (as a proxy for
 * "is this a real incumbent") barely moved the count, confirming the excess
 * hits are legitimate signature matches, not noise the ratio math is fooled
 * by. Raising the floor to 12 (this repo's own suggested next rung) cuts the
 * live alt-path count to ~656 while still comfortably admitting the
 * validated Yardly backtest case (13 ratings/day) with headroom — 12 is the
 * tightest reasonable floor that (a) still accepts that backtest case and
 * (b) isn't suspiciously pinned to the exact backtest value. The live count
 * still runs above this task's ~250-300 planning estimate; further
 * tightening would need a different lever (e.g. a genre/quality signal) and
 * is left as a follow-up — see the live-DB run notes in the PR.
 */
export const ALT_SINGLE_NEWCOMER_MIN_RATINGS_PER_DAY = 12;

/**
 * Newcomer/established ratio floor for the alt path. Lower than the primary
 * path's `VELOCITY_RATIO_MIN` (1.5) because the alt path already demands a
 * much higher absolute newcomer velocity
 * (`ALT_SINGLE_NEWCOMER_MIN_RATINGS_PER_DAY`) — the two gates jointly
 * replace the primary path's newcomer-count requirement as the signal that
 * something real is happening.
 */
export const ALT_SINGLE_NEWCOMER_VELOCITY_RATIO_MIN = 1.2;

/**
 * Absolute review-COUNT floor for the alt path's lone newcomer — distinct
 * from its ratings/day floor. Added 2026-07-19 after a live-corpus run of
 * the rpd-only alt path surfaced hundreds of low-substance/foreign-script
 * hits (e.g. a keyword whose "newcomer" had just a handful of reviews but a
 * high rpd purely because it was very young). The real Yardly backtest case
 * had 957 reviews, far above this floor — this only excludes newcomers that
 * are still too thin to represent a real, judged app.
 */
export const ALT_SINGLE_NEWCOMER_MIN_REVIEWS = 150;

/**
 * Minimum scan-level `demand` for the alt path. Reuses the same threshold
 * (5) as the dashboard's "Indie sweet spot" `minDemand` preset (see
 * `opportunities-format.ts`) — the corpus's own established "this keyword
 * has credible search demand" floor — rather than inventing a new one.
 * Added alongside the review-count floor for the same reason: without it,
 * near-zero-demand keywords with a lone fast-but-thin newcomer were passing.
 */
export const ALT_MIN_DEMAND = 5;

/**
 * Minimum established-baseline ratingsPerDay for the alt path's ratio gate.
 * Unlike the primary path (where a missing/zero baseline satisfies the ratio
 * gate — see `ratioGatePass` — because there SHOULD be nothing to be faster
 * than), the alt path's entire premise is "the newcomer is measurably faster
 * than a real, still-standing incumbent". A near-zero denominator (e.g.
 * 0.001 ratings/day) produces astronomical, meaningless ratios (seen live up
 * to 77,264x) that trivially clear any ratio floor regardless of whether the
 * newcomer's own traction is real — this floor guards against that div-by-
 * near-zero blowup by requiring an established baseline that is itself a
 * minimally live app, not a statistically-dead one.
 */
export const ALT_MIN_ESTABLISHED_RPD = 0.2;

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
  /**
   * Scan-level demand (same field the dashboard's `minDemand` filter reads).
   * Only gates the alt (single-dominant-newcomer) path — see `ALT_MIN_DEMAND`.
   */
  readonly demand: number;
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
  const { keyword, competitiveness, trend, demand, topApps, genreZone } = input;

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

  // No alt-path-specific change needed here: suppression only fires for an
  // ACTIVELY MAINTAINED leader (`lastUpdatedDays < 90`). The alt path's
  // "Yardly garage-sale" shape is, by definition, an ANCIENT/STALE incumbent
  // — it structurally can't have a recent `lastUpdatedDays`, so it can never
  // trip this veto. A quality incumbent that genuinely IS still active and
  // winning the field correctly still suppresses both paths.
  const suppressed = topApps.some(
    (a) =>
      a.lastUpdatedDays !== undefined &&
      a.lastUpdatedDays < SUPPRESSION_LEADER_MAX_LAST_UPDATED_DAYS &&
      a.reviews >= SUPPRESSION_LEADER_MIN_REVIEWS &&
      a.rating >= SUPPRESSION_LEADER_MIN_RATING,
  );

  const genreZoneOk = (genreZone ?? "").trim().toLowerCase() !== EXCLUDED_GENRE_ZONE;

  // Primary path: heating trend + >=2 fast newcomers clearly outpacing the
  // established baseline (or no established baseline to outpace at all).
  const primaryPathPass =
    trend === REQUIRED_TREND && fastNewcomers >= MIN_FAST_NEWCOMERS && ratioGatePass;

  // Alternative path: single-dominant-newcomer / "Yardly garage-sale"
  // pattern (see constants above). Requires an ACTUAL established baseline,
  // and a MINIMALLY LIVE one at that (`ALT_MIN_ESTABLISHED_RPD`) — unlike
  // the primary path's `ratioGatePass`, a missing OR near-zero baseline does
  // NOT satisfy this gate, since a near-zero denominator produces
  // meaningless, astronomical ratios (see `ALT_MIN_ESTABLISHED_RPD`'s doc
  // comment) rather than a genuine "field is stalling out" signal. Also
  // requires the lone newcomer to have real review volume
  // (`ALT_SINGLE_NEWCOMER_MIN_REVIEWS`) and the keyword to have credible
  // scan-level demand (`ALT_MIN_DEMAND`) — both added after a live-corpus
  // run of the rpd/ratio-only version surfaced thin, low-substance hits.
  const soleNewcomer = fastNewcomers === 1 ? newcomers[0] : undefined;
  const altPathPass =
    fastNewcomers === 1 &&
    soleNewcomer !== undefined &&
    soleNewcomer.reviews >= ALT_SINGLE_NEWCOMER_MIN_REVIEWS &&
    demand >= ALT_MIN_DEMAND &&
    newcomerRpd !== null &&
    newcomerRpd >= ALT_SINGLE_NEWCOMER_MIN_RATINGS_PER_DAY &&
    establishedRpd !== null &&
    establishedRpd >= ALT_MIN_ESTABLISHED_RPD &&
    velocityRatio !== null &&
    velocityRatio >= ALT_SINGLE_NEWCOMER_VELOCITY_RATIO_MIN;

  const gatesPass =
    competitiveness <= COMPETITIVENESS_MAX &&
    (primaryPathPass || altPathPass) &&
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
 *
 * Deliberately does NOT pass `requiredTrend` to the SQL prefilter: the alt
 * (single-dominant-newcomer) path in `computeSignature` accepts non-'heating'
 * trends, so prefiltering on trend in SQL would silently drop candidates the
 * TS gate could still accept — see `getScreenerCandidates`'s doc comment.
 */
export async function runScreener(): Promise<RunScreenerResult> {
  const candidates = await getScreenerCandidates({
    maxCompetitiveness: COMPETITIVENESS_MAX,
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
      demand: candidate.demand,
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
