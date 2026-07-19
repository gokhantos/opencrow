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
