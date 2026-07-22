-- Batch C ("App Store keyword DISCOVERY EXPANSION"), items C1+C2 — both
-- alter `appstore_seed_expansion_state` (migration 043), so they ship as one
-- migration.
--
-- C1 (prefix fan-out never rotates): `expandCorpus` (keyword-autocomplete.ts)
-- has always built its per-seed prefix fan-out as a FIXED
-- `PREFIX_FAN_OUT_LETTERS.slice(0, maxPrefixesPerSeed)` (default 5) — every
-- seed, every pass, forever queries only "<seed> a".."<seed> e". ~21/26 of
-- the per-seed Apple search-suggest space is never fetched. Fix: a
-- `next_prefix_offset` cursor (0..25) per (keyword, storefront) that
-- `expandCorpus` advances each pass by however many letters it actually
-- queried, wrapping around the 26-letter alphabet — the same "rotate instead
-- of re-fetching the same fixed slice forever" fix migration 043 already
-- applied at the SEED-selection level, now applied to the PREFIX level too.
--
-- C2 (one shared cursor across two independent storefront lanes): this
-- table's PK has been `keyword` alone since migration 043, but
-- `getExpansionSeeds`/`markSeedsExpanded` back TWO independent expansion
-- lanes as of the throughput wave (`runAutocompleteExpansionIfDue` for US,
-- `runGbHintsLaneIfDue` for GB — see scraper.ts) that share this same
-- keyword-only row. A keyword drawn by the GB lane rotates to the back of
-- the US lane's queue without its US hints ever being fetched, and vice
-- versa — hint popularity is inherently per-storefront (the exact reason
-- migration 049 added a `storefront` column to `appstore_autocomplete_hints`
-- in the first place). Fix: key this table by (keyword, storefront) so each
-- lane owns its own independent rotation cursor.
--
-- Additive + idempotent: `ADD COLUMN IF NOT EXISTS` backfills every existing
-- row's new `storefront` column to 'us' via the column DEFAULT (every
-- pre-migration row WAS a US-lane observation, same backfill reasoning as
-- migration 049's analogous column) and `next_prefix_offset` to 0 (the
-- pre-fix fixed-window starting point — behaviorally a no-op for the very
-- first pass after this migration lands). The constraint swap
-- (DROP IF EXISTS + ADD, both using the stable default-generated
-- `appstore_seed_expansion_state_pkey` name) is safe to re-run any number of
-- times: each run drops whatever composite/simple PK is currently there
-- (if any) and re-adds the same (keyword, storefront) composite PK.

ALTER TABLE appstore_seed_expansion_state
  ADD COLUMN IF NOT EXISTS storefront TEXT NOT NULL DEFAULT 'us';

ALTER TABLE appstore_seed_expansion_state
  ADD COLUMN IF NOT EXISTS next_prefix_offset INTEGER NOT NULL DEFAULT 0;

ALTER TABLE appstore_seed_expansion_state
  DROP CONSTRAINT IF EXISTS appstore_seed_expansion_state_pkey;

ALTER TABLE appstore_seed_expansion_state
  ADD CONSTRAINT appstore_seed_expansion_state_pkey PRIMARY KEY (keyword, storefront);
