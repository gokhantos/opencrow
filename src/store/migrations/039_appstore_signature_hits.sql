-- Newborn-velocity screener: persistent flags for keywords whose LATEST
-- App Store keyword scan (appstore_keyword_scans, migration 037) crosses the
-- validated "window-opening signature" (see keyword-screener.ts). Distinct
-- from appstore_keyword_scans (append-only history, one row per keyword per
-- scan) — this table is one row per keyword that has EVER hit the signature,
-- upserted in place so a hit's metrics/last-seen/times-seen stay current
-- without losing when it was first detected. Additive + idempotent.
--
-- `status` tracks operator triage: 'new' (never looked at) -> 'active'
-- (acknowledged, still worth watching) -> 'dismissed' (not interesting /
-- false positive). A keyword that stops matching the signature is left in
-- place at its last status/metrics rather than deleted — the screener only
-- ever upserts on a fresh hit, never removes a row.

CREATE TABLE IF NOT EXISTS appstore_signature_hits (
  keyword             TEXT PRIMARY KEY,
  first_detected_at   BIGINT NOT NULL,
  last_seen_at        BIGINT NOT NULL,
  times_seen          INT NOT NULL DEFAULT 1,
  status              TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'active', 'dismissed')),
  -- Latest metric snapshot, refreshed on every re-hit — see computeSignature.
  competitiveness     REAL,
  demand              REAL,
  trend               TEXT,
  newcomer_rpd        REAL,
  established_rpd     REAL,
  velocity_ratio      REAL,
  fast_newcomers      INT,
  accelerating_apps   INT,
  max_reviews         INT,
  genre_zone          TEXT,
  top_apps_snapshot   JSONB
);

CREATE INDEX IF NOT EXISTS idx_appstore_signature_hits_status
  ON appstore_signature_hits (status, last_seen_at DESC);
