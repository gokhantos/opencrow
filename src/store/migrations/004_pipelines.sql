-- Pipeline execution tracking

CREATE TABLE IF NOT EXISTS pipeline_runs (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  pipeline_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  category TEXT NOT NULL DEFAULT 'mobile_app',
  config JSONB NOT NULL DEFAULT '{}',
  result_summary JSONB,
  error TEXT,
  started_at BIGINT,
  finished_at BIGINT,
  created_at BIGINT NOT NULL DEFAULT extract(epoch from now())::bigint
);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_pipeline ON pipeline_runs(pipeline_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_runs_status ON pipeline_runs(status);

-- Partial unique index: only one 'running' run per pipeline at a time
CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_runs_one_running
  ON pipeline_runs(pipeline_id) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS pipeline_steps (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  run_id TEXT NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  step_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  input_summary TEXT,
  output_summary TEXT,
  duration_ms BIGINT,
  error TEXT,
  started_at BIGINT,
  finished_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_pipeline_steps_run ON pipeline_steps(run_id);

-- Link ideas to the pipeline run that generated them
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'generated_ideas' AND column_name = 'pipeline_run_id'
  ) THEN
    ALTER TABLE generated_ideas ADD COLUMN pipeline_run_id TEXT
      REFERENCES pipeline_runs(id) ON DELETE SET NULL;
    CREATE INDEX idx_ideas_pipeline_run ON generated_ideas(pipeline_run_id);
  END IF;
END $$;
