-- 2026-07-22 "Batch A — App Store keyword pipeline BUDGET RESCUE". Additive +
-- idempotent. Three independent changes:
--
--   A1 (promise-tiered rescan cadence): no new column — `getStaleKeywordsTiered`
--   (keyword-store.ts) now bands each tier-1 keyword's effective staleness
--   threshold by its own recent opportunity instead of one flat
--   `tier1StaleThresholdMs` for the whole pool. The tier-1 partial index below
--   widens to cover `autocomplete` (previously only manual/seed), which is now
--   83% of the tier-1 pool and was NOT covered by the existing
--   `idx_appstore_keywords_tier1_seed` index (migration 041).
--
--   A2 (brand filter + brand-navigational classification + deactivation):
--   `brand_navigational` flags a scan whose field is dominated by one
--   title-matched incumbent (see `keyword-brand.ts`'s `isBrandNavigationalScan`,
--   consumed by `keyword-deactivation.ts` and excluded from
--   `getTopOpportunities` by default).
--
--   A3 (chunked DE storefront sweep): `last_de_scanned_at` gives the DE lane
--   its own resume cursor (`getTier1ProtectedKeywords`, ordered
--   stalest-DE-scan-first, LIMIT'd to a chunk) so a single pass no longer has
--   to walk the WHOLE ~4,000+ keyword protected pool in one sitting.

ALTER TABLE appstore_keyword_scans
  ADD COLUMN IF NOT EXISTS brand_navigational BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_appstore_keyword_scans_brand_navigational
  ON appstore_keyword_scans (brand_navigational)
  WHERE brand_navigational = TRUE;

ALTER TABLE appstore_keywords
  ADD COLUMN IF NOT EXISTS last_de_scanned_at BIGINT;

CREATE INDEX IF NOT EXISTS idx_appstore_keywords_de_resume_cursor
  ON appstore_keywords (active, last_de_scanned_at ASC NULLS FIRST)
  WHERE source IN ('manual', 'seed', 'autocomplete');

-- A1 support: widen the tier-1 partial index (migration 041, manual/seed
-- only) to also cover `autocomplete` — now the dominant tier-1 source
-- (~83% of the pool) and previously NOT covered by any partial index for
-- the priority re-scan lane's `last_scanned_at ASC NULLS FIRST` ordering.
CREATE INDEX IF NOT EXISTS idx_appstore_keywords_tier1_autocomplete
  ON appstore_keywords (active, last_scanned_at ASC NULLS FIRST)
  WHERE source IN ('manual', 'seed', 'autocomplete');
