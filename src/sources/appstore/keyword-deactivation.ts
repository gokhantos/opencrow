// Pure predicate for post-scan junk deactivation (see `keyword-gaps.ts`'s
// `scanAndRecord`, which evaluates this after every successful scan, and
// `keyword-store.ts`'s `deactivateJunkKeywords`, which applies it). Flags a
// keyword as "structurally hopeless" — not merely low-scoring today, but
// unlikely to ever be worth re-scanning — so the sweep stops spending budget
// on it. Reversible: deactivation only ever flips `active` to `false`, never
// deletes the row, so re-activating a keyword is a single UPDATE away.
//
// Two independent ways to qualify:
//   1. Lexically junk (`isJunkKeyword`) — same stoplist/short/numeric/
//      non-Latin-script rules the newborn-velocity screener and the
//      dashboard's `hideJunk` filter already use. No scan data needed.
//   2. Data-hopeless: the corpus has scanned it more than once, its latest
//      demand is negligible, no app in the SERP shows any real newcomer
//      traction, and the field's biggest incumbent is still small — i.e.
//      scanning it again is very unlikely to surface anything.
//
// NEVER applies to `source: 'manual' | 'seed'` — a human explicitly asked
// for these to stay in the corpus. That exclusion is enforced HERE (defense
// in depth, so this predicate alone is never wrong) AND, independently, in
// `deactivateJunkKeywords`'s SQL WHERE clause (belt + suspenders — a caller
// bug here can never touch a manual/seed row).
//
// ─── Relationship to PERMANENT retirement (2026-07-25) ─────────────────────
// `keyword-retirement.ts` adds a second, STRONGER lever — durable
// `retired_at`/`retired_reason` columns (migration 057) plus discovery-time
// re-admission blocking. Every predicate in THIS file is unchanged by that
// change and keeps its exact production behavior. That is deliberate:
//
// The obvious "fix" for the immortal-brand-keyword problem is to widen
// `shouldDeactivateKeyword`'s data-hopeless AND-gate (`demand <
// DEACTIVATION_MAX_DEMAND` AND `topAppReviews < DEACTIVATION_MAX_REVIEWS_CEILING`)
// into an OR-gate. That widening was DELIBERATELY NOT APPLIED HERE, and the
// rule instead lives in `keyword-retirement.ts`'s `shouldRetireByScore`,
// shipped DISABLED behind `appstoreJunkDeactivation.retirement.scoreBased`.
// Reason: both halves of the OR are actively hostile to the corpus's purpose.
// `demand` is the broken proxy (72.5% of the equally-broken `opportunity`
// score's variance; reads ~0 for the owner's own shipped products), and
// `topAppReviews < 1000` means "no incumbent has 1000 reviews yet" — the
// DEFINITION of the early, weakly-defended niche the scanner exists to find.
// An OR-gate would therefore deactivate exactly the good niches (`card
// grading`, `shorts blocker`, `stock analysis` all sit in that band) instead
// of the brand junk. The brand problem is solved score-INDEPENDENTLY instead:
// see `keyword-retirement.ts`'s `brand-lexical` and `brand-serp-shape` rules.

import { isJunkKeyword } from "./keyword-junk";
import type { TopApp } from "./keyword-types";

/** A keyword must have at least this many scans before the data-hopeless branch applies. */
export const DEACTIVATION_MIN_SCANS = 2;

/** Latest scan demand at or above this is NOT hopeless — there's still measurable interest. */
export const DEACTIVATION_MAX_DEMAND = 1;

/** An app younger than this counts as a "newcomer" for the traction check — mirrors `app-velocity.ts`'s `NEWBORN_AGE_DAYS_MAX`. */
export const DEACTIVATION_TRACTION_AGE_DAYS_MAX = 540;

/** A newcomer gaining reviews faster than this (ratings/day) counts as real traction. */
export const DEACTIVATION_TRACTION_MIN_RATINGS_PER_DAY = 1;

/** The field's single biggest incumbent must have fewer reviews than this to count as hopeless. */
export const DEACTIVATION_MAX_REVIEWS_CEILING = 1000;

/** Corpus sources this predicate must never flag, regardless of the other conditions. */
export const DEACTIVATION_PROTECTED_SOURCES: ReadonlySet<string> = new Set(["manual", "seed"]);

export interface DeactivationCandidate {
  readonly keyword: string;
  readonly source: string;
  /** Count of scans this keyword has ever had, INCLUDING the one that just persisted. */
  readonly scanCount: number;
  /** Latest scan's `demand` field. */
  readonly demand: number;
  readonly topApps: readonly TopApp[];
  /** Latest scan's `topAppReviews` — max reviews across the SERP. */
  readonly topAppReviews: number;
  /**
   * True iff the most recent `DEACTIVATION_MIN_SCANS` US-store scans (newest
   * first) were ALL `brandNavigational` — bundled onto this candidate (the
   * caller already fetches the same scan-history window for `scanCount`) so
   * `shouldDeactivateBrandNavigationalKeyword` doesn't need a second DB
   * round trip. Unused by `shouldDeactivateKeyword` itself; see
   * `shouldDeactivateBrandNavigationalKeyword`'s own doc comment.
   */
  readonly recentScansAllBrandNavigational: boolean;
}

/**
 * True iff `candidate` should be deactivated. Pure — no I/O, no Date.
 */
export function shouldDeactivateKeyword(candidate: DeactivationCandidate): boolean {
  if (DEACTIVATION_PROTECTED_SOURCES.has(candidate.source)) return false;
  if (isJunkKeyword(candidate.keyword)) return true;

  if (candidate.scanCount < DEACTIVATION_MIN_SCANS) return false;
  if (candidate.demand >= DEACTIVATION_MAX_DEMAND) return false;

  const hasNewcomerTraction = candidate.topApps.some(
    (a: TopApp) =>
      a.ageDays < DEACTIVATION_TRACTION_AGE_DAYS_MAX &&
      a.ratingsPerDay > DEACTIVATION_TRACTION_MIN_RATINGS_PER_DAY,
  );
  if (hasNewcomerTraction) return false;

  return candidate.topAppReviews < DEACTIVATION_MAX_REVIEWS_CEILING;
}

// ---------------------------------------------------------------------------
// Mined-pool-specific rule (2026-07-21 scan-budget retune) — see PR notes.
// Measured 2026-07-21: 97.9% of the ~36k daily SERP scans went to the
// `source: 'mined'` n-gram pool (114,656 keywords), which had produced 304
// signature hits — ALL triaged as noise; every validated candidate ever came
// from seed/manual (2% of budget). The general data-hopeless branch above
// only looks at the LATEST scan's `demand` and applies to any non-protected
// source (autocomplete included); this rule is narrower (mined only) but
// looks at demand EVER reached across the keyword's WHOLE scan history
// (never just the latest reading — a keyword that spiked once and cooled is
// not hopeless) and unconditionally exempts anything that has ever crossed
// the signature screener's watchlist, however marginal or since-dismissed.
// ---------------------------------------------------------------------------

/**
 * Mined keywords that have never reached this much demand, in ANY scan, are
 * considered to have shown no real signal. Matches `ALT_MIN_DEMAND` in
 * `keyword-screener.ts` — the corpus's own established "this keyword has
 * credible search demand" floor — rather than inventing a new threshold.
 */
export const MINED_DEACTIVATION_MAX_DEMAND_EVER = 5;

/** Sources `shouldDeactivateMinedKeyword` applies to — Batch C4 widened this from `'mined'` alone to also cover `'review'` (see keyword-review-miner.ts, which shares the mined pool's exploration quota AND its deactivation rule). */
export const MINED_DEACTIVATION_SOURCES: ReadonlySet<string> = new Set(["mined", "review"]);

export interface MinedDeactivationCandidate {
  readonly source: string;
  /** Total scans this keyword has EVER had. */
  readonly scanCount: number;
  /** MAX(demand) across the keyword's entire scan history (all stores). */
  readonly maxDemandEver: number;
  /** True iff the keyword has ANY row in `appstore_signature_hits`, regardless of status. */
  readonly hasSignatureHit: boolean;
}

/**
 * True iff `candidate` is a `source: 'mined'` or `source: 'review'` (Batch
 * C4) keyword that has been scanned at least `DEACTIVATION_MIN_SCANS` times,
 * has NEVER reached `MINED_DEACTIVATION_MAX_DEMAND_EVER` demand in any scan,
 * and has no row in `appstore_signature_hits`. Pure — no I/O. Evaluated in
 * ADDITION to (never instead of) `shouldDeactivateKeyword` above — either one
 * firing is enough to deactivate.
 */
export function shouldDeactivateMinedKeyword(candidate: MinedDeactivationCandidate): boolean {
  if (!MINED_DEACTIVATION_SOURCES.has(candidate.source)) return false;
  if (candidate.scanCount < DEACTIVATION_MIN_SCANS) return false;
  if (candidate.maxDemandEver >= MINED_DEACTIVATION_MAX_DEMAND_EVER) return false;
  return !candidate.hasSignatureHit;
}

// ---------------------------------------------------------------------------
// Brand-navigational rule (Batch A budget rescue, 2026-07-22) — see
// `keyword-brand.ts` module doc, layer 2. The general data-hopeless branch
// above (`shouldDeactivateKeyword`) requires BOTH demand < `DEACTIVATION_MAX_DEMAND`
// AND the field's biggest incumbent under `DEACTIVATION_MAX_REVIEWS_CEILING`
// (1000) reviews — a brand-navigational keyword's SERP is dominated by
// exactly the ONE incumbent the keyword names, so it routinely fails the
// reviews ceiling (a real, if small, long-tail brand app) even though the
// keyword itself will never surface a generic-demand opportunity. This rule
// bypasses that ceiling entirely: it fires once the LAST `DEACTIVATION_MIN_SCANS`
// US-store scans were ALL brand-navigational, regardless of demand or review
// count. Applies to any non-protected source (`autocomplete`/`mined`/
// `pipeline` in practice — `manual`/`seed` stay protected, same
// `DEACTIVATION_PROTECTED_SOURCES` check as `shouldDeactivateKeyword`).
// Evaluated in ADDITION to (never instead of) the other two rules — any one
// firing is enough to deactivate.
// ---------------------------------------------------------------------------

export interface BrandNavigationalDeactivationCandidate {
  readonly source: string;
  /** Count of US-store scans this keyword has ever had (capped at `DEACTIVATION_MIN_SCANS` by the caller's history fetch — see `keyword-gaps.ts`'s `buildDeactivationCandidate`). */
  readonly scanCount: number;
  /** True iff the most recent `DEACTIVATION_MIN_SCANS` US-store scans (newest first) were ALL `brandNavigational`. */
  readonly recentScansAllBrandNavigational: boolean;
}

/**
 * True iff `candidate` is a non-protected-source keyword that has been
 * scanned at least `DEACTIVATION_MIN_SCANS` times and whose most recent
 * scans were ALL brand-navigational. Pure — no I/O.
 */
export function shouldDeactivateBrandNavigationalKeyword(
  candidate: BrandNavigationalDeactivationCandidate,
): boolean {
  if (DEACTIVATION_PROTECTED_SOURCES.has(candidate.source)) return false;
  if (candidate.scanCount < DEACTIVATION_MIN_SCANS) return false;
  return candidate.recentScansAllBrandNavigational;
}

// ---------------------------------------------------------------------------
// Autocomplete-specific rule (Batch D item D1, 2026-07-22) — modeled
// directly on `shouldDeactivateMinedKeyword` above (same
// `DEACTIVATION_MIN_SCANS` gate, same `maxDemandEver` threshold reused
// verbatim as `AUTOCOMPLETE_HINT_DEACTIVATION_MAX_DEMAND_EVER`, same
// signature-hit exemption), narrowed to `source: 'autocomplete'` and adding
// a SECOND, independent confirmation on top of weak scan demand: the term
// must have been ACTUALLY re-queried (`hintCovered`) in the autocomplete
// hint lookback window and never resurfaced (`hintSeedCount === 0`). Firing
// only requires EITHER signal alone (weak SERP demand from
// `shouldDeactivateKeyword`'s general branch, say) to be somewhat
// suspicious; this rule specifically wants BOTH weak scan demand AND
// confirmed hint absence before deactivating an autocomplete-sourced term —
// see `HintEvidence`'s doc comment (keyword-types.ts) for why `hintCovered`
// must gate this (an UNcovered term was simply never re-sampled, which is
// not evidence of anything).
// ---------------------------------------------------------------------------

/** Same bar as `MINED_DEACTIVATION_MAX_DEMAND_EVER` — reused, not reinvented. */
export const AUTOCOMPLETE_HINT_DEACTIVATION_MAX_DEMAND_EVER = MINED_DEACTIVATION_MAX_DEMAND_EVER;

export interface AutocompleteHintDeactivationCandidate {
  readonly source: string;
  /** Total scans this keyword has EVER had. */
  readonly scanCount: number;
  /** MAX(demand) across the keyword's entire scan history (all stores). */
  readonly maxDemandEver: number;
  /** True iff the keyword has ANY row in `appstore_signature_hits`, regardless of status. */
  readonly hasSignatureHit: boolean;
  /** `HintEvidence.covered` for this keyword over the autocomplete hint lookback window. */
  readonly hintCovered: boolean;
  /** `HintEvidence.seedCount` for this keyword over the same window. */
  readonly hintSeedCount: number;
}

/**
 * True iff `candidate` is a `source: 'autocomplete'` keyword that has been
 * scanned at least `DEACTIVATION_MIN_SCANS` times, has NEVER reached
 * `AUTOCOMPLETE_HINT_DEACTIVATION_MAX_DEMAND_EVER` demand in any scan, has
 * no signature hit, WAS actually re-queried as (or via a prefix of) an
 * autocomplete seed in the lookback window, and never resurfaced as a hint
 * in that window. Pure — no I/O. Evaluated in ADDITION to (never instead of)
 * `shouldDeactivateKeyword`/`shouldDeactivateMinedKeyword` — any one rule
 * firing is enough to deactivate.
 */
export function shouldDeactivateForHintAbsence(
  candidate: AutocompleteHintDeactivationCandidate,
): boolean {
  if (candidate.source !== "autocomplete") return false;
  if (candidate.scanCount < DEACTIVATION_MIN_SCANS) return false;
  if (candidate.maxDemandEver >= AUTOCOMPLETE_HINT_DEACTIVATION_MAX_DEMAND_EVER) return false;
  if (candidate.hasSignatureHit) return false;
  if (!candidate.hintCovered) return false;
  return candidate.hintSeedCount === 0;
}
