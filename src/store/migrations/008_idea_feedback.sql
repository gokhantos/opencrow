-- Append-only event log of idea lifecycle / feedback events.
-- This is the learning substrate: every stage transition and human signal
-- (saved, dismissed, built, rated) is recorded immutably so downstream
-- learning loops (validated-exemplar few-shot, per-source credibility,
-- eval aggregation) can replay the history instead of only seeing the
-- current projected pipeline_stage on generated_ideas.

CREATE TABLE IF NOT EXISTS idea_feedback (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  idea_id TEXT NOT NULL REFERENCES generated_ideas(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  rating INTEGER,
  actor TEXT,
  run_id TEXT,
  prompt_version TEXT,
  model TEXT,
  created_at BIGINT NOT NULL DEFAULT extract(epoch from now())::bigint,
  CONSTRAINT idea_feedback_kind_check CHECK (
    kind IN ('validated', 'archived', 'restored', 'saved', 'dismissed', 'built', 'rated')
  ),
  CONSTRAINT idea_feedback_rating_check CHECK (rating IS NULL OR (rating >= 0 AND rating <= 5))
);

CREATE INDEX IF NOT EXISTS idx_idea_feedback_idea ON idea_feedback(idea_id);
CREATE INDEX IF NOT EXISTS idx_idea_feedback_kind_created ON idea_feedback(kind, created_at DESC);
