-- Stage 1 of the App Store deep-scrape build (serp-rank): deeper SERP fetch
-- for hot/tier1/DE lanes (`appstoreKeywordGap.serpDepth`, config-driven,
-- default 200) plus rank persistence for the newborn-velocity time series.
-- Calibration is frozen — scoring still only ever reads the first `topN`
-- (default 20) entries; the extra depth is captured separately so it never
-- perturbs existing demand/competitiveness/opportunity numbers.
--
-- `serp_tail` (appstore_keyword_scans): the compact {id, rank} tail of a deep
-- fetch — entries at position >= topN, up to the fetched depth (see
-- `serp-tail.ts`'s `buildSerpTail`). NULL for every scan that wasn't a deep
-- fetch (the vast majority — mined-lane and legacy scans stay shallow).
-- Written via `JSON.stringify(...)` into a JSONB column the same way
-- `top_apps` already is, which DOUBLE-ENCODES it at the Postgres level (the
-- column's own `jsonb_typeof` is 'string', not 'array') — any RAW SQL reader
-- must unwrap with `(serp_tail #>> '{}')::jsonb`, mirroring `top_apps`'s
-- existing convention (see `keyword-store.ts`'s `getScannedAppNames` doc
-- comment). TS-side readers that already parse the driver's own single-string
-- return value (e.g. `rowToScan`'s `parseJson`) need only ONE `JSON.parse` —
-- see `serp-rank-store.ts`.
--
-- `rank` (appstore_app_velocity): 0-based SERP position of the observation's
-- app at the scan that produced it, nullable — NULL for any observation with
-- no SERP position of its own (e.g. Stage 2's synthetic "chart-first-seen"
-- velocity rows, which originate from a chart sighting, not a keyword scan).
-- Additive + idempotent.

ALTER TABLE appstore_keyword_scans
  ADD COLUMN IF NOT EXISTS serp_tail JSONB;

ALTER TABLE appstore_app_velocity
  ADD COLUMN IF NOT EXISTS rank INT;

CREATE INDEX IF NOT EXISTS idx_appstore_app_velocity_keyword_time
  ON appstore_app_velocity (first_seen_keyword, observed_at DESC);
