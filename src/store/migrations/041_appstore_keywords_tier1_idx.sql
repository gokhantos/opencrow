-- Supporting partial index for the priority re-scan lane's tier-1 selection
-- (see keyword-tiering.ts / keyword-store.ts `getStaleKeywordsTiered`):
-- manual/seed keywords due for a re-scan (stalest-first). The signature-hits
-- branch of tier 1 (keyword present in appstore_signature_hits with
-- status != 'dismissed') needs no extra index here — it's a small table
-- keyed by its own PRIMARY KEY (keyword), so Postgres can satisfy that half
-- of the OR via a cheap semi-join without touching this index. Additive +
-- idempotent.

CREATE INDEX IF NOT EXISTS idx_appstore_keywords_tier1_seed
  ON appstore_keywords (active, last_scanned_at ASC NULLS FIRST)
  WHERE source IN ('manual', 'seed');
