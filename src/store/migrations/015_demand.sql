-- Demand-side grounding: persist the structured, CITED demand evidence bound to
-- each idea so the GIANT demand / why-now axes are scored on real buyer-intent
-- (extracted deterministically from existing scraped tables) instead of LLM
-- guesses. Phase 2 of the great-idea-pipeline plan.
--
-- Additive + idempotent. demand_json holds the full DemandArtifact (score 0..5,
-- confidence 0..1, whitespace 0..1, and the evidence[] array of cited matches).
-- demand_score / whitespace are flattened out for fast filtering + ranking.
-- segment is the candidate segment (consumer / b2b_saas / devtools / ...) which
-- was computed in the generate-wide pool but had no column to land in.
ALTER TABLE generated_ideas
  ADD COLUMN IF NOT EXISTS segment TEXT;

ALTER TABLE generated_ideas
  ADD COLUMN IF NOT EXISTS demand_json JSONB;

ALTER TABLE generated_ideas
  ADD COLUMN IF NOT EXISTS demand_score REAL;

ALTER TABLE generated_ideas
  ADD COLUMN IF NOT EXISTS whitespace REAL;

-- Indexes for ranking by demand strength and filtering/grouping by segment.
CREATE INDEX IF NOT EXISTS idx_generated_ideas_demand_score
  ON generated_ideas (demand_score DESC);

CREATE INDEX IF NOT EXISTS idx_generated_ideas_segment
  ON generated_ideas (segment);
