-- Hot-query performance indexes (B5)
-- All statements are idempotent (CREATE INDEX IF NOT EXISTS).
--
-- 1. Composite index on generated_ideas(pipeline_stage, created_at DESC)
--    Used by the pipeline-ideas list query that filters by stage and orders by
--    recency. Avoids a full table scan when the stage filter is applied.
--
-- 2. Covering index on generated_ideas(pipeline_run_id, id)
--    Used by the run-list COUNT / GROUP BY query in getPipelineRunsList:
--      SELECT p.id, COUNT(g.id)
--      FROM pipeline_runs p LEFT JOIN generated_ideas g ON g.pipeline_run_id = p.id
--    With this index Postgres can satisfy the join + count purely from the index
--    without touching the heap.

CREATE INDEX IF NOT EXISTS idx_ideas_stage_created
  ON generated_ideas (pipeline_stage, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ideas_run_id_covering
  ON generated_ideas (pipeline_run_id, id);
