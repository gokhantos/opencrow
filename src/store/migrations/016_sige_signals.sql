-- Phase 3 (SIGE hardening) — dedicated column for the independent-jury /
-- dissent / convergence / evolved signals, instead of overloading
-- giant_scores_json. Additive + idempotent.
ALTER TABLE generated_ideas ADD COLUMN IF NOT EXISTS sige_signals_json JSONB;
