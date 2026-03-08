-- Drop survey system tables (overengineered, low value)
-- See: codebase review for rationale

DROP TABLE IF EXISTS survey_configs CASCADE;
DROP TABLE IF EXISTS survey_responses_enhanced CASCADE;
DROP TABLE IF EXISTS pending_surveys CASCADE;
DROP TABLE IF EXISTS survey_responses CASCADE;
DROP TABLE IF EXISTS agent_reflections CASCADE;
DROP TABLE IF EXISTS outcome_routing_cache CASCADE;
DROP TABLE IF EXISTS learning_events CASCADE;

-- Update agent_score_adjustments CHECK constraint to remove survey_bonus/survey_penalty
-- This will be applied on fresh installs; existing databases already had tables dropped above
-- The constraint is updated in migration 014_conversation_outcomes.sql for reference
