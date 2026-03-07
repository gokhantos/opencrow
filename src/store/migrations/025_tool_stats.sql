CREATE TABLE IF NOT EXISTS tool_stats (
  agent_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  success_count INT NOT NULL DEFAULT 0,
  failure_count INT NOT NULL DEFAULT 0,
  last_failure_at INT DEFAULT NULL,
  last_failure_error TEXT DEFAULT NULL,
  updated_at INT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INT),
  PRIMARY KEY (agent_id, tool_name)
);
