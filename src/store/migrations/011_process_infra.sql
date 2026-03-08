CREATE TABLE IF NOT EXISTS process_registry (
    name TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    last_heartbeat INTEGER NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}'
  );

CREATE TABLE IF NOT EXISTS process_commands (
    id TEXT PRIMARY KEY,
    target TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('restart','stop','cron:run_job')),
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER),
    acknowledged_at INTEGER DEFAULT NULL
  );

CREATE INDEX IF NOT EXISTS idx_process_commands_target
    ON process_commands(target, acknowledged_at);

CREATE TABLE IF NOT EXISTS cron_deliveries (
    id TEXT PRIMARY KEY,
    channel TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    job_name TEXT NOT NULL,
    text TEXT NOT NULL,
    preformatted BOOLEAN NOT NULL DEFAULT FALSE,
    created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER),
    delivered_at INTEGER DEFAULT NULL
  );

CREATE INDEX IF NOT EXISTS idx_cron_deliveries_pending
    ON cron_deliveries(channel, delivered_at);

CREATE TABLE IF NOT EXISTS process_logs (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    process_name TEXT NOT NULL,
    level TEXT NOT NULL,
    context TEXT NOT NULL,
    message TEXT NOT NULL,
    data_json TEXT,
    created_at INTEGER NOT NULL
  );

CREATE INDEX IF NOT EXISTS idx_process_logs_lookup
    ON process_logs(created_at DESC, process_name, level);

CREATE INDEX IF NOT EXISTS idx_process_logs_context
    ON process_logs(context, created_at DESC);

CREATE TABLE IF NOT EXISTS token_usage (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    model TEXT NOT NULL,
    provider TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT '',
    chat_id TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'message',
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    tool_use_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW())::INTEGER)
  );

CREATE INDEX IF NOT EXISTS idx_token_usage_agent ON token_usage(agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_token_usage_created ON token_usage(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_token_usage_source ON token_usage(source, created_at DESC);

DO $$ BEGIN
  ALTER TABLE process_commands DROP CONSTRAINT IF EXISTS process_commands_action_check;
  ALTER TABLE process_commands ADD CONSTRAINT process_commands_action_check CHECK(action IN ('restart','stop','cron:run_job'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
