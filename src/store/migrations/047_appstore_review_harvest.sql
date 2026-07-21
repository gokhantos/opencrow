-- Stage 4 of the App Store deep-scrape build (reviews): rolling-cohort
-- review-text harvester. Reuses the PRE-EXISTING `appstore_reviews` table
-- (no parallel review table) — adds the columns the deep multi-page
-- harvester needs (`review_date`, `storefront`, vote fields) alongside the
-- legacy hourly page-1-only path's original columns. Additive + idempotent;
-- existing rows get NULL `review_date`/vote fields and 'us' `storefront`.

ALTER TABLE appstore_reviews
  ADD COLUMN IF NOT EXISTS review_date BIGINT;

ALTER TABLE appstore_reviews
  ADD COLUMN IF NOT EXISTS storefront TEXT NOT NULL DEFAULT 'us';

ALTER TABLE appstore_reviews
  ADD COLUMN IF NOT EXISTS vote_count INT;

ALTER TABLE appstore_reviews
  ADD COLUMN IF NOT EXISTS vote_sum INT;

CREATE INDEX IF NOT EXISTS idx_appstore_reviews_review_date
  ON appstore_reviews (review_date DESC)
  WHERE review_date IS NOT NULL;

-- One row per app currently enrolled (or previously enrolled and since
-- deactivated) in the review harvester. `enrolled_via` records the
-- candidate source that FIRST enrolled the app (immutable, mirrors
-- `appstore_app_meta.first_seen_source`); `cohort` is mutable and only ever
-- upgrades daily<-weekly on a later cohort-refresh match (never downgrades
-- — see `review-harvest-scheduling.ts`'s `resolveCohort` "daily wins" doc
-- comment). `active = FALSE` (with `deactivated_at` stamped) means the app
-- went quiet (`shouldDeactivateEnrollment`) or was delisted; a later
-- cohort-refresh match reactivates it (`review-harvest-store.ts`'s
-- `upsertEnrollment`).
CREATE TABLE IF NOT EXISTS appstore_review_harvest_state (
  app_id                       TEXT PRIMARY KEY,
  enrolled_at                  BIGINT NOT NULL,
  enrolled_via                 TEXT NOT NULL CHECK (
    enrolled_via IN ('signature-hit', 'velocity', 'chart-newborn')
  ),
  cohort                       TEXT NOT NULL CHECK (cohort IN ('daily', 'weekly')),
  active                       BOOLEAN NOT NULL DEFAULT TRUE,
  -- Drives the "first-harvest legacy-remnant" rule in
  -- `review-harvest-scheduling.ts`'s `shouldStopPaging` — an app's FIRST
  -- deep harvest must not early-stop just because the legacy hourly path
  -- already wrote its page-1 review ids.
  first_harvest_done           BOOLEAN NOT NULL DEFAULT FALSE,
  last_harvested_at            BIGINT,
  last_page_reached            INT,
  consecutive_empty_harvests   INT NOT NULL DEFAULT 0,
  deactivated_at               BIGINT,
  updated_at                   BIGINT NOT NULL
);

-- Backs `review-harvest-store.ts`'s `getDueEnrollments` — active rows only,
-- ordered oldest-harvested-first.
CREATE INDEX IF NOT EXISTS idx_appstore_review_harvest_state_due
  ON appstore_review_harvest_state (last_harvested_at NULLS FIRST)
  WHERE active = TRUE;

-- Rolling ledger of harvest passes (one row per app per pass, aggregating
-- however many pages that pass fetched — NOT one row per page) — backs
-- `appstoreReviewHarvest.dailyRequestBudget`'s rolling-24h check via
-- `review-harvest-store.ts`'s `countReviewPagesFetchedSince`, mirroring
-- `appstore_lookup_requests`' role for the enrichment lane's budget.
-- Periodically pruned so it never grows unbounded.
CREATE TABLE IF NOT EXISTS appstore_review_harvests (
  id             BIGSERIAL PRIMARY KEY,
  app_id         TEXT NOT NULL,
  harvested_at   BIGINT NOT NULL,
  pages_fetched  INT NOT NULL,
  reviews_found  INT NOT NULL,
  new_reviews    INT NOT NULL,
  success        BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_appstore_review_harvests_time
  ON appstore_review_harvests (harvested_at DESC);
