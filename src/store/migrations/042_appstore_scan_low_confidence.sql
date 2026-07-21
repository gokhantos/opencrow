-- 2026-07-21 audit NOW-tier fix, item C ("fix fabricated demand"): flags a
-- keyword scan as low-confidence when zero apps in the SERP title-matched
-- the keyword — i.e. demand/incumbent-weakness were computed over apps we
-- don't actually know serve this search phrase (at best a giant-excluded
-- non-matched fallback, at worst 0/NULL when every non-matched app was a
-- review-mass giant). Never derived from a title-matched field. Additive +
-- idempotent; defaults FALSE so every pre-existing row (all computed under
-- the OLD raw-SERP-fallback logic) reads as "not flagged" rather than
-- retroactively (and incorrectly) marked low-confidence — this column only
-- has meaning going forward, from scans written by the fixed `scanKeyword`.

ALTER TABLE appstore_keyword_scans
  ADD COLUMN IF NOT EXISTS low_confidence BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_appstore_keyword_scans_low_confidence
  ON appstore_keyword_scans (low_confidence)
  WHERE low_confidence = TRUE;
