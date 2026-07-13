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
