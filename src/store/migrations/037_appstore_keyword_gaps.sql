-- App Store keyword-gap scanner: the seed corpus of search terms to scan and a
-- per-run snapshot of each term's supply/demand profile. Additive + idempotent.
-- `appstore_keyword_scans` keeps history (one row per keyword per scan run) so
-- `trend` is computable and the dashboard can sparkline. `store` is present from
-- day one so Play Store is a data-only follow-up (default 'app').

CREATE TABLE IF NOT EXISTS appstore_keywords (
  keyword         TEXT PRIMARY KEY,
  genre_zone      TEXT NOT NULL,
  source          TEXT NOT NULL DEFAULT 'seed',   -- seed|autocomplete|manual|pipeline
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      BIGINT NOT NULL,
  last_scanned_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_appstore_keywords_slice
  ON appstore_keywords (active, genre_zone, last_scanned_at ASC NULLS FIRST);

CREATE TABLE IF NOT EXISTS appstore_keyword_scans (
  id                 BIGSERIAL PRIMARY KEY,
  keyword            TEXT NOT NULL,
  store              TEXT NOT NULL DEFAULT 'app',
  scanned_at         BIGINT NOT NULL,
  competitiveness    REAL NOT NULL,
  demand             REAL NOT NULL,
  incumbent_weakness REAL NOT NULL,
  opportunity        REAL NOT NULL,
  trend              TEXT NOT NULL,
  top_app_reviews    INTEGER NOT NULL,
  avg_rating         REAL NOT NULL,
  avg_age_days       REAL NOT NULL,
  top_apps           JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_appstore_keyword_scans_history
  ON appstore_keyword_scans (keyword, store, scanned_at DESC);

CREATE INDEX IF NOT EXISTS idx_appstore_keyword_scans_top
  ON appstore_keyword_scans (scanned_at DESC, opportunity DESC);
