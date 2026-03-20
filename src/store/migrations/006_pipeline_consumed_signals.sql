-- Track which source rows have been consumed by pipeline runs
-- so future runs select fresh data instead of the same top-N rows.
CREATE TABLE IF NOT EXISTS pipeline_consumed_signals (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  pipeline_run_id TEXT NOT NULL,
  source_table TEXT NOT NULL,
  source_id TEXT NOT NULL,
  consumed_at BIGINT NOT NULL DEFAULT extract(epoch from now())::bigint
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_consumed_unique ON pipeline_consumed_signals(source_table, source_id);
CREATE INDEX IF NOT EXISTS idx_consumed_table ON pipeline_consumed_signals(source_table, consumed_at);
