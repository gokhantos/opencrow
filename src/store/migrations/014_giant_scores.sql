-- GIANT rubric scores: persist the single shared optimization target so every
-- pipeline stage can score against the same 7-axis rubric and we can review
-- shadow-mode kill decisions.
--
-- Additive + idempotent. The full per-axis GIANT scores (acuteProblem, whyNow,
-- demand, nonObviousness, defensibility, marketShape, founderFit) plus per-axis
-- evidence citations are stored as JSONB in giant_scores_json. why_now_json
-- holds the dated, source-bound enabling shifts. archetype is the Sequoia tag
-- ("hair-on-fire" | "hard-fact" | "future-vision"). pain_severity mirrors the
-- acuteProblem axis for fast filtering. giant_composite is the non-compensatory
-- weighted geometric mean (0..5); giant_gated records whether the hard gates
-- (acuteProblem<=1 OR whyNow<=1) or the demand evidence-gate would drop the idea
-- (shadow-mode: stored but not enforced unless smart.giant.enforceGates).
ALTER TABLE generated_ideas
  ADD COLUMN IF NOT EXISTS giant_scores_json JSONB;

ALTER TABLE generated_ideas
  ADD COLUMN IF NOT EXISTS why_now_json JSONB;

ALTER TABLE generated_ideas
  ADD COLUMN IF NOT EXISTS archetype TEXT;

ALTER TABLE generated_ideas
  ADD COLUMN IF NOT EXISTS pain_severity REAL;

ALTER TABLE generated_ideas
  ADD COLUMN IF NOT EXISTS giant_composite REAL;

ALTER TABLE generated_ideas
  ADD COLUMN IF NOT EXISTS giant_gated BOOLEAN;

-- Indexes for reviewing kill-logs and ranking by composite.
CREATE INDEX IF NOT EXISTS idx_generated_ideas_giant_gated
  ON generated_ideas (giant_gated);

CREATE INDEX IF NOT EXISTS idx_generated_ideas_giant_composite
  ON generated_ideas (giant_composite DESC);
