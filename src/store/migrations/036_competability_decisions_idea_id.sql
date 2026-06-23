-- Add nullable `idea_id` column to competability_decisions (prereq #1 for
-- graphFeedback rollout).
--
-- Motivation: the calibration query currently JOINs on a truncated idea_title,
-- which is ambiguous and fragile.  A real foreign key to `generated_ideas.id`
-- allows future calibration/feedback queries to JOIN decisions → ideas cleanly.
--
-- Nullability contract:
--   • SIGE path    → idea.id IS in scope at gate time → populated (non-null).
--   • Pipeline path → DB id is NOT assigned until AFTER the competability gate;
--                     candidates are in-memory structs at gate time, not yet
--                     persisted rows → null by design.  A future backfill could
--                     match on (pipeline_run_id, idea_title) if ever needed.
--   • Old rows      → null (column added after the fact, no backfill).
--
-- Additive + idempotent: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
ALTER TABLE competability_decisions
  ADD COLUMN IF NOT EXISTS idea_id TEXT;

CREATE INDEX IF NOT EXISTS idx_competability_decisions_idea_id
  ON competability_decisions (idea_id);
