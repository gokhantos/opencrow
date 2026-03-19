-- Allow multiple concurrent pipeline runs (remove the one-running-per-pipeline lock)
DROP INDEX IF EXISTS idx_pipeline_runs_one_running;
