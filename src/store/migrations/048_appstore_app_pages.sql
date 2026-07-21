-- Stage 5 of the App Store deep-scrape build (html-enrichment): the
-- `apps.apple.com` product-page HTML lane (`app-page-parse.ts` /
-- `app-pages-store.ts` / `app-pages.ts`). Three tables, additive + idempotent,
-- epoch-seconds throughout (house convention).
--
-- `appstore_app_ratings_history` deliberately DOUBLES as this lane's
-- rolling-24h request ledger (mirrors Stage 4's `appstore_reviews` reuse
-- note: "no parallel review table") — ONE row is inserted per page-fetch
-- ATTEMPT (success, gone, or error), not just successful parses, so
-- `app-pages-store.ts`'s `countPageFetchesSince` can `COUNT(*) ... WHERE
-- observed_at >= since` directly against it rather than needing a 4th table.
-- Failed/gone attempts simply carry NULL rating fields.
--
-- `rating_counts` is written via `${JSON.stringify(x)}::jsonb` (explicit
-- cast — see `app-pages-store.ts`'s doc comment) which single-encodes
-- correctly, UNLIKE the legacy `top_apps`/`serp_tail` columns (written
-- without the cast, hence double-encoded — see migration 044's doc comment).
-- Readers here must NOT use the `#>> '{}'` unwrap those columns need.

CREATE TABLE IF NOT EXISTS appstore_app_pages (
  app_id                 TEXT PRIMARY KEY,
  -- 'hot' = signature-hit-related / currently-accelerating newborn apps,
  -- refreshed on a short cadence; 'rolling' = general corpus rotation
  -- (everything else in the app-meta registry), refreshed slowly. Mirrors
  -- `review-harvest-state.cohort`'s "daily wins" upgrade-only rule — see
  -- `app-pages-store.ts`'s `syncTrackedAppPages`.
  tier                   TEXT NOT NULL CHECK (tier IN ('hot', 'rolling')) DEFAULT 'rolling',
  tracked_since          BIGINT NOT NULL,
  last_fetched_at        BIGINT,
  last_success_at        BIGINT,
  last_status            TEXT CHECK (last_status IN ('ok', 'gone', 'error')),
  consecutive_failures   INT NOT NULL DEFAULT 0,
  -- Stamped on a verified 404 (app delisted from the storefront) and NEVER
  -- cleared — a gone app is permanently excluded from due-selection. If
  -- Apple relists it, `recordAppSightings` (Stage 2) will surface it as a
  -- fresh sighting through the registry, but this HTML lane does not itself
  -- watch for relists.
  gone_at                BIGINT,
  iap_count              INT,
  related_count          INT,
  updated_at             BIGINT NOT NULL
);

-- Backs `app-pages-store.ts`'s due-selection query: untracked-gone rows only,
-- tier-then-staleness ordered.
CREATE INDEX IF NOT EXISTS idx_appstore_app_pages_due
  ON appstore_app_pages (tier, last_fetched_at NULLS FIRST)
  WHERE gone_at IS NULL;

-- One row per page-fetch ATTEMPT (see the file-level doc comment above re:
-- ledger reuse). `rating_counts` is the 5-star-first histogram
-- `[c5,c4,c3,c2,c1]` as reported by the page's `productRatings` shelf — see
-- `app-page-parse.ts`'s `parseRatingsHistogram` for the runtime order
-- sanity-check that guards against Apple silently flipping the array order.
CREATE TABLE IF NOT EXISTS appstore_app_ratings_history (
  id              BIGSERIAL PRIMARY KEY,
  app_id          TEXT NOT NULL,
  observed_at     BIGINT NOT NULL,
  fetch_status    TEXT NOT NULL CHECK (fetch_status IN ('ok', 'gone', 'error')),
  rating_average  NUMERIC,
  total_ratings   BIGINT,
  rating_counts   JSONB
);

CREATE INDEX IF NOT EXISTS idx_appstore_app_ratings_history_app_time
  ON appstore_app_ratings_history (app_id, observed_at DESC);

-- Backs `countPageFetchesSince`'s rolling-24h ledger scan.
CREATE INDEX IF NOT EXISTS idx_appstore_app_ratings_history_time
  ON appstore_app_ratings_history (observed_at DESC);

-- Latest known related-apps edges from a product page's "similarItems"
-- (source='similar') and "moreByDeveloper" (source='developer') shelves —
-- both are Apple "Lockup" component lists (see `app-page-parse.ts`'s
-- `parseRelatedApps`). Upserted (not appended) per `(app_id, related_app_id,
-- source)` so a re-fetch refreshes rank/observed_at in place rather than
-- accumulating stale duplicate edges.
CREATE TABLE IF NOT EXISTS appstore_related_apps (
  id                 BIGSERIAL PRIMARY KEY,
  app_id             TEXT NOT NULL,
  related_app_id     TEXT NOT NULL,
  related_name       TEXT,
  related_bundle_id  TEXT,
  source             TEXT NOT NULL CHECK (source IN ('similar', 'developer')),
  rank               INT,
  observed_at        BIGINT NOT NULL,
  UNIQUE (app_id, related_app_id, source)
);

CREATE INDEX IF NOT EXISTS idx_appstore_related_apps_app
  ON appstore_related_apps (app_id);
