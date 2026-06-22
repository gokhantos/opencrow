-- A/B holdout arm log (Phase 4 of the idea-funnel learning loop).
--
-- Makes "the funnel gets smarter over time" MEASURABLE. Each idea-pipeline run is
-- deterministically assigned (per RUN, from a run-id-derived seed) to one of two
-- arms when smart.abHoldout is enabled:
--
--   guided : the run reads outcome-memory + graph-reasoning guidance (the
--            learned signal) and injects it at synthesis.
--   blind  : the run SKIPS those reads — guidance is blanked to "" — so it
--            generates as if the learning loop did not exist.
--
-- Comparing the validated/kept rate of guided vs blind runs is the honest lift
-- attribution. Everything defaults OFF (holdoutRatio 0 → always guided), so this
-- table stays empty and the pipeline is byte-identical until explicitly enabled.
--
-- Additive + idempotent: CREATE TABLE / INDEX IF NOT EXISTS, no FK dependency
-- (run_id is a plain TEXT PK — the same id used by pipeline_runs / generated_ideas,
-- joined logically not by a foreign key so a missing run never blocks the insert).
-- Indexes are added ONLY to this new (empty) table, so creation is instant with no
-- lock contention. Applies cleanly on every startup.

CREATE TABLE IF NOT EXISTS pipeline_run_arm (
  run_id TEXT PRIMARY KEY,
  arm TEXT NOT NULL CHECK (arm IN ('guided', 'blind')),
  holdout_ratio DOUBLE PRECISION NOT NULL,
  holdout_seed BIGINT NOT NULL,
  created_at BIGINT NOT NULL DEFAULT extract(epoch from now())::bigint
);

-- Lift aggregates scan by arm within a recent time window.
CREATE INDEX IF NOT EXISTS idx_pipeline_run_arm_arm_created
  ON pipeline_run_arm (arm, created_at);
