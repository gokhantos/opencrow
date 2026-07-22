-- Batch D (App Store keyword SIGNAL FIDELITY): makes the write-only
-- `appstore_autocomplete_hints` table (migration 043) readable as a sound
-- demand-confidence signal, instead of the sole non-test statement touching
-- it being the INSERT (see `keyword-store.ts`'s `insertAutocompleteHints`).
--
-- 1. `kept` (BOOLEAN): before this migration, `expandCorpus`
--    (keyword-autocomplete.ts) only persisted a hint row for terms that
--    survived `buildCandidatesFromHints`' junk/length/dedup filter and the
--    per-seed cap — so an ABSENT term in the log could mean "Apple never
--    suggested it" OR "it was suggested but filtered out or past the cap",
--    making rank gaps ambiguous and absence-based reasoning unsound. Going
--    forward every parsed term is logged (see `expandCorpus`'s updated
--    `classifyHintTerms`), `kept` distinguishing the two. Defaults TRUE:
--    every pre-migration row was, by construction, one that passed the
--    filter (that's the only kind ever persisted before this migration), so
--    backfilling existing rows to `kept = TRUE` is correct, not just a safe
--    placeholder.
--
-- 2. `hint_best_rank` / `hint_seed_count` on `appstore_keyword_scans`: the
--    per-scan snapshot of that keyword's autocomplete hint evidence at scan
--    time (see `keyword-store.ts`'s `getHintEvidence` and
--    `keyword-gaps.ts`'s `computeGapProfile`) — surfaced on the
--    opportunities API/dashboard and consumed by the demand-confidence
--    multiplier. NULL means "no evidence in the lookback window" (sampling
--    gap), never "confirmed zero volume" — see `getHintEvidence`'s doc
--    comment. Additive + idempotent; NULL on every pre-migration row and on
--    any row written before this feature's rollout.

ALTER TABLE appstore_autocomplete_hints
  ADD COLUMN IF NOT EXISTS kept BOOLEAN NOT NULL DEFAULT TRUE;

-- Backs `getHintEvidence`'s coverage check (`SELECT DISTINCT seed ... WHERE
-- seen_at >= window AND seed = ANY(candidates)`) and `pruneAutocompleteHints`'
-- retention sweep — both filter on `seen_at` without a leading `term`/`seed`
-- predicate, which the existing `(term, seen_at DESC)` / `(seed, seen_at
-- DESC)` / `(storefront, seen_at DESC)` indexes (migrations 043/049) don't
-- serve efficiently on their own.
CREATE INDEX IF NOT EXISTS idx_appstore_autocomplete_hints_seen_at
  ON appstore_autocomplete_hints (seen_at DESC);

ALTER TABLE appstore_keyword_scans
  ADD COLUMN IF NOT EXISTS hint_best_rank SMALLINT NULL;

ALTER TABLE appstore_keyword_scans
  ADD COLUMN IF NOT EXISTS hint_seed_count SMALLINT NULL;
