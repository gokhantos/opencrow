-- Idea quality metadata: persist the per-idea critique sub-scores plus the
-- prompt version and model that produced each idea, so learning loops and
-- credit-assignment can attribute outcomes back to the generating prompt/model.
--
-- Additive + idempotent (smart ideas pipeline). The critique sub-scores
-- (specificity / signalGrounding / differentiation / buildability) are stored
-- as JSONB; prompt_version and model are free-text tags.
ALTER TABLE generated_ideas
  ADD COLUMN IF NOT EXISTS critique_subscores_json JSONB;

ALTER TABLE generated_ideas
  ADD COLUMN IF NOT EXISTS prompt_version TEXT;

ALTER TABLE generated_ideas
  ADD COLUMN IF NOT EXISTS model TEXT;
