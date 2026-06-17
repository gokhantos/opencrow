-- Decaying consumption ledger.
--
-- Replaces the old consume-once semantics: a consumed signal's "consumed"
-- weight now decays over time. Strongly-corroborated signals that have been
-- consumed many times decay slower; a signal whose decayed weight has fallen
-- below the resurfacing threshold becomes eligible again so genuinely fresh
-- corroboration can re-surface it.
--
-- Additive + idempotent. consumption_count counts how many distinct pipeline
-- runs have consumed the signal; last_used_at is the most recent consume time
-- (epoch seconds, matching consumed_at / pipeline_runs convention). Existing
-- rows are backfilled to a single consumption whose last_used_at equals the
-- original consumed_at, so default behaviour stays close to today.
ALTER TABLE pipeline_consumed_signals
  ADD COLUMN IF NOT EXISTS consumption_count INTEGER NOT NULL DEFAULT 1;

ALTER TABLE pipeline_consumed_signals
  ADD COLUMN IF NOT EXISTS last_used_at BIGINT;

-- Backfill last_used_at for pre-existing rows from consumed_at (idempotent:
-- only touches rows where the new column is still NULL).
UPDATE pipeline_consumed_signals
  SET last_used_at = consumed_at
  WHERE last_used_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_consumed_last_used
  ON pipeline_consumed_signals(source_table, last_used_at);
