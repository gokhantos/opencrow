-- Step liveness heartbeat. A step row was only ever 'pending' → 'completed'/'failed',
-- so an actively-executing step was indistinguishable from one that never started (the
-- UI greyed it out either way). Steps now start 'running' and refresh last_heartbeat
-- while work() runs, so slow-but-alive can be told apart from dead. Additive + idempotent.

ALTER TABLE pipeline_steps ADD COLUMN IF NOT EXISTS last_heartbeat BIGINT;

-- Surface in-flight steps with a stale heartbeat (a step whose process died mid-run).
CREATE INDEX IF NOT EXISTS idx_pipeline_steps_running_heartbeat
  ON pipeline_steps (last_heartbeat)
  WHERE status = 'running';
