// PERMANENT keyword retirement for the App Store keyword corpus — the pure
// decision layer (2026-07-25 corpus-hygiene pass). Companion to
// `keyword-deactivation.ts`, NOT a replacement for it: that module's
// predicates decide "stop spending scan budget on this for now" by flipping
// `active`; this one decides "this keyword should never be scanned OR
// re-admitted again", recorded durably as `appstore_keywords.retired_at` +
// `retired_reason` (migration 057). Applied by `keyword-store.ts`'s
// `retireKeywords` / `runRetirementSweep`, and enforced at DISCOVERY time by
// `upsertKeywords`.
//
// ─── Why a second, stronger lever ──────────────────────────────────────────
// `active` is a reason-free boolean, and the corpus's own history shows it is
// not enough. Live measurement (2026-07-25): 16,195 active `autocomplete`
// keywords, of which only 179 have EVER been deactivated — brand keywords are
// effectively immortal because `shouldDeactivateKeyword`'s data-hopeless
// branch is an AND-gate (`demand < 1` AND `topAppReviews < 1000`) over two
// orthogonal signals, and a brand SERP fails the reviews half (there IS a
// real, if long-tail, incumbent behind the brand). Retirement also survives
// re-discovery: a deactivated keyword can be re-admitted by any future path
// that flips `active` back, and a retired FAMILY ROOT additionally blocks
// re-admission of its descendants (see "Brand-family resistance" below).
//
// ─── HARD CONSTRAINT: nothing enabled here may key on `opportunity`/`demand` ─
// The corpus's `opportunity` score is provably broken (audited 2026-07-25:
// +0.41 correlation with `competitiveness`, -0.36 with `incumbent_weakness`,
// 72.5% of its variance explained by the equally-broken `demand` proxy). It
// scores the owner's OWN shipped products as noise — `card grading` 0.083,
// `shorts blocker` 0.012, `stock analysis` 0.144. A retirement rule keyed on
// that score would therefore delete EXACTLY the good niches, permanently.
//
// So every rule that ships ENABLED here is score-independent — it reads
// keyword TEXT and SERP SHAPE only, never `opportunity`, never `demand`, never
// `topAppReviews`:
//
//   1. `structural-junk`     — `keyword-junk.ts`'s `isJunkKeyword`: sole
//                              generic stoplist word, under 3 chars,
//                              numeric/punctuation-only, or any non-Latin
//                              script letter. Pure text. (Live: 3,418 active
//                              non-protected keywords contain non-ASCII text.)
//   2. `brand-lexical`       — `keyword-brand.ts`'s layer-1
//                              `isBrandNavigationalCandidate`, applied
//                              RETROACTIVELY. That filter only ever ran at
//                              insert time (2026-07-22), so every keyword
//                              admitted before it shipped was never tested:
//                              1,032 active `autocomplete` keywords still
//                              contain a `BRAND_SEPARATOR`, i.e. they are
//                              literal "Brand: description" app titles.
//   3. `brand-serp-shape`    — `isBrandDominatedSerp` below. Strictly a shape
//                              measure over the latest US SERP; see its doc
//                              comment for the live false-positive audit that
//                              set every threshold.
//
// And two rules ship DISABLED:
//
//   4. `autocomplete-probed-absent` — "Apple probed this term and suggests
//      nothing" would be an excellent score-independent NEGATIVE-DEMAND
//      signal, but the tri-state probe record it needs
//      (`present(rank)`/`probed-absent`/`never-probed`) is being persisted by
//      a SEPARATE, not-yet-merged change to `keyword-autocomplete.ts`. The
//      rule and its plumbing are here so enabling it is a config flip once
//      that lands; until then every candidate arrives as `never-probed`, which
//      can never fire (absence of a probe is not evidence of absence — the
//      same discipline `HintEvidence.covered` already enforces).
//   5. `score-based` — see `shouldRetireByScore`. MUST stay off until the
//      scoring model is fixed AND recalibrated.

import { isBrandNavigationalCandidate } from "./keyword-brand";
import { DEACTIVATION_PROTECTED_SOURCES } from "./keyword-deactivation";
import { isJunkKeyword } from "./keyword-junk";

/**
 * Closed vocabulary of retirement reasons — mirrored EXACTLY by migration
 * 057's `appstore_keywords_retired_reason_check` constraint, so a reason this
 * union does not know about fails loudly at write time instead of becoming an
 * un-queryable audit hole. `'manual'` is reserved for an operator retiring a
 * keyword by hand; no rule in this module ever produces it.
 */
export type RetirementReason =
  | "structural-junk"
  | "brand-lexical"
  | "brand-serp-shape"
  | "autocomplete-probed-absent"
  | "score-based"
  | "manual";

/**
 * Corpus sources retirement must NEVER touch — the same `manual`/`seed` set
 * `keyword-deactivation.ts` protects, imported rather than redeclared so the
 * two levers can never drift on what "a human asked for this" means. Enforced
 * HERE (so the pure predicate alone is never wrong) AND independently in
 * `keyword-store.ts`'s `retireKeywords` SQL — belt + suspenders, matching
 * `deactivateJunkKeywords`'s existing convention.
 */
export const RETIREMENT_PROTECTED_SOURCES: ReadonlySet<string> = DEACTIVATION_PROTECTED_SOURCES;

/**
 * Whether Apple's search-suggest endpoint has been asked about this term, and
 * what it said — the tri-state a sibling change to `keyword-autocomplete.ts`
 * is persisting. `'never-probed'` is the safe default and the value every
 * candidate carries until that lands; it can never trigger retirement.
 */
export type AutocompleteProbeState = "present" | "probed-absent" | "never-probed";

/**
 * Score-INDEPENDENT shape of a keyword's latest US SERP. Deliberately carries
 * no `demand`/`opportunity`/`competitiveness`: every field here is a count or
 * a ratio over the returned field, derivable from `top_apps` alone.
 *
 * "Exact-brand title" means an incumbent's title EQUALS the keyword or begins
 * with it at a word/separator boundary (`spotify`, `spotify - music`,
 * `spotify: podcasts`) — the shape a brand-navigational field has, where the
 * keyword IS the product name. A mid-phrase or suffix occurrence does not
 * count (see `keyword-store.ts`'s `buildSerpShapeSql` for the SQL mirror).
 */
export interface RetirementSerpShape {
  /** How many apps the SERP returned (the scored top-N slice). */
  readonly fieldSize: number;
  /** How many of those apps' titles are exact-brand titles for this keyword. */
  readonly exactBrandTitleCount: number;
  /** Whether the rank-1 (best-matching per Apple's own relevance) app is one of them. */
  readonly rankOneExactBrandTitle: boolean;
  /** Rank-1's share of the field's TOTAL review count, 0..1. A shape measure, not a score. */
  readonly rankOneReviewShare: number;
}

/**
 * Inputs the DISABLED `score-based` rule would read. Present only so the rule
 * is complete and testable; `decideRetirement` never touches this unless
 * `RetirementRules.scoreBased` is explicitly flipped on.
 */
export interface RetirementScoreSignals {
  readonly demand: number;
  readonly topAppReviews: number;
  readonly scanCount: number;
}

export interface RetirementCandidate {
  readonly keyword: string;
  readonly source: string;
  /** Latest US SERP shape, or `null` when the keyword has never been scanned. */
  readonly serp: RetirementSerpShape | null;
  readonly autocompleteProbe: AutocompleteProbeState;
  /** `null` unless the caller opted into the score-based rule. */
  readonly score: RetirementScoreSignals | null;
}

/** Per-rule enable flags — see the module doc comment for what each one reads. */
export interface RetirementRules {
  readonly structuralJunk: boolean;
  readonly brandLexical: boolean;
  readonly brandSerpShape: boolean;
  readonly autocompleteProbedAbsent: boolean;
  readonly scoreBased: boolean;
}

/**
 * Shipping defaults: the three score-independent rules ON, the two that need
 * something that does not exist yet (a persisted autocomplete probe record; a
 * scoring model that works) OFF. `appstoreJunkDeactivation.retirement` in
 * `src/config/schema.ts` carries the same defaults as operator-facing config.
 */
export const DEFAULT_RETIREMENT_RULES: RetirementRules = Object.freeze({
  structuralJunk: true,
  brandLexical: true,
  brandSerpShape: true,
  autocompleteProbedAbsent: false,
  scoreBased: false,
});

// ---------------------------------------------------------------------------
// Rule 3 — brand-dominated SERP shape
// ---------------------------------------------------------------------------

/**
 * A field smaller than this is not evidence of anything: 1 of 1 titles
 * matching is 100% agreement on a sample of one. Live sampling of the
 * unguarded rule surfaced exactly that failure mode (single-result SERPs for
 * long non-English phrases scoring a perfect brand share).
 */
export const BRAND_SERP_MIN_FIELD_SIZE = 5;

/** At least this share of the field's titles must be exact-brand titles. */
export const BRAND_SERP_MIN_TITLE_SHARE = 0.5;

/**
 * Rank 1 must hold at least this share of the field's review mass. This is the
 * discriminator between the two very different fields that both show
 * exact-brand-title dominance:
 *
 *   - a BRAND-navigational field, where one product owns the term and
 *     therefore owns the reviews ("netgear": 7/14 titles, rank 1 at 0.37
 *     -> later readings 0.6+; "lexus" 13/17 at 0.59; "drupal" 5/7 at 1.00);
 *   - a GENERIC term that every competitor title-stuffs verbatim, where
 *     review mass is SPREAD ("speaker cleaner": 9/17 titles begin with the
 *     exact keyword and rank 1 does too, but rank 1 holds 0.001 of the
 *     reviews). That is a competitive generic keyword, not a brand — retiring
 *     it would be exactly the mistake this whole module is written to avoid.
 *
 * Deliberately LOOSER than `keyword-brand.ts`'s `BRAND_DOMINANCE_REVIEW_SHARE`
 * (0.8), because this rule pairs it with a field-wide title-share requirement
 * that `isBrandNavigationalScan` does not have.
 */
export const BRAND_SERP_MIN_RANK_ONE_REVIEW_SHARE = 0.5;

/**
 * True iff the SERP shape is brand-navigational: a field of at least
 * `BRAND_SERP_MIN_FIELD_SIZE` apps, at least `BRAND_SERP_MIN_TITLE_SHARE` of
 * whose titles are exact-brand titles for the keyword, with rank 1 among them
 * AND holding at least `BRAND_SERP_MIN_RANK_ONE_REVIEW_SHARE` of the field's
 * review mass. Pure — no I/O, no scores.
 *
 * LIVE FALSE-POSITIVE AUDIT (2026-07-25, latest US scan per active keyword,
 * n = 95,012 — mirroring the audit convention in `keyword-brand.test.ts`):
 * this rule fires on 78 keywords, ALL of them `source: 'mined'` single-token
 * brand terms (drupal, lexus, toyota, coway, sphero, farmasi, cox, ruckus...).
 * ZERO `seed`, `manual` or `autocomplete` rows fire. The owner's own shipped
 * niches do not fire (`card grading` 1/20 titles; `stock analysis` 2/20 at a
 * 0.002 review share; `peptide tracker` 4/20 at 0.027). For contrast, the
 * rank-1-title-match check ALONE would have fired on 35,422 keywords — do not
 * relax any of the three conjuncts back out.
 */
export function isBrandDominatedSerp(shape: RetirementSerpShape): boolean {
  if (shape.fieldSize < BRAND_SERP_MIN_FIELD_SIZE) return false;
  if (!shape.rankOneExactBrandTitle) return false;
  if (shape.exactBrandTitleCount / shape.fieldSize < BRAND_SERP_MIN_TITLE_SHARE) return false;
  return shape.rankOneReviewShare >= BRAND_SERP_MIN_RANK_ONE_REVIEW_SHARE;
}

// ---------------------------------------------------------------------------
// Rule 5 — the DISABLED score-based rule
// ---------------------------------------------------------------------------

/** Minimum scans before the score-based rule could consider a keyword proven. */
export const SCORE_BASED_MIN_SCANS = 2;

/** Latest-scan demand below this is "no measurable interest" — per the BROKEN demand proxy. */
export const SCORE_BASED_MAX_DEMAND = 1;

/** Biggest incumbent under this many reviews is "no real incumbent". */
export const SCORE_BASED_MAX_TOP_APP_REVIEWS = 1000;

/**
 * The score-based retirement rule — the OR-gate widening of
 * `shouldDeactivateKeyword`'s AND-gate (`demand < 1` AND `topAppReviews <
 * 1000` becomes `demand < 1` OR `topAppReviews < 1000`), which would finally
 * make brand keywords mortal.
 *
 * IT SHIPS DISABLED (`DEFAULT_RETIREMENT_RULES.scoreBased === false`) AND MUST
 * STAY DISABLED until (a) the replacement scoring model has landed and (b) it
 * has been RECALIBRATED against known-good niches. Two independent reasons,
 * either one sufficient:
 *
 *   1. `demand` is the broken proxy. 72.5% of the (also broken) `opportunity`
 *      score's variance is just this field; it reads ~0 for the owner's own
 *      shipped products. "Retire everything with demand < 1" retires the
 *      corpus's best niches.
 *   2. The other half of the OR is WORSE, not better. `topAppReviews < 1000`
 *      means "no incumbent has 1000 reviews yet" — which is the DEFINITION of
 *      an early, weakly-defended niche, i.e. the thing we are hunting.
 *      `card grading` (biggest incumbent ~4k reviews across the field, rank 1
 *      at 4,032 but most of the field far smaller) and `shorts blocker` both
 *      sit in exactly that band. See this rule's unit test, which asserts it
 *      WOULD retire them — that assertion is the tripwire, not a bug.
 *
 * Enabling this is a deliberate, separately-reviewed act: flip
 * `appstoreJunkDeactivation.retirement.scoreBased` only alongside a fresh
 * false-positive audit against the owner's shipped niches. Pure — no I/O.
 */
export function shouldRetireByScore(score: RetirementScoreSignals): boolean {
  if (score.scanCount < SCORE_BASED_MIN_SCANS) return false;
  return score.demand < SCORE_BASED_MAX_DEMAND || score.topAppReviews < SCORE_BASED_MAX_TOP_APP_REVIEWS;
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/**
 * The retirement verdict for `candidate`, or `null` to keep it. Pure — no
 * I/O, no `Date`, no config reads: `rules` and `brandSegments` are injected so
 * every branch is exhaustively testable with fixed values.
 *
 * Rules are evaluated in a fixed precedence order (cheapest and most certain
 * first) and the FIRST match wins, so `retired_reason` is deterministic for a
 * given input rather than dependent on evaluation luck:
 * structural-junk -> brand-lexical -> brand-serp-shape ->
 * autocomplete-probed-absent -> score-based.
 *
 * `brandSegments` is the known-brand-name set built once per pass by
 * `keyword-brand.ts`'s `buildBrandSegmentSet` from real scraped app titles —
 * the caller fetches it once and reuses it across every candidate, never per
 * candidate.
 */
export function decideRetirement(
  candidate: RetirementCandidate,
  rules: RetirementRules,
  brandSegments: ReadonlySet<string>,
): RetirementReason | null {
  if (RETIREMENT_PROTECTED_SOURCES.has(candidate.source)) return null;

  if (rules.structuralJunk && isJunkKeyword(candidate.keyword)) return "structural-junk";

  if (rules.brandLexical && isBrandNavigationalCandidate(candidate.keyword, brandSegments)) {
    return "brand-lexical";
  }

  if (rules.brandSerpShape && candidate.serp && isBrandDominatedSerp(candidate.serp)) {
    return "brand-serp-shape";
  }

  if (
    rules.autocompleteProbedAbsent &&
    candidate.source === "autocomplete" &&
    candidate.autocompleteProbe === "probed-absent"
  ) {
    return "autocomplete-probed-absent";
  }

  if (rules.scoreBased && candidate.score && shouldRetireByScore(candidate.score)) {
    return "score-based";
  }

  return null;
}

// ---------------------------------------------------------------------------
// Brand-FAMILY resistance
// ---------------------------------------------------------------------------
//
// Retiring `spotify` and then re-admitting `spotify premium` next autocomplete
// cycle is pointless: the whole token family is navigational for the same
// product. So a brand retirement additionally registers the keyword as a
// FAMILY ROOT, and `keyword-store.ts`'s `upsertKeywords` refuses any new
// candidate whose token prefix hits a root.
//
// Two deliberate limits keep this from over-blocking:
//   - only the BRAND reasons seed a root (`FAMILY_BLOCKING_REASONS`). Junk,
//     probe-absence and score-based retirements say nothing about a keyword's
//     descendants — "التحفة" being junk implies nothing about a longer phrase,
//     and a weak score is a per-keyword reading.
//   - a root must be at most `FAMILY_ROOT_MAX_TOKENS` tokens. Brand names are
//     short; without this, retiring a 4-word brand title would blanket-block
//     every phrase that happens to start with those 4 words.
//
// Matching is on WHOLE TOKENS, never substrings: "spotify premium" is blocked
// by root "spotify", but "spotifysomething" is not (different token) and
// "best spotify alternative" is not (root is not a PREFIX — the user is
// searching for something else, and that phrase is a legitimate generic
// intent). See `isFamilyBlocked`.
//
// DEFERRED, explicitly: morphological / fuzzy family matching (plurals,
// misspellings, "spotify" vs "spotfy"), and blocking a family by any
// SUBSTRING or mid-phrase occurrence. Both need a measured false-positive
// audit against the seed corpus before they can be defended, and mid-phrase
// blocking in particular would kill legitimate comparison intents
// ("<brand> alternative") that are among the more valuable keyword shapes in
// this corpus.

/** Max token count for a retired keyword to become a family root — see section doc. */
export const FAMILY_ROOT_MAX_TOKENS = 2;

/** The only reasons whose retirement generalizes to the whole token family. */
export const FAMILY_BLOCKING_REASONS: ReadonlySet<RetirementReason> = new Set<RetirementReason>([
  "brand-lexical",
  "brand-serp-shape",
]);

/** Lowercase, trim, collapse internal whitespace — same normalization as `keyword-brand.ts`'s `normalizeBrandText`. */
function normalize(keyword: string): string {
  return keyword.toLowerCase().trim().replace(/\s+/g, " ");
}

/** Whitespace tokens of `keyword`, normalized. Empty for blank input. */
function tokens(keyword: string): readonly string[] {
  const normalized = normalize(keyword);
  return normalized.length === 0 ? [] : normalized.split(" ");
}

/**
 * Every whole-token prefix of `keyword`, shortest first, including the
 * normalized keyword itself: `"spotify premium apk"` -> `["spotify",
 * "spotify premium", "spotify premium apk"]`. Pure.
 *
 * This is the key to making the family check an INDEXED EQUALITY lookup rather
 * than a `LIKE 'root %'` scan: the caller asks the DB "which of these exact
 * strings are retired family roots?" (a primary-key probe per prefix) instead
 * of asking every root whether it prefixes the candidate.
 */
export function tokenPrefixes(keyword: string): readonly string[] {
  const parts = tokens(keyword);
  const prefixes: string[] = [];
  for (let i = 1; i <= parts.length; i++) {
    prefixes.push(parts.slice(0, i).join(" "));
  }
  return prefixes;
}

/**
 * True iff retiring `keyword` for `reason` should also block its whole token
 * family from future re-admission — a brand reason on a short keyword. Pure.
 */
export function isFamilyRootEligible(keyword: string, reason: RetirementReason): boolean {
  if (!FAMILY_BLOCKING_REASONS.has(reason)) return false;
  const tokenCount = tokens(keyword).length;
  return tokenCount > 0 && tokenCount <= FAMILY_ROOT_MAX_TOKENS;
}

/**
 * True iff `keyword` equals, or is a whole-token extension of, any root in
 * `familyRoots` (which the caller has already restricted to
 * `FAMILY_BLOCKING_REASONS` retirements). Pure.
 */
export function isFamilyBlocked(keyword: string, familyRoots: ReadonlySet<string>): boolean {
  if (familyRoots.size === 0) return false;
  return tokenPrefixes(keyword).some((prefix) => familyRoots.has(prefix));
}
