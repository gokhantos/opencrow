-- Competability decision AUDIT log — every gate evaluation, KEPT or KILLED.
--
-- Migration 027 persists the competability scorecard on `generated_ideas`, but
-- ENFORCE mode DROPS killed ideas BEFORE they ever reach `generated_ideas` (the
-- `continue` in the pipeline Pass-3 critique and the SIGE gate). The calibration
-- backtest therefore reads a SURVIVOR-BIASED sample (only ideas that PASSED the
-- gate), so the observed kill-rate is structurally ~0 and the recommended
-- threshold is meaningless.
--
-- This table captures the COMPLETE population: one row per evaluated idea at the
-- point competability is decided — whether or not it survives the gate. The
-- calibration query reads from here instead of `generated_ideas` so the kill-rate
-- curve / gatedFraction / recommended threshold become meaningful.
--
--   source                   : 'pipeline' (Pass-3 critique) | 'sige' (cross-write gate).
--   pipeline_run_id           : set for the pipeline path (nullable).
--   session_id                : set for the SIGE path (nullable).
--   idea_title                : truncated idea title (display / debugging only).
--   competability_overall     : the EFFECTIVE (decided) overall the gate acted on.
--   competability_raw_overall : the RAW (pre-builder-profile) overall, nullable.
--   competability_json         : full scorecard — dims + raw + reason +
--                               matchedExpertiseDomain + gated.
--   gated                     : did the competability gate reject this idea.
--   enforced                  : was enforce mode on at decision time.
--   decided_at                : epoch SECONDS (matches the codebase `now()` helper,
--                               same convention as generated_ideas.created_at).
--
-- Additive + idempotent: CREATE TABLE / INDEX IF NOT EXISTS, no dependency on any
-- other relation, applies cleanly on every startup.
CREATE TABLE IF NOT EXISTS competability_decisions (
  id BIGSERIAL PRIMARY KEY,
  pipeline_run_id TEXT,
  session_id TEXT,
  source TEXT NOT NULL,
  idea_title TEXT NOT NULL,
  competability_overall REAL NOT NULL,
  competability_raw_overall REAL,
  competability_json JSONB NOT NULL,
  gated BOOLEAN NOT NULL,
  enforced BOOLEAN NOT NULL,
  decided_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_competability_decisions_decided_at
  ON competability_decisions (decided_at);

CREATE INDEX IF NOT EXISTS idx_competability_decisions_pipeline_run
  ON competability_decisions (pipeline_run_id);

CREATE INDEX IF NOT EXISTS idx_competability_decisions_session
  ON competability_decisions (session_id);
