-- 2026-07-21 throughput wave, item 3 ("hint breadth"): the autocomplete
-- corpus-discovery lane gains a second, GB-storefront pass
-- (keyword-autocomplete.ts's `expandCorpus`, called with
-- `X-Apple-Store-Front` set to the GB header value) writing into the SAME
-- `appstore_autocomplete_hints` table (migration 043) rather than a parallel
-- table — a hint row is meaningful per-storefront (Apple's popularity
-- ranking differs by market), so `storefront` distinguishes which market a
-- given (seed, term, rank) triple was observed in. Guarded (`ADD COLUMN IF
-- NOT EXISTS`) and backfilled to `'us'` via the column DEFAULT — every
-- pre-migration row was, in fact, a US-storefront observation (the US lane
-- predates this migration), so defaulting existing NULLs to 'us' is
-- correct, not just a safe placeholder. Additive + idempotent.

ALTER TABLE appstore_autocomplete_hints
  ADD COLUMN IF NOT EXISTS storefront TEXT NOT NULL DEFAULT 'us';

CREATE INDEX IF NOT EXISTS idx_appstore_autocomplete_hints_storefront
  ON appstore_autocomplete_hints (storefront, seen_at DESC);

-- Throughput wave, item 2 ("newborn re-observation lane"): the daily
-- lookup-driven re-observation pass (`newborn-reobservation.ts`) selects its
-- work list via a `GROUP BY app_id` scan of `appstore_app_velocity` (see
-- `app-velocity-store.ts`'s `getNewbornVelocityAppIds`) — the existing
-- `idx_appstore_app_velocity_app_time (app_id, observed_at DESC)` index
-- already covers this (a `GROUP BY` on its leading column), so no additional
-- index is required; this comment exists only to record that the query
-- pattern was checked against migration 040's index before this lane was
-- added, per the deep-scrape build's "check first" convention.
