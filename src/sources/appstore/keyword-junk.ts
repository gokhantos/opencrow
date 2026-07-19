// Junk-keyword stoplist for the `hideJunk` opportunities filter
// (see `getTopOpportunities` in keyword-store.ts).
//
// Deliberately a SEPARATE list from `keyword-miner.ts`'s STOPWORDS: that list
// is a corpus-generation filter which intentionally KEEPS generic-but-useful
// modifier words like "free"/"pro"/"app" (they're legitimate keyword
// modifiers — see keyword-corpus.ts MODIFIERS). This list is the opposite: a
// display-time filter for terms too generic to be a *buildable* keyword on
// their own. A row is only "junk" when its ENTIRE (trimmed, lowercased)
// keyword is one of these single generic words — a multi-word keyword that
// merely CONTAINS one of these tokens (e.g. "budget planner" contains no
// junk word here, but "free budget app" isn't dropped either since it's not
// a sole match) is never dropped by this list. See `getTopOpportunities`'s
// junk predicate for the short/numeric-only checks that apply alongside it.
export const JUNK_KEYWORDS: readonly string[] = Object.freeze([
  "free",
  "pro",
  "app",
  "apps",
  "best",
  "top",
  "new",
  "online",
  "mobile",
  "hd",
  "lite",
  "download",
  "game",
  "games",
  "the",
  "and",
  "for",
]);

// Extra generic-noise tokens discovered in the semantic-clustering spike
// (docs/superpowers/specs/2026-07-14-semantic-keyword-concepts-design.md).
// Left OUT of `JUNK_KEYWORDS` on purpose: these are platform/recency/quantifier
// filler ("updated", "ios", "recent", "all") that pollute *clustering* (they
// form a generic-"app"/"updated" mega-bucket) but are NOT the display-time
// buildable-keyword stoplist the opportunities `hideJunk` filter uses — keeping
// them separate leaves that endpoint's behavior untouched.
const CLUSTERING_NOISE_TOKENS: readonly string[] = Object.freeze([
  "updated",
  "update",
  "updating",
  "application",
  "applications",
  "ios",
  "iphone",
  "ipad",
  "android",
  "recent",
  "what",
  "whats",
  "more",
  "all",
  "full",
  "popular",
]);

/**
 * The generic-token stoplist used ONLY by semantic keyword clustering
 * (`keyword-clustering.ts`): `JUNK_KEYWORDS` PLUS `CLUSTERING_NOISE_TOKENS`.
 * A keyword is dropped from the clustering candidate set when EVERY one of its
 * (lowercased, whitespace-split) tokens is in this set — so a sole generic word
 * ("updated", "app") is dropped, but a real multi-word concept ("budget
 * planner") survives even if one token is generic. Distinct, and deliberately
 * broader than, `JUNK_KEYWORDS`: the opportunities `hideJunk` filter still uses
 * only `JUNK_KEYWORDS`, so this extension cannot change that endpoint.
 */
export const CLUSTERING_JUNK_KEYWORDS: readonly string[] = Object.freeze([
  ...JUNK_KEYWORDS,
  ...CLUSTERING_NOISE_TOKENS,
]);

const JUNK_KEYWORD_SET: ReadonlySet<string> = new Set(JUNK_KEYWORDS.map((w) => w.toLowerCase()));

// Purely numeric / punctuation / whitespace keywords carry no buildable signal.
const NUMERIC_OR_PUNCT_ONLY = /^[0-9\s\p{P}]+$/u;

/**
 * Pure, unit-testable mirror of the `hideJunk` SQL predicate in
 * `keyword-store.ts`'s `buildFilterClause` — kept in exact behavioral parity
 * (same three checks, same `JUNK_KEYWORDS` list) so any TS-side caller (e.g.
 * the newborn-velocity screener in `keyword-screener.ts`, which has no SQL
 * query to attach a WHERE clause to for its per-app gate logic) gets the
 * IDENTICAL junk verdict the opportunities dashboard's `hideJunk` filter would
 * give the same keyword, rather than a second, drifting definition of "junk".
 *
 * True when the keyword should be treated as junk (excluded): its entire
 * (trimmed, lowercased) text IS one of `JUNK_KEYWORDS` (not per-token — a
 * multi-word keyword merely containing a junk word is NOT junk), OR it is
 * under 3 characters, OR it is purely numeric/punctuation/whitespace.
 */
export function isJunkKeyword(keyword: string): boolean {
  const trimmed = keyword.trim().toLowerCase();
  if (trimmed.length < 3) return true;
  if (NUMERIC_OR_PUNCT_ONLY.test(trimmed)) return true;
  return JUNK_KEYWORD_SET.has(trimmed);
}
