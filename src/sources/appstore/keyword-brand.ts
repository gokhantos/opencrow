// Brand-navigational classification for the App Store keyword-gap scanner
// (Batch A budget rescue, 2026-07-22). Two independent, cooperating layers —
// see `keyword-gaps.ts`'s `computeGapProfile` and `keyword-autocomplete.ts`'s
// `expandCorpus` for where each is wired in, and `keyword-deactivation.ts`
// for how a keyword that keeps testing brand-navigational eventually gets
// deactivated.
//
// Problem this guards against: autocomplete is the PRIMARY corpus-discovery
// source, but the large majority of Apple's search-suggest hints are brand/
// app-title completions ("duolingo: language lessons", "notion"), not real
// generic-demand search queries. Once such a hint enters the corpus with
// `source: 'autocomplete'` it was previously near-immortal — the general
// junk-deactivation rule needs BOTH demand < 1 AND top-app reviews < 1000,
// which a brand SERP (dominated by the one big incumbent) fails on both
// counts, and the mined-only deactivation rule exempts 'autocomplete'
// entirely. That let ~3,473 mostly-brand-navigational keywords accumulate in
// the highest-priority (tier 1, daily-guaranteed) scan lane.
//
// MEASURED HEURISTIC FAILURES (do not resurrect these as the primary
// signal — see keyword-brand.test.ts's false-positive audit against the
// live seed/manual corpus):
//   - Bare equals/prefix match of a candidate against `appstore_apps`
//     (the ~20k-row top-chart table) catches only ~3% of real brand hints
//     (most brand apps are long-tail and never chart) AND wrongly flags
//     ~4.4% of the human-curated seed corpus (generic seed phrases that
//     happen to collide with a chart app's exact name).
//   - Top-1-title token-set equality + reviews >= 100,000 (mirroring
//     `GIANT_REVIEW_THRESHOLD` in keyword-gaps.ts) fires on 0/1,419 real
//     scans — real brand apps, even dominant ones, are overwhelmingly
//     long-tail (hundreds to low-thousands of reviews), not giants.
//
// Layer 1 (insert-time, this module's `isBrandNavigationalCandidate`):
// applied in `keyword-autocomplete.ts`'s `expandCorpus`, AFTER
// `buildCandidatesFromHints` but BEFORE `upsertKeywords` — drops a hint
// candidate before it ever occupies a corpus/tier-1 slot. Cheap, string-only,
// no network. Two checks OR together:
//   (i) the hint text itself contains a BRAND_SEPARATOR (colon/dash/pipe) —
//       sampled brand hints are overwhelmingly full app titles with
//       subtitles, so this alone catches the large majority.
//   (ii) the hint, once normalized, EXACTLY matches a known brand SEGMENT —
//       the prefix `extractBrandPrefix` (brand-title-split.ts) recovers from a
//       real, already-scraped app title (`getScannedAppNames` — a much
//       broader, continuously-refreshed pool than the `appstore_apps` chart
//       table the measured-weak heuristic above was tested against).
//       EXACT match only (never prefix/substring) to keep the false-positive
//       rate against legitimate multi-word seed phrases low.
//
// Layer 2 (scan-time, `isBrandNavigationalScan`): computed once a keyword
// actually has SERP data (`computeGapProfile` in keyword-gaps.ts) — the
// rank-1 app's title matches the keyword AND that one app holds a DOMINANT
// share of the top-N field's total reviews, at a dominance threshold FAR
// below "giant" (long-tail brand apps typically hold low hundreds to a few
// thousand reviews, not 100k+). This is the reliable signal; layer 1 exists
// purely to stop obvious brand junk from ever entering the corpus and
// burning a tier-1 scan slot before layer 2 gets a chance to look at it.

import { extractBrandPrefix, hasBrandSeparator } from "./brand-title-split";
import type { TopApp } from "./keyword-types";

/** Brand segments shorter than this (after normalization) are too generic to trust as an exact match. */
const MIN_BRAND_SEGMENT_LENGTH = 2;

/** Lowercase, trim, and collapse internal whitespace — same normalization as `keyword-autocomplete.ts`'s `normalizeSuggestion`. */
export function normalizeBrandText(text: string): string {
  return text.toLowerCase().trim().replace(/\s+/g, " ");
}

/**
 * Builds the set of known brand-name "segments" from a pool of real,
 * already-scraped App Store app titles (`getScannedAppNames` — see
 * `keyword-store.ts`) by extracting each title's brand prefix
 * (`extractBrandPrefix`, brand-title-split.ts) and normalizing it. Pure — no I/O;
 * the caller fetches `appNames` once per expansion pass and reuses the
 * resulting set across every candidate in that pass rather than querying per
 * candidate.
 */
export function buildBrandSegmentSet(appNames: readonly string[]): ReadonlySet<string> {
  const segments = new Set<string>();
  for (const name of appNames) {
    const prefix = extractBrandPrefix(name);
    if (prefix === null) continue;
    const normalized = normalizeBrandText(prefix);
    if (normalized.length >= MIN_BRAND_SEGMENT_LENGTH) segments.add(normalized);
  }
  return segments;
}

/** True iff `candidate`, normalized, EXACTLY matches a known brand segment — see module doc, layer 1(ii). */
export function isKnownBrandSegment(
  candidate: string,
  brandSegments: ReadonlySet<string>,
): boolean {
  return brandSegments.has(normalizeBrandText(candidate));
}

/**
 * Layer 1 (insert-time) verdict: true iff `candidate` should be dropped
 * before it ever enters the corpus — either it looks like a full "Brand:
 * description" title on its own, or it exactly matches a known brand name
 * segment. See module doc for the two sub-checks.
 */
export function isBrandNavigationalCandidate(
  candidate: string,
  brandSegments: ReadonlySet<string>,
): boolean {
  return hasBrandSeparator(candidate) || isKnownBrandSegment(candidate, brandSegments);
}

// ---------------------------------------------------------------------------
// Layer 2 — scan-time dominance classification (see module doc).
// ---------------------------------------------------------------------------

/**
 * The rank-1 app must hold at least this share of the top-N field's total
 * reviews to count as dominant. 0.8 rather than something looser — a
 * genuinely competitive keyword rarely has one app holding 4/5 of the whole
 * field's review mass.
 */
export const BRAND_DOMINANCE_REVIEW_SHARE = 0.8;

/**
 * The rank-1 app must have at least this many reviews for its dominance to
 * be meaningful — otherwise a keyword with a tiny, thin SERP (e.g. 3 apps
 * with a handful of reviews each) could read as "dominant" on noise alone.
 * Deliberately FAR below `GIANT_REVIEW_THRESHOLD` (100,000, keyword-gaps.ts)
 * — see the measured-heuristic-failures note in the module doc: real
 * long-tail brand apps typically sit in the low hundreds to low thousands of
 * reviews, never near giant scale.
 */
export const BRAND_DOMINANCE_MIN_REVIEWS = 200;

/**
 * True iff this scan's field looks brand-navigational: the rank-1 (first-
 * returned, i.e. best-matching per Apple's own relevance ranking) app's
 * title matches the keyword (`TopApp.titleMatch`, computed by
 * `keyword-gaps.ts`'s `toTopApp`/`tokenMatches`) AND that one app holds a
 * dominant share of the field's total reviews. `topApps` is expected in rank
 * order (the scored `topN` slice `computeGapProfile` already carries) —
 * `topApps[0]` is rank 1. Persisted `TopApp` rows carry no `artist` field
 * (see keyword-types.ts), so this intentionally relies on exact-title-match +
 * review-share dominance only, not an artist/developer check — see
 * `format-gap-profile.ts`'s sibling doc comments for the same
 * title-match-only convention elsewhere in this module.
 */
export function isBrandNavigationalScan(topApps: readonly TopApp[]): boolean {
  const rankOne = topApps[0];
  if (!rankOne || !rankOne.titleMatch) return false;
  if (rankOne.reviews < BRAND_DOMINANCE_MIN_REVIEWS) return false;
  const totalReviews = topApps.reduce((sum, a) => sum + a.reviews, 0);
  if (totalReviews <= 0) return false;
  return rankOne.reviews / totalReviews >= BRAND_DOMINANCE_REVIEW_SHARE;
}
