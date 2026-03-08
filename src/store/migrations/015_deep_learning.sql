CREATE TABLE IF NOT EXISTS survey_configs (
    id TEXT PRIMARY KEY,
    survey_type TEXT NOT NULL DEFAULT 'post_task' CHECK(survey_type IN ('post_task', 'post_failure', 'periodic')),
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    trigger_delay_sec INTEGER NOT NULL DEFAULT 30,
    questions_json TEXT NOT NULL DEFAULT '[]',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

CREATE TABLE IF NOT EXISTS survey_responses_enhanced (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id TEXT NOT NULL,
    task_hash TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    survey_type TEXT NOT NULL DEFAULT 'post_task',
    overall_rating INTEGER CHECK(overall_rating >= 1 AND overall_rating <= 5),
    speed_rating INTEGER CHECK(speed_rating >= 1 AND speed_rating <= 5),
    quality_rating INTEGER CHECK(quality_rating >= 1 AND quality_rating <= 5),
    feedback_text TEXT,
    tags_json TEXT NOT NULL DEFAULT '[]',
    would_use_again BOOLEAN,
    response_time_sec INTEGER,
    delivered_via TEXT DEFAULT 'telegram',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

CREATE INDEX IF NOT EXISTS idx_survey_enhanced_session ON survey_responses_enhanced(session_id);

CREATE INDEX IF NOT EXISTS idx_survey_enhanced_agent ON survey_responses_enhanced(agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_survey_enhanced_rating ON survey_responses_enhanced(overall_rating);

CREATE TABLE IF NOT EXISTS agent_reflections (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    task_hash TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    reflection_type TEXT NOT NULL CHECK(reflection_type IN ('post_failure', 'post_success', 'periodic')),
    outcome_status TEXT NOT NULL CHECK(outcome_status IN ('success', 'partial', 'failure')),
    what_went_well TEXT,
    what_went_wrong TEXT,
    root_cause_analysis TEXT,
    lessons_learned_json TEXT NOT NULL DEFAULT '[]',
    improvement_actions_json TEXT NOT NULL DEFAULT '[]',
    similar_past_failures TEXT[] DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

CREATE INDEX IF NOT EXISTS idx_reflections_session ON agent_reflections(session_id);

CREATE INDEX IF NOT EXISTS idx_reflections_agent ON agent_reflections(agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_reflections_outcome ON agent_reflections(outcome_status);

CREATE TABLE IF NOT EXISTS outcome_routing_cache (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    domain TEXT NOT NULL,
    task_embedding REAL[] DEFAULT '{}',
    successful_agents_json TEXT NOT NULL DEFAULT '[]',
    failed_agents_json TEXT NOT NULL DEFAULT '[]',
    total_tasks INTEGER NOT NULL DEFAULT 0,
    success_rate REAL NOT NULL DEFAULT 0,
    last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ
  );

CREATE INDEX IF NOT EXISTS idx_outcome_cache_domain ON outcome_routing_cache(domain, expires_at);

CREATE TABLE IF NOT EXISTS failure_clusters (
    id TEXT PRIMARY KEY,
    cluster_name TEXT NOT NULL,
    cluster_signature TEXT NOT NULL,
    domain TEXT NOT NULL,
    affected_agents TEXT[] NOT NULL DEFAULT '{}',
    affected_sessions TEXT[] NOT NULL DEFAULT '{}',
    occurrence_count INTEGER NOT NULL DEFAULT 1,
    first_occurrence TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_occurrence TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    severity TEXT NOT NULL DEFAULT 'medium' CHECK(severity IN ('low', 'medium', 'high', 'critical')),
    resolution_steps_json TEXT NOT NULL DEFAULT '[]',
    is_resolved BOOLEAN NOT NULL DEFAULT FALSE,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

CREATE INDEX IF NOT EXISTS idx_failure_clusters_domain ON failure_clusters(domain, is_resolved, occurrence_count DESC);

CREATE INDEX IF NOT EXISTS idx_failure_clusters_severity ON failure_clusters(severity, is_resolved);

CREATE TABLE IF NOT EXISTS learning_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_type TEXT NOT NULL CHECK(event_type IN ('survey_submitted', 'reflection_created', 'pattern_discovered', 'routing_updated', 'score_adjusted')),
    session_id TEXT,
    task_hash TEXT,
    agent_id TEXT,
    domain TEXT,
    event_data_json TEXT NOT NULL DEFAULT '{}',
    learning_impact TEXT NOT NULL DEFAULT 'pending' CHECK(learning_impact IN ('pending', 'applied', 'expired', 'overridden')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

CREATE INDEX IF NOT EXISTS idx_learning_events_type ON learning_events(event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_learning_events_agent ON learning_events(agent_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pending_surveys (
    session_id TEXT PRIMARY KEY,
    task_hash TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    message_text TEXT,
    questions_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'delivered', 'answered', 'expired', 'cancelled')),
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

CREATE INDEX IF NOT EXISTS idx_pending_surveys_status ON pending_surveys(status, created_at);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'survey_responses') THEN
    ALTER TABLE survey_responses ADD COLUMN IF NOT EXISTS message_id INTEGER;
    ALTER TABLE survey_responses ADD COLUMN IF NOT EXISTS chat_id TEXT;
    ALTER TABLE survey_responses ADD COLUMN IF NOT EXISTS is_anonymous BOOLEAN DEFAULT FALSE;
    ALTER TABLE survey_responses ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
    ALTER TABLE survey_responses ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';
    ALTER TABLE survey_responses ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
    ALTER TABLE survey_responses ADD COLUMN IF NOT EXISTS answered_at TIMESTAMPTZ;
  END IF;
END $$;

ALTER TABLE task_outcomes ADD COLUMN IF NOT EXISTS quality_score REAL;

ALTER TABLE task_outcomes ADD COLUMN IF NOT EXISTS auto_generated_reflection BOOLEAN DEFAULT FALSE;

ALTER TABLE failure_patterns ADD COLUMN IF NOT EXISTS severity TEXT DEFAULT 'medium';

ALTER TABLE failure_patterns ADD COLUMN IF NOT EXISTS last_occurrence TIMESTAMPTZ;
