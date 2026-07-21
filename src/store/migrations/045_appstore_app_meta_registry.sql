-- Stage 2 of the App Store deep-scrape build (metadata): the app-meta
-- registry — "every app id we ever see", drained by ONE batched
-- Lookup-API enrichment pass. Per the build plan's §0.1 registry
-- unification, this table is the SINGLE first-seen registry for the whole
-- deep-scrape build: charts (Stage 3) and the keyword-gap scanner both call
-- `recordAppSightings` into it rather than maintaining their own private
-- first-seen tables. Additive + idempotent.
--
-- `first_seen_source` intentionally includes 'velocity' and 'backfill' even
-- though no Stage-2 caller writes those values yet ('velocity' is reserved
-- for a future direct link from `appstore_app_velocity`; 'backfill' is used
-- by the one-shot `backfillRegistry()` seed of pre-existing
-- `appstore_apps` rows) — the CHECK constraint is written once, up front,
-- to the full source vocabulary the build plan specifies (§0.3) so later
-- stages ('chart-intl' — Stage 3) never need an ALTER TABLE to widen it.
--
-- `enriched_at IS NULL` is the primary "due for enrichment" signal (see
-- `app-meta-store.ts`'s `selectDueForEnrichment`) — a partial index keeps
-- that lookup index-friendly as the registry grows into the hundreds of
-- thousands of rows the discovery/chart lanes accumulate.
CREATE TABLE IF NOT EXISTS appstore_app_meta (
  id                            TEXT PRIMARY KEY,
  name                          TEXT NOT NULL DEFAULT '',
  first_seen_at                 BIGINT NOT NULL,
  first_seen_source             TEXT NOT NULL CHECK (
    first_seen_source IN ('serp', 'chart', 'chart-intl', 'discovery', 'velocity', 'portfolio', 'backfill')
  ),
  first_seen_storefront         TEXT NOT NULL DEFAULT 'us',
  first_seen_keyword            TEXT,
  last_seen_at                  BIGINT NOT NULL,
  enriched_at                   BIGINT,
  release_date                  TEXT,
  current_version_release_date  TEXT,
  version                       TEXT,
  genre_id                      TEXT,
  genre_name                    TEXT,
  price                         REAL,
  formatted_price               TEXT,
  rating_count                  INT,
  average_rating                REAL,
  artist_id                     TEXT,
  artist_name                   TEXT,
  bundle_id                     TEXT,
  track_view_url                TEXT,
  artwork_url                   TEXT,
  miss_count                    INT NOT NULL DEFAULT 0,
  delisted_at                   BIGINT,
  relisted_at                   BIGINT,
  updated_at                    BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_appstore_app_meta_due_enrichment
  ON appstore_app_meta (enriched_at)
  WHERE enriched_at IS NULL AND delisted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_appstore_app_meta_artist
  ON appstore_app_meta (artist_id)
  WHERE artist_id IS NOT NULL;

-- Drained by Stage 4's review harvester (`getChartNewbornCandidates`):
-- registry rows sourced from a chart/discovery sighting, filtered by
-- `release_date` newborn-ness.
CREATE INDEX IF NOT EXISTS idx_appstore_app_meta_first_seen_source
  ON appstore_app_meta (first_seen_source, release_date);

-- Event log for `app-meta-types.ts`'s `detectMetaEvents` (price changes,
-- rating-count spikes, developer changes, delist/relist) — one row per
-- detected event, diffed at enrichment time against the registry's prior
-- values. Append-only audit trail; never updated in place.
CREATE TABLE IF NOT EXISTS appstore_app_meta_events (
  id            BIGSERIAL PRIMARY KEY,
  app_id        TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  detected_at   BIGINT NOT NULL,
  old_value     TEXT,
  new_value     TEXT
);

CREATE INDEX IF NOT EXISTS idx_appstore_app_meta_events_app_time
  ON appstore_app_meta_events (app_id, detected_at DESC);

-- Developer/artist registry, populated by lookup enrichment
-- (`artist_id`/`artist_name` on `appstore_app_meta`) and drained by the
-- portfolio pass (`app-enrichment.ts`'s `runPortfolioPass`,
-- `fetchArtistPortfolio` in `app-lookup.ts`) to discover sibling apps by
-- the same developer — sightings recorded with source 'portfolio'.
CREATE TABLE IF NOT EXISTS appstore_developers (
  artist_id                TEXT PRIMARY KEY,
  name                      TEXT NOT NULL DEFAULT '',
  last_portfolio_scan_at    BIGINT,
  app_count                 INT NOT NULL DEFAULT 0,
  updated_at                BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_appstore_developers_due_portfolio_scan
  ON appstore_developers (last_portfolio_scan_at NULLS FIRST);

-- Rolling ledger of outbound Lookup-API requests (one row per HTTP request,
-- not per app id) — backs `appstoreAppEnrichment.dailyRequestBudget`'s
-- rolling-24h check (mirrors `appstore_keyword_scans`' role for
-- `dailyKeywordBudget`) and is periodically pruned (see
-- `app-meta-store.ts`'s `pruneLookupRequestLedger`) so it never grows
-- unbounded.
CREATE TABLE IF NOT EXISTS appstore_lookup_requests (
  id             BIGSERIAL PRIMARY KEY,
  requested_at   BIGINT NOT NULL,
  request_type   TEXT NOT NULL CHECK (request_type IN ('lookup', 'portfolio')),
  id_count       INT NOT NULL,
  success        BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_appstore_lookup_requests_requested_at
  ON appstore_lookup_requests (requested_at DESC);
