// Deterministic scoring core for the App Store keyword-gap scanner. Pure
// functions only — no I/O, no Date, no Math.random. Consumes TopApp/GapTrend
// from `keyword-types.ts` and produces the four KeywordGapProfile scores:
// demand, competitiveness, incumbent-weakness, and opportunity (whitespace).
//
// Separation of concerns: all history/velocity data (per-app review deltas
// across scans, the demand time-series for trend) is fetched in
// `keyword-gaps.ts` and PASSED IN as plain numbers/fields. This module never
// touches the DB or the clock.

import type { GapTrend, HintEvidence, TopApp } from "./keyword-types";

export const REVIEWS_REF = 500_000;
export const VELOCITY_REF = 400;

// Weight on the recent-velocity momentum term relative to the lifetime
// baseline (both measured in ratings/day). At 1.0 a review gained in the recent
// window counts the same as one implied by the lifetime average rate — an
// unbiased blend. In the live corpus measured velocity is ≈0 for the vast
// majority of keywords (most apps gain no reviews in a ~12h window), so this
// term is a momentum BONUS layered on top of the baseline for the occasional
// heating field, never the primary discriminator.
export const VELOCITY_WEIGHT = 1.0;

// Reference demand for opportunity normalization, in ratings/day.
//
// `demand` blends a lifetime-review-mass baseline (mean lifetime ratings/day
// across the title-matched incumbents — a floor reflecting the market pull an
// established field already has, never 0 for a real app with reviews) with a
// recent-velocity momentum bonus. It is deliberately NOT pure velocity: an
// earlier overhaul set demand = mean recent ratings/day, which collapsed to 0
// for ~1,176 of 1,213 live keywords — most apps gain 0 reviews in a 12h window,
// so velocity, and thus demand and opportunity, flatlined at 0 and stopped
// discriminating (the opposite failure of the older everything-saturates model).
//
// The blended baseline spreads well over the real corpus (mean lifetime
// ratings/day per keyword: p25≈0.6, p50≈6, p75≈19, p90≈48).
//
// SUPERSEDED as the live value by `ScoringWeights.demandRef` (2026-07-26 sign
// fix, default 400). This constant is kept as the historical anchor and is no
// longer read by `computeOpportunity`: at 80, `norm` PINNED every keyword at or
// above 80 ratings/day to exactly 1.0, so `real claw machine` (125.6/day) and
// `clawee - real claw machines` (319.4/day) were indistinguishable at the top of
// the demand axis. See `DEFAULT_SCORING_WEIGHTS`.
export const DEMAND_REF = 80;

// Update-staleness window (days since the leader's currentVersionReleaseDate):
// a leader shipped in the last month reads as actively maintained (0 staleness);
// one untouched for a year+ reads as fully stale (1.0) and thus more beatable.
const FRESH_UPDATE_DAYS = 30;
const STALE_UPDATE_DAYS = 365;

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
const norm = (x: number, ref: number): number => clamp01(Math.log1p(x) / Math.log1p(ref));

// per-app entrenchment blends lifetime review mass and lifetime velocity — a
// stable measure of how established the incumbent is (used for competitiveness
// and for picking the leader), deliberately NOT the recent velocity used for
// live demand.
const appStrength = (a: TopApp): number =>
  0.6 * norm(a.reviews, REVIEWS_REF) + 0.4 * norm(a.ratingsPerDay, VELOCITY_REF);

/**
 * Blended demand (ratings/day) across `apps` — the title-matched incumbents the
 * caller passes (the apps actually serving this search phrase), so demand is
 * measured at the apps a new entrant would compete with, not the whole top-N.
 *
 * Two additive components, both in ratings/day:
 *  - baseline: mean LIFETIME ratings/day (reviews / age) — a floor reflecting
 *    the market pull an established field already has. Never 0 for a real app
 *    with reviews; this is what discriminates demand across the corpus.
 *  - velocity: mean RECENT ratings/day since the prior scan (`recentVelocity`) —
 *    a momentum bonus. Apps with no measured velocity contribute 0 here (they do
 *    NOT drag demand toward 0), so a field that merely gained no reviews this
 *    window keeps its lifetime-derived demand instead of collapsing.
 *
 * demand = baseline + VELOCITY_WEIGHT * velocity.
 */
export function computeDemand(apps: readonly TopApp[]): number {
  if (apps.length === 0) return 0;
  const baseline = apps.reduce((s, a) => s + a.ratingsPerDay, 0) / apps.length;
  const velocity = apps.reduce((s, a) => s + (a.recentVelocity ?? 0), 0) / apps.length;
  return baseline + VELOCITY_WEIGHT * velocity;
}


/**
 * Bounds a single outlier app's lifetime review mass from dominating the
 * demand mean: any app's `ratingsPerDay` above `apps`' own p90 is clamped
 * down to that p90 before averaging (2026-07-21 audit item C fix — the
 * unfiltered mean a single mega-app's raw lifetime rate could dominate).
 * Explicitly NOT a switch to the median — validated against the backtest
 * that a median swap flattens the signal enough to kill the "block shorts"
 * winner-keyword result. Pure; does not mutate `apps`.
 */
export function winsorizeRatingsPerDayAtP90(apps: readonly TopApp[]): readonly TopApp[] {
  if (apps.length <= 1) return apps;
  const sorted = apps.map((a) => a.ratingsPerDay).sort((a, b) => a - b);
  const p90Index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.9 * sorted.length) - 1));
  const p90 = sorted[p90Index] as number;
  return apps.map((a) => (a.ratingsPerDay > p90 ? { ...a, ratingsPerDay: p90 } : a));
}

/** Shared p90 helper — extracted from `winsorizeRatingsPerDayAtP90` so `computeVelocityCap` (below) can reuse the exact same percentile math without re-deriving it. Pure; `values.length === 0` returns 0. */
function p90(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const p90Index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.9 * sorted.length) - 1));
  return sorted[p90Index] as number;
}

// Batch D item D4 (2026-07-22, adjusted fix): multiplier applied to the
// SET's own (winsorized) p90 lifetime `ratingsPerDay` to derive the recent-
// velocity cap in `keyword-gaps.ts`'s `enrichWithVelocity` — replacing the
// old PER-APP `10 * a.ratingsPerDay` cap. The old cap scaled with each app's
// OWN lifetime rate, so a single already-high-lifetime-rate incumbent could
// have its `recentVelocity` capped at up to 10x ITS OWN (possibly large)
// rate — a transient flap/spike for an already-big app could inject a huge
// velocity into `computeDemand`'s mean. Deliberately NOT an order-statistic
// winsorize of velocity itself (rejected — see `computeVelocityCap`'s doc
// comment): velocity is ~97% zero across the live corpus, so a p90 of
// velocity values would clamp the ONE heating app's signal to ~0, killing
// exactly the momentum bonus `VELOCITY_WEIGHT` exists to reward. Bounding by
// the set's own LIFETIME ratingsPerDay p90 instead gives every app
// (including a genuinely new, low-lifetime-rate one) the SAME generous,
// corpus-shaped cap, rather than tying each app's headroom to its own
// (possibly tiny or possibly huge) rate. `k=3` is a conservative starting
// value, not backtest-validated (see the module-level TODO in
// `keyword-gaps.ts`) — safe to retune once a backtest harness exists.
export const VELOCITY_CAP_P90_MULTIPLIER = 3;

/**
 * Set-level recentVelocity cap (Batch D item D4): `max(k * p90(lifetime
 * ratingsPerDay across `apps`), floorPerDay)`. Pure; `apps` is the SERP's
 * fetched apps (NOT yet velocity-enriched) — only `ratingsPerDay` is read.
 * `apps.length <= 1` degenerates to `max(k * that one app's own rate,
 * floorPerDay)`, which is intentionally close to (though not identical to —
 * no 10x) the OLD per-app formula's behavior in the single-incumbent case,
 * where a set-level bound and a per-app bound are the same thing by
 * construction.
 */
export function computeVelocityCap(apps: readonly TopApp[], floorPerDay: number): number {
  const setP90 = p90(apps.map((a) => a.ratingsPerDay));
  return Math.max(VELOCITY_CAP_P90_MULTIPLIER * setP90, floorPerDay);
}

// ---------------------------------------------------------------------------
// Tunable scoring weights (2026-07-26 sign fix). Lifted out of hardcoded
// constants so the operator can retune the corrected model from config
// (`appstoreKeywordGap.scoring` in `src/config/schema.ts`) without a code
// change. This module stays PURE: it never reads config itself — the caller
// (`keyword-gaps.ts`) resolves the config object and passes it in, and every
// function defaults to `DEFAULT_SCORING_WEIGHTS` so tests and any other
// caller keep working unchanged.
//
// `src/config/schema.ts` restates these numbers as literal zod defaults (so
// the config module never imports a scanner module); a unit test in
// `keyword-scoring.test.ts` drift-guards the two copies against each other.
// ---------------------------------------------------------------------------

export interface ScoringWeights {
  /**
   * Leader review count at or below which the field's leader reads as fully
   * beatable (`computeLeaderScaleOpening` → 1). Roughly what a solo app
   * accrues in its first months — an incumbent this small is displaceable
   * regardless of how well it is rated.
   */
  readonly weaknessBeatableReviews: number;
  /**
   * Leader review count at or above which the leader reads as fully
   * entrenched (`computeLeaderScaleOpening` → 0) — a category-defining
   * incumbent no solo entrant out-ranks by shipping a better app.
   */
  readonly weaknessEntrenchedReviews: number;
  /**
   * How much of the headroom left by the review-mass term rating/staleness may
   * add back. Bounded well below 1 so the SECONDARY signals can never turn an
   * entrenched incumbent into an open field (the old model's defect A: a
   * 737,897-review leader scored weakness 0.40 on staleness alone).
   */
  readonly weaknessSecondaryLift: number;
  /** Share of the secondary lift carried by a weak leader rating; the rest comes from update staleness. */
  readonly weaknessRatingShare: number;
  /** How much a maximally crowded field (competitiveness 100) discounts beatability. 0.5 keeps a crowded field scoreable but never competitive with an open one. */
  readonly crowdingWeight: number;
  /**
   * Exponent on the beatability axis. THE knob that fixes the model's sign:
   * `d ln(beatability^k) = k * d ln(beatability)`, so it scales the whole
   * incumbent-scale path's slope in log-review-mass without touching the
   * demand axis's range. Must exceed ~1.5 for the mass penalty to out-weigh
   * the mass leak the ratings/day demand proxy inevitably carries — see
   * `DEFAULT_SCORING_WEIGHTS`.
   */
  readonly beatabilityExponent: number;
  /**
   * Log reference (ratings/day) the demand axis normalizes against. Raising it
   * FLATTENS demand's slope in log-review-mass relative to the beatability
   * path, which is what makes the incumbent-scale axis — not raw market size —
   * the dominant discriminator. See `computeSearcherDemandAxis`.
   */
  readonly demandRef: number;
  /** Implied searcher demand (ratings/day) of a rank-0 autocomplete suggestion. See `computeSearcherDemandAxis`. */
  readonly rankTopDemand: number;
  /** Per-rank geometric decay of that implied demand. */
  readonly rankDecay: number;
  /** Distinct seeds at which a hint sighting counts as fully corroborated (fewer seeds scale the lift down linearly). */
  readonly rankSeedFull: number;
  /** How much of the gap between the rank axis and the incumbent-mass demand proxy a fully-corroborated hint sighting may close (0 disables the axis). */
  readonly rankAxisWeight: number;
  /** Multiplier applied when the term WAS probed and Apple suggested nothing — a confirmed absence, not a sampling gap. */
  readonly hintAbsencePenalty: number;
}

/**
 * Defaults derived from the 2026-07-26 corpus measurement (144,841 keywords,
 * latest `store='app'` scan each) and verified with
 * `scripts/backtest-opportunity-scoring.ts`. Full derivation in the PR body.
 *
 *  - `weaknessBeatableReviews` / `weaknessEntrenchedReviews` (200 / 200,000):
 *    a log ramp across the real leader-review-mass range. Puts the measured
 *    "old model said 0.000" cases (`block shorts` leader 2,973; `peptide
 *    tracker` leader 2,959) at ~0.61 and Clawee (737,897) at 0.
 *  - `weaknessSecondaryLift` 0.35: rating+staleness together can lift weakness
 *    by at most 35% of the remaining headroom.
 *  - `weaknessRatingShare` 0.6: preserves the old 0.6/0.4 rating/staleness
 *    blend inside the secondary term.
 *  - `crowdingWeight` 1.0: field crowding enters as the straight complement
 *    `(1 - competitiveness/100)`, the same linear form the old model used —
 *    deliberately the natural value rather than a fitted decimal.
 *  - `beatabilityExponent` 2: SELECTED BY THE SIGN CRITERION, not fitted to any
 *    keyword. Fixing defects A and B alone does NOT flip the sign — measured
 *    `corr(opportunity, competitiveness)` was still +0.352 with the corrected
 *    weakness and the multiplicative composition, because `demand` (mean
 *    incumbent ratings/day) is unavoidably monotone in incumbent review mass
 *    and its slope in log-mass (1/ln(1+demandRef)) exceeded the entire
 *    beatability path's. The algebraic condition for a non-positive sign is
 *    `(dD/D) <= k * (dB/B)`; measured over the corpus that needs `k >= ~1.5`,
 *    so k = 2 is the nearest safe integer. Interpretation: difficulty
 *    COMPOUNDS — you must out-rank the leader AND survive the field behind it.
 *  - `demandRef` 400 (was a hardcoded `DEMAND_REF` = 80): 80 PINNED every
 *    keyword at or above 80 ratings/day to exactly 1.0, so `real claw machine`
 *    (125.6) and `clawee - real claw machines` (319.4) were indistinguishable
 *    at the top of the demand axis. 400 keeps the corpus's real range
 *    (p25≈0.6, p50≈6, p75≈19, p90≈48) on the responsive part of the curve
 *    while restoring discrimination above 80.
 *  - `rankTopDemand` 40: the measured p90 demand of the rank-0 hint bucket
 *    (40.20 ratings/day) — "Apple's top suggestion implies demand at the level
 *    the strongest rank-0 terms actually exhibit".
 *  - `rankDecay` 0.74: reproduces the measured 8.5x median-demand ratio between
 *    the rank-0 bucket (1.207 ratings/day) and the rank-7 bucket (0.107),
 *    i.e. 0.74^7 ≈ 1/8.5.
 *  - `rankSeedFull` 3, `rankAxisWeight` 0.6: `HintEvidence.bestRank` is
 *    explicitly "loosely ordinal only" (ranks mix bare-seed and prefix-fan-out
 *    responses), so a single-seed rank-0 sighting is weak evidence; the lift
 *    scales linearly with distinct-seed corroboration up to 3 seeds and may
 *    then close 60% of the gap.
 *  - `hintAbsencePenalty` 0.7: unchanged from the retired
 *    `HINT_ABSENCE_PENALTY`.
 */
export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  weaknessBeatableReviews: 200,
  weaknessEntrenchedReviews: 200_000,
  weaknessSecondaryLift: 0.35,
  weaknessRatingShare: 0.6,
  crowdingWeight: 1,
  beatabilityExponent: 2,
  demandRef: 400,
  rankTopDemand: 40,
  rankDecay: 0.74,
  rankSeedFull: 3,
  rankAxisWeight: 0.6,
  hintAbsencePenalty: 0.7,
};

export function computeCompetitiveness(apps: readonly TopApp[]): number {
  if (apps.length === 0) return 0;
  const mean = apps.reduce((s, a) => s + appStrength(a), 0) / apps.length;
  return Math.round(mean * 1000) / 10; // 0..100, one decimal
}

/** The strongest (most entrenched) incumbent — the app you'd actually have to beat. */
function leader(apps: readonly TopApp[]): TopApp | undefined {
  if (apps.length === 0) return undefined;
  return apps.reduce((best, a) => (appStrength(a) > appStrength(best) ? a : best));
}

/** 0 (fresh, ≤30d) → 1 (stale, ≥365d). Unknown update date reads as fresh (0). */
function updateStaleness(lastUpdatedDays: number | undefined): number {
  if (lastUpdatedDays === undefined) return 0;
  return clamp01((lastUpdatedDays - FRESH_UPDATE_DAYS) / (STALE_UPDATE_DAYS - FRESH_UPDATE_DAYS));
}

/**
 * How much room the leader's REVIEW MASS leaves a new entrant, in 0..1 — a log
 * ramp from `weaknessBeatableReviews` (→1) to `weaknessEntrenchedReviews` (→0).
 *
 * This is the term the old model was missing entirely (defect A, 2026-07-26):
 * `computeIncumbentWeakness` looked only at the leader's rating and update
 * staleness, so a leader rated ≥4.5 and shipped recently scored weakness
 * EXACTLY 0.000 no matter its size. Measured consequences: `block shorts`
 * (incumbents at 2,973 / 128 / 26 / 14 / 1 reviews) and `peptide tracker`
 * (1,029 / 2,959 / 445 / 2,483 / 0) both scored 0.000 — a one-review incumbent
 * was scored unbeatable — while `real claw machine` scored 0.40 purely because
 * Clawee (737,897 reviews) was 622 days stale. 32% of all scans sat at exactly
 * 0.00 and 41% below 0.05.
 *
 * A log ramp rather than `1 - norm(reviews, ref)` because the log-normalised
 * form is far too flat at the bottom of the range (a 26-review leader reads
 * only ~0.61 against a 5,000-review ref), which is precisely where the
 * discrimination has to live.
 */
export function computeLeaderScaleOpening(
  reviews: number,
  weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS,
): number {
  const beatable = Math.log1p(Math.max(0, weights.weaknessBeatableReviews));
  const entrenched = Math.log1p(Math.max(0, weights.weaknessEntrenchedReviews));
  if (entrenched <= beatable) return reviews <= weights.weaknessBeatableReviews ? 1 : 0;
  return clamp01((entrenched - Math.log1p(Math.max(0, reviews))) / (entrenched - beatable));
}

/**
 * How beatable the field's LEADER is, in 0..1 — with incumbent REVIEW MASS as
 * the first-class term and rating/staleness as bounded secondary modifiers:
 *
 *   `scale     = computeLeaderScaleOpening(leader.reviews)`
 *   `secondary = ratingShare * ratingWeakness + (1 - ratingShare) * staleness`
 *   `weakness  = scale + secondaryLift * (1 - scale) * secondary`
 *
 * Properties this composition guarantees (all unit-tested):
 *  - A tiny incumbent is near-maximally weak *independent of* its rating and
 *    update recency (`scale` → 1 leaves no headroom for the secondary term to
 *    matter). A 26-review, 4.9-rated, freshly-shipped leader scores ~1.0.
 *  - A mega incumbent is near-zero weak *independent of* how stale/mediocre it
 *    is: the secondary term can only ever reach `weaknessSecondaryLift`, so
 *    Clawee-at-622-days-stale scores ≈0.14, not 0.40.
 *  - Weakness is STRICTLY DECREASING in leader review mass: the derivative is
 *    `dscale * (1 - secondaryLift * secondary)`, and
 *    `secondaryLift * secondary ≤ 0.35 < 1`, so the review-mass term can never
 *    be out-voted by the modifiers.
 *  - Rating/staleness only ever RAISE weakness, never lower it.
 *
 * Competitiveness is deliberately absent — field crowding enters opportunity
 * exactly once, via `computeBeatability`. An empty field is maximally beatable (1).
 */
export function computeIncumbentWeakness(
  apps: readonly TopApp[],
  weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS,
): number {
  const top = leader(apps);
  if (!top) return 1;
  const scale = computeLeaderScaleOpening(top.reviews, weights);
  const ratingWeakness = clamp01((4.5 - top.rating) / 2); // 4.5+→0, 2.5→1
  const staleness = updateStaleness(top.lastUpdatedDays);
  const secondary = clamp01(
    weights.weaknessRatingShare * ratingWeakness +
      (1 - weights.weaknessRatingShare) * staleness,
  );
  return clamp01(scale + weights.weaknessSecondaryLift * (1 - scale) * secondary);
}

const TREND_MULT: Record<GapTrend, number> = {
  heating: 1.15,
  stable: 1.0,
  new: 1.0,
  cooling: 0.85,
};

/**
 * History-based momentum over a demand (or opportunity) time-series, oldest →
 * newest. Uses a least-squares slope normalized by the series mean so it
 * measures the total fractional change across the observed span — replacing the
 * old single-point ratio over the slow lifetime average, which almost never
 * left `stable`/`new`. Fewer than two points (or a non-positive mean) → `new`.
 */
export function classifyTrend(series: readonly number[]): GapTrend {
  const points = series.filter((v) => Number.isFinite(v));
  const n = points.length;
  if (n < 2) return "new";

  const meanY = points.reduce((s, v) => s + v, 0) / n;
  if (meanY <= 0) return "new";
  const meanX = (n - 1) / 2;

  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - meanX;
    num += dx * ((points[i] as number) - meanY);
    den += dx * dx;
  }
  if (den === 0) return "stable";

  const slope = num / den;
  const relChange = (slope * (n - 1)) / meanY; // total fractional change across span
  if (relChange > 0.15) return "heating";
  if (relChange < -0.15) return "cooling";
  return "stable";
}

/**
 * SEARCHER-demand axis in 0..1 — the first of opportunity's two axes.
 *
 * The incumbent-mass proxy (`norm(demand, DEMAND_REF)`, where `demand` is mean
 * incumbent ratings/day) is the ONLY demand estimate the old model had, and it
 * is monotone in incumbent review mass — the same underlying quantity
 * `computeCompetitiveness` measures. Measured over 144,841 keywords it alone
 * explained R²=0.725 of `opportunity`, which is why crowding net-RAISED the
 * score (defect C).
 *
 * `appstore_autocomplete_hints` is the one signal in the system derived from
 * SEARCHER behaviour rather than incumbent mass: Apple's own suggestion
 * ordering. Measured per-rank median demand over the corpus — 1.207 (rank 0),
 * 0.908 (1), 0.521 (2), 0.269 (3) … 0.107 (7) ratings/day, an 8.5x monotone
 * spread, against 0.142 for the 129,446 keywords with no rank at all — says
 * rank carries real, orthogonal demand information. The old model spent it as a
 * ±30% multiplier (`HINT_PRESENCE_BOOST` 1.1 / `HINT_ABSENCE_PENALTY` 0.7),
 * hopeless against a term carrying R²=0.725; here it becomes a real axis, in
 * the SAME units as the proxy so the two are directly comparable:
 *
 *   `proxy    = norm(demand, demandRef)`
 *   `implied  = rankTopDemand * rankDecay ^ bestRank`      // ratings/day
 *   `corrob   = min(1, seedCount / rankSeedFull)`
 *   `axis     = proxy + rankAxisWeight * corrob * max(0, norm(implied, demandRef) - proxy)`
 *
 * i.e. a hint sighting pulls the estimate TOWARD Apple's own ordering, but only
 * UPWARD. That asymmetry is deliberate and load-bearing: hint coverage is only
 * 12.8% of the corpus, so a late-rank sighting must stay weak POSITIVE evidence
 * and never score below a term that was never probed at all.
 *
 * The corroboration factor exists because `HintEvidence.bestRank` is documented
 * as "loosely ordinal only" — a rank-0 sighting from a single prefix-fan-out
 * query is much weaker evidence than one several distinct seeds agree on, and
 * without this factor the axis promotes single-seed junk handles to the top of
 * the corpus (observed in the backtest).
 *
 * Absence is TRI-STATE by design, because it is genuinely ambiguous:
 *  - present with a rank → the axis above;
 *  - PROBED and absent (`covered && seedCount === 0`) → `hintAbsencePenalty`,
 *    a confirmed "Apple does not suggest this";
 *  - NEVER probed (or `evidence === undefined`, e.g. the lookup failed) →
 *    exactly neutral. `peptide tracker`, `card grading` and `block shorts` are
 *    all in this bucket today, so neutrality here is what keeps the fix from
 *    destroying the very niches it exists to surface.
 * `HintEvidence.covered` is today's two-state discriminator for the last two
 * branches; when a persisted probe-state lands, only that branch changes.
 */
export function computeSearcherDemandAxis(
  demand: number,
  hint: HintEvidence | undefined,
  weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS,
): number {
  const proxy = norm(demand, weights.demandRef);
  if (!hint) return proxy;
  if (hint.seedCount > 0) {
    // Presence with no usable rank still counts as presence (never a penalty),
    // it simply earns no lift.
    if (hint.bestRank === null) return proxy;
    const impliedDemand = weights.rankTopDemand * weights.rankDecay ** Math.max(0, hint.bestRank);
    const rankProxy = norm(impliedDemand, weights.demandRef);
    const corroboration =
      weights.rankSeedFull <= 0 ? 1 : clamp01(hint.seedCount / weights.rankSeedFull);
    return clamp01(
      proxy + weights.rankAxisWeight * corroboration * Math.max(0, rankProxy - proxy),
    );
  }
  return clamp01(hint.covered ? proxy * weights.hintAbsencePenalty : proxy);
}

/**
 * INCUMBENT-SCALE axis in 0..1 — how beatable the field is, as a product of the
 * leader's own beatability and a field-crowding discount:
 *
 *   `beatability = (incumbentWeakness * (1 - crowdingWeight * competitiveness/100)) ^ beatabilityExponent`
 *
 * Multiplicative, not the old `0.5 * (1 - comp/100) + 0.5 * incumbentWeakness`
 * blend, for two reasons:
 *
 *  1. **The old form had a structural ceiling (defect B).** With weakness 0 —
 *     32% of all scans, and 41% below 0.05 — beatability could not exceed 0.5,
 *     capping opportunity at ~0.575 theoretically and ~0.431 at a realistic
 *     competitiveness of 30. Measured `max(opportunity) where weakness = 0` was
 *     0.5158 across 88,408 scans, so any "0.50 threshold" was unreachable for
 *     exactly the open niches it was meant to select. Multiplying lets a
 *     genuinely open field (weakness ~1, low crowding) reach ~0.9.
 *  2. **It makes crowding structurally unable to net-raise the score.** Both
 *     factors are monotone NON-INCREASING in incumbent review mass, so the
 *     whole beatability path carries a strictly non-positive sign in mass —
 *     the sign error at the heart of the old model.
 *
 * The two factors are not a double count: `incumbentWeakness` asks "can I beat
 * the ONE app at the top", `competitiveness` asks "how much strength is in the
 * field behind it". Leader entrenchment gates first; field crowding discounts.
 *
 * The product is then raised to `beatabilityExponent`. That exponent is not
 * cosmetic: `demand` (mean incumbent ratings/day) is unavoidably monotone in
 * incumbent review mass, so the corrected weakness term and the multiplicative
 * composition ALONE still left `corr(opportunity, competitiveness)` at +0.352
 * over the corpus. Because `d ln(B^k) = k * d ln B`, the exponent scales the
 * whole incumbent-scale path's slope in log-review-mass until it out-weighs
 * that leak, WITHOUT compressing the demand axis's range (which is what makes
 * the alternative — a much larger `demandRef` — put the 0.50 threshold back out
 * of reach). See `DEFAULT_SCORING_WEIGHTS` for the algebra and the sweep.
 */
export function computeBeatability(
  competitiveness: number,
  incumbentWeakness: number,
  weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS,
): number {
  const crowdDiscount = clamp01(1 - weights.crowdingWeight * clamp01(competitiveness / 100));
  const raw = clamp01(clamp01(incumbentWeakness) * crowdDiscount);
  return clamp01(raw ** weights.beatabilityExponent);
}

/**
 * Whitespace / opportunity in 0..1 — a two-axis product:
 *
 *   `opportunity = searcherDemandAxis × beatability × trendMultiplier`
 *
 * Axis 1 (`computeSearcherDemandAxis`) is the demand a SEARCHER expresses;
 * axis 2 (`computeBeatability`) is the scale of the incumbents in the way.
 * Splitting them is the fix for the 2026-07-26 sign defect: incumbent review
 * mass now enters opportunity with a strictly non-positive sign (only through
 * axis 2), while the rate-shaped demand proxy and Apple's suggestion ordering
 * carry the positive sign (only through axis 1).
 *
 * `hint` is optional and always safe to omit — omitting it is exactly
 * equivalent to a never-probed term (neutral), never a penalty.
 */
export function computeOpportunity(
  a: {
    /** Mean incumbent ratings/day (`computeDemand`) — a PURE measurement; no hint multiplier baked in. */
    readonly demand: number;
    readonly competitiveness: number;
    readonly incumbentWeakness: number;
    readonly trend: GapTrend;
    readonly hint?: HintEvidence | undefined;
  },
  weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS,
): number {
  const demandAxis = computeSearcherDemandAxis(a.demand, a.hint, weights);
  const beatability = computeBeatability(a.competitiveness, a.incumbentWeakness, weights);
  return clamp01(demandAxis * beatability * TREND_MULT[a.trend]);
}

// The "beatable solo" review ceiling for `computeBuildability`'s reviewOpening
// term — a top incumbent with roughly this many reviews or more reads as
// fully entrenched (opening -> 0); far fewer reviews reads as wide open.
// User-chosen (see docs/superpowers/specs/2026-07-14-buildability-score-design.md).
export const BUILDABILITY_REVIEW_REF = 5000;

// Reference demand for `computeBuildability`'s demandFactor gate. Distinct
// from `DEMAND_REF` (used by `computeOpportunity`'s ratings/day-based demand
// blend): this normalizes the per-keyword `demand` scan field specifically
// for the buildability score. Not exported — an internal tuning knob scoped
// to this one formula.
const BUILDABILITY_DEMAND_REF = 50;

/**
 * Solo-indie "can I win this?" score in 0..100 — read-time, deterministic
 * function of already-stored per-keyword scan fields (no trend, no I/O).
 * Distinct from `opportunity`: HARD-GATES on real demand (no search interest
 * => 0, multiplicatively via `demandFactor`) and centers specifically on
 * out-competing the TOP incumbent (its review count + rating), rather than
 * the whole field's mean competitiveness.
 *
 * `norm(x, ref) = clamp01(ln(1+x)/ln(1+ref))`
 * `demandFactor = norm(demand, 50)`
 * `reviewOpening = clamp01(1 - norm(topAppReviews, 5000))`
 * `ratingOpening = clamp01((4.5 - avgRating) / 1.5)`
 * `opening = 0.65*reviewOpening + 0.35*ratingOpening`
 * `buildability = round(100 * demandFactor * opening)`
 *
 * See docs/superpowers/specs/2026-07-14-buildability-score-design.md for the
 * full design. The mirrored SQL expression in `keyword-store.ts`'s
 * `BUILDABILITY_SQL` MUST stay in exact agreement with this function — an
 * integration test drift-guards the two against each other.
 */
export function computeBuildability(a: {
  readonly demand: number;
  readonly topAppReviews: number;
  readonly avgRating: number;
}): number {
  const demandFactor = norm(a.demand, BUILDABILITY_DEMAND_REF);
  const reviewOpening = clamp01(1 - norm(a.topAppReviews, BUILDABILITY_REVIEW_REF));
  const ratingOpening = clamp01((4.5 - a.avgRating) / 1.5);
  const opening = 0.65 * reviewOpening + 0.35 * ratingOpening;
  return Math.round(100 * demandFactor * opening);
}
