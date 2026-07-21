-- 2026-07-21 audit NOW-tier fix, item D ("unfreeze autocomplete + persist
-- ranks"). Two additive, idempotent pieces:
--
-- 1. Seed rotation state: `getDiverseZoneSample`/`getWinnerKeywords` (the
--    autocomplete expansion seed sources, keyword-store.ts) had zero
--    rotation state, so the same ~25 seeds got re-fetched every pass and
--    corpus growth flatlined (76/0/26/4/7/14 keywords added across
--    consecutive live runs — collapsing toward zero). This is a DEDICATED,
--    sparse state table (not a column on `appstore_keywords`) — only the
--    small fraction of the corpus ever selected as an expansion seed
--    (winners + diverse picks) needs tracking, and "when was this keyword
--    last used as a SEED" is a distinct concern from
--    `appstore_keywords.last_scanned_at` (SERP-scan cadence).
--
-- 2. Autocomplete rank hints: an append-only log of every (seed, term, rank)
--    triple Apple's search-suggest endpoint returns. Apple's response order
--    IS a real, giant-free popularity signal — previously computed
--    (`HintCandidate.rank`) but discarded entirely before `upsertKeywords`
--    (only the term survived). `seed` is the exact query string sent to
--    Apple (the bare expansion seed, or a prefix-fan-out query built from
--    it — see `keyword-autocomplete.ts`'s `expandCorpus`), so this table
--    covers both.

CREATE TABLE IF NOT EXISTS appstore_seed_expansion_state (
  keyword          TEXT PRIMARY KEY,
  last_expanded_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS appstore_autocomplete_hints (
  id      BIGSERIAL PRIMARY KEY,
  seed    TEXT NOT NULL,
  term    TEXT NOT NULL,
  rank    INT NOT NULL,
  seen_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_appstore_autocomplete_hints_term
  ON appstore_autocomplete_hints (term, seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_appstore_autocomplete_hints_seed
  ON appstore_autocomplete_hints (seed, seen_at DESC);
