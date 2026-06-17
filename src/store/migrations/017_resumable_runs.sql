-- Resumable pipeline runs — persist each completed step's structured output so a
-- run interrupted by a process restart (deploy) can be resumed from the last
-- completed step instead of failed. Additive + idempotent.

-- Full structured payload of a completed step, replayed on resume.
ALTER TABLE pipeline_steps ADD COLUMN IF NOT EXISTS output_json JSONB;

-- Bounds auto-resume so a step that reliably crashes the process cannot loop
-- forever across deploys.
ALTER TABLE pipeline_runs ADD COLUMN IF NOT EXISTS resume_attempts INT NOT NULL DEFAULT 0;

-- Fast lookup for the resume cache check (run_id, step_name) among completed steps.
CREATE INDEX IF NOT EXISTS idx_pipeline_steps_completed
  ON pipeline_steps (run_id, step_name)
  WHERE status = 'completed';
