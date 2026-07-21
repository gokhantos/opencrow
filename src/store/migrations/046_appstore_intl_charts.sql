-- Stage 3 of the App Store deep-scrape build (charts): international
-- storefront chart sweep (GB/CA/AU by default — `appstoreSync.intlCharts`).
-- Adds a `storefront` column to `appstore_ranking_history` so intl-storefront
-- chart rows can share the SAME `list_type` tags (e.g. "top-free-6000") as
-- the existing US rows without colliding — every reader that assumes "the
-- latest row per (app_id, list_type) is the US one" MUST now filter
-- `storefront = 'us'` (see `store.ts`'s `getRankings` / `getRankingsByCategory`
-- doc comments). Lowercase cc convention (build plan §0.5) — 'us', 'gb',
-- 'ca', 'au'. Additive + idempotent; existing rows default to 'us' (the only
-- storefront that existed before this migration).
--
-- Charts' own `appstore_app_first_seen` table + first-seen queue is
-- DELETED from scope (build plan §0.1) — the app-meta registry
-- (`appstore_app_meta`, migration 045) is the single "every app id we ever
-- see" registry; intl chart sightings feed it via `recordAppSightings(rows,
-- 'chart-intl', { storefront })`.

ALTER TABLE appstore_ranking_history
  ADD COLUMN IF NOT EXISTS storefront TEXT NOT NULL DEFAULT 'us';

CREATE INDEX IF NOT EXISTS idx_appstore_ranking_history_sf_list
  ON appstore_ranking_history (storefront, list_type, scraped_at DESC);
