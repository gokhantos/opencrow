DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'task_queue') THEN
    ALTER TABLE task_queue ADD COLUMN IF NOT EXISTS retry_count INT NOT NULL DEFAULT 0;
    ALTER TABLE task_queue ADD COLUMN IF NOT EXISTS max_retries INT NOT NULL DEFAULT 3;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS dead_tasks (
  queue_id       TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL,
  session_id     TEXT NOT NULL,
  domain         TEXT NOT NULL,
  task           TEXT NOT NULL,
  priority       INTEGER NOT NULL DEFAULT 5,
  preferred_agent TEXT,
  assigned_agent TEXT,
  error_message  TEXT,
  retry_count    INT NOT NULL DEFAULT 0,
  enqueued_at    TIMESTAMPTZ NOT NULL,
  dead_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dead_tasks_created
  ON dead_tasks (dead_at DESC);
