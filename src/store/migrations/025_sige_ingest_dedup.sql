-- Exact-dedup table for SIGE ingestion.
-- Each row records the SHA-256 hash of a normalised piece of content that has
-- already been seen (dropped by quality gate OR successfully ingested into mem0).
-- Primary-key lookup is O(log n) and the table acts as a permanent bloom
-- filter so re-scraped duplicates are never sent to mem0 a second time.
-- Idempotent: CREATE TABLE IF NOT EXISTS is safe to re-run.
CREATE TABLE IF NOT EXISTS sige_ingest_dedup (
  content_hash text      PRIMARY KEY,
  source       text      NOT NULL,
  created_at   integer   NOT NULL DEFAULT extract(epoch FROM now())::integer
);
