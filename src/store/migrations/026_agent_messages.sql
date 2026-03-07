CREATE TABLE IF NOT EXISTS agent_messages (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  from_agent_id TEXT NOT NULL,
  to_agent_id   TEXT NOT NULL,
  topic         TEXT NOT NULL DEFAULT 'general',
  payload       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consumed_at   TIMESTAMPTZ DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_pending
  ON agent_messages (to_agent_id, status, created_at)
  WHERE status = 'pending';
