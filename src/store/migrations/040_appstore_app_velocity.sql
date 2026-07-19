-- Newborn-velocity time-series: one row per (app, ~6h observation bucket),
-- recorded off the existing App Store keyword-gap SERP scan (see
-- keyword-gaps.ts `scanAndRecord` -> app-velocity-store.ts
-- `recordVelocityObservationsForScan`). Restricted at write-time to apps
-- younger than `NEWBORN_AGE_DAYS_MAX` (app-velocity.ts, mirrors
-- keyword-screener.ts's NEWCOMER_AGE_DAYS_MAX = 540) so the tracked-app set
-- stays bounded to apps that could plausibly still be accelerating, and
-- bucketed to at most one row per app per ~6h window (checked in TS before
-- insert — see `insertObservation`) so write volume stays bounded regardless
-- of how many different keyword scans surface the same trending app.
--
-- `first_seen_keyword` records the keyword whose scan surfaced THIS
-- particular observation row (not a special "first-ever" marker — every row
-- carries the keyword that triggered it). `name` is stored on every row
-- (cheap — already present on the scan's TopApp) rather than only the first,
-- so any row can resolve a display name without a join. Additive + idempotent.

CREATE TABLE IF NOT EXISTS appstore_app_velocity (
  app_id              TEXT NOT NULL,
  observed_at         BIGINT NOT NULL,
  reviews             INT NOT NULL,
  rating              REAL NOT NULL,
  first_seen_keyword  TEXT NOT NULL,
  name                TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (app_id, observed_at)
);

CREATE INDEX IF NOT EXISTS idx_appstore_app_velocity_app_time
  ON appstore_app_velocity (app_id, observed_at DESC);
