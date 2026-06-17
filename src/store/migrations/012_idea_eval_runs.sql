-- Offline ideas-pipeline eval snapshots.
--
-- The eval harness (src/pipelines/ideas/eval) reads generated_ideas +
-- idea_feedback and emits run-level aggregates (mean novelty/feasibility/
-- groundedness from persisted critique sub-scores, %killed, %human-validated,
-- dedup precision/recall) plus any LLM-as-judge re-scores. Each invocation
-- appends ONE immutable snapshot row here, which doubles as the trailing
-- baseline for regression-alert comparison.
--
-- Kept separate from pipeline_runs.result_summary because eval is an OFFLINE
-- process, not a pipeline run: it can score ideas spanning many runs and is
-- triggered on its own cadence. Additive + idempotent.
CREATE TABLE IF NOT EXISTS idea_eval_runs (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  -- Optional scope: when the snapshot covers a single pipeline run.
  pipeline_run_id TEXT,
  -- Optional category scope (NULL = all categories).
  category TEXT,
  -- Number of ideas the aggregate was computed over.
  total_ideas INTEGER NOT NULL DEFAULT 0,
  -- Full EvalAggregate (mean sub-scores, outcome rates, dedup quality) as JSON.
  aggregate_json JSONB NOT NULL DEFAULT '{}',
  -- Regression alerts detected vs the trailing baseline, as JSON array.
  alerts_json JSONB NOT NULL DEFAULT '[]',
  -- Whether the LLM-as-judge re-scoring was run for this snapshot.
  judge_enabled BOOLEAN NOT NULL DEFAULT false,
  created_at BIGINT NOT NULL DEFAULT extract(epoch from now())::bigint
);

CREATE INDEX IF NOT EXISTS idx_idea_eval_runs_created
  ON idea_eval_runs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_idea_eval_runs_category
  ON idea_eval_runs(category, created_at DESC);
