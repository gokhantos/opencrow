-- All tables from this migration were dropped in 032_drop_survey_tables.sql:
-- survey_configs, survey_responses_enhanced, agent_reflections,
-- outcome_routing_cache, failure_clusters, learning_events, pending_surveys
--
-- Remaining ALTER statements (task_outcomes, failure_patterns) kept below.

ALTER TABLE task_outcomes ADD COLUMN IF NOT EXISTS quality_score REAL;

ALTER TABLE task_outcomes ADD COLUMN IF NOT EXISTS auto_generated_reflection BOOLEAN DEFAULT FALSE;

ALTER TABLE failure_patterns ADD COLUMN IF NOT EXISTS severity TEXT DEFAULT 'medium';

ALTER TABLE failure_patterns ADD COLUMN IF NOT EXISTS last_occurrence TIMESTAMPTZ;
