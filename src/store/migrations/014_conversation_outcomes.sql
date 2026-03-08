CREATE INDEX IF NOT EXISTS idx_prewarm_domain ON prewarm_cache(domain);

CREATE TABLE IF NOT EXISTS task_embeddings (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    task_hash TEXT NOT NULL UNIQUE,
    embedding REAL[] NOT NULL,
    embedding_dim INTEGER NOT NULL DEFAULT 512,
    domain TEXT NOT NULL,
    outcome_score REAL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

CREATE INDEX IF NOT EXISTS idx_task_embeddings_hash ON task_embeddings(task_hash);

CREATE INDEX IF NOT EXISTS idx_task_embeddings_domain ON task_embeddings(domain, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_task_embeddings_created ON task_embeddings(created_at DESC);

CREATE TABLE IF NOT EXISTS conversation_state (
    session_id TEXT PRIMARY KEY,
    current_topic TEXT,
    topic_history JSONB NOT NULL DEFAULT '[]',
    current_turn INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'exploration' CHECK(state IN ('exploration', 'implementation', 'review', 'deploy')),
    last_activity TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

CREATE INDEX IF NOT EXISTS idx_conversation_state_topic ON conversation_state(current_topic);

CREATE TABLE IF NOT EXISTS conversation_topics (
    topic_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    topic TEXT NOT NULL,
    keywords TEXT[] NOT NULL DEFAULT '{}',
    agent_used TEXT,
    outcome_score REAL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

CREATE INDEX IF NOT EXISTS idx_conversation_topics_session ON conversation_topics(session_id);

CREATE INDEX IF NOT EXISTS idx_conversation_topics_topic ON conversation_topics(topic);

CREATE TABLE IF NOT EXISTS task_outcomes (
    task_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    task_hash TEXT NOT NULL,
    domain TEXT NOT NULL,
    agents_spawned TEXT[] NOT NULL DEFAULT '{}',
    revision_count INTEGER NOT NULL DEFAULT 0,
    user_feedback TEXT CHECK(user_feedback IN ('good', 'neutral', 'bad')),
    time_to_complete INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

CREATE INDEX IF NOT EXISTS idx_task_outcomes_session ON task_outcomes(session_id);

CREATE INDEX IF NOT EXISTS idx_task_outcomes_hash ON task_outcomes(task_hash);

CREATE INDEX IF NOT EXISTS idx_task_outcomes_domain ON task_outcomes(domain);

CREATE TABLE IF NOT EXISTS survey_responses (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id TEXT NOT NULL,
    task_hash TEXT NOT NULL,
    feedback_type TEXT NOT NULL CHECK(feedback_type IN ('good', 'neutral', 'bad')),
    feedback_text TEXT,
    revision_requested BOOLEAN DEFAULT FALSE,
    response_time_sec INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

CREATE INDEX IF NOT EXISTS idx_survey_responses_session ON survey_responses(session_id);

CREATE INDEX IF NOT EXISTS idx_survey_responses_feedback ON survey_responses(feedback_type);

CREATE TABLE IF NOT EXISTS task_revisions (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id TEXT NOT NULL,
    task_hash TEXT NOT NULL,
    attempt_number INTEGER NOT NULL,
    agent_id TEXT NOT NULL,
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

CREATE INDEX IF NOT EXISTS idx_task_revisions_session ON task_revisions(session_id);

CREATE INDEX IF NOT EXISTS idx_task_revisions_hash ON task_revisions(task_hash);

CREATE TABLE IF NOT EXISTS agent_score_adjustments (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    agent_id TEXT NOT NULL,
    domain TEXT,
    adjustment_type TEXT NOT NULL CHECK(adjustment_type IN ('outcome_bonus', 'revision_penalty', 'timeout_penalty')),
    adjustment_value REAL NOT NULL,
    reason TEXT NOT NULL,
    session_id TEXT,
    task_hash TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

CREATE INDEX IF NOT EXISTS idx_agent_score_adjustments_agent ON agent_score_adjustments(agent_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_capacity (
    agent_id TEXT PRIMARY KEY,
    current_load INTEGER NOT NULL DEFAULT 0,
    max_capacity INTEGER NOT NULL DEFAULT 3,
    queue_depth INTEGER NOT NULL DEFAULT 0,
    avg_task_duration_sec REAL NOT NULL DEFAULT 60,
    last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

CREATE INDEX IF NOT EXISTS idx_agent_capacity_load ON agent_capacity(current_load);

CREATE TABLE IF NOT EXISTS task_queue (
    queue_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    domain TEXT NOT NULL,
    task TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 5,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'cancelled', 'failed')),
    preferred_agent TEXT,
    assigned_agent TEXT,
    result TEXT,
    error_message TEXT,
    enqueued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
  );

CREATE INDEX IF NOT EXISTS idx_task_queue_status ON task_queue(status, priority DESC, enqueued_at ASC);

CREATE INDEX IF NOT EXISTS idx_task_queue_session ON task_queue(session_id);

CREATE INDEX IF NOT EXISTS idx_task_queue_agent ON task_queue(assigned_agent);

CREATE TABLE IF NOT EXISTS workload_history (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sampled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    total_tasks INTEGER NOT NULL DEFAULT 0,
    avg_queue_depth REAL NOT NULL DEFAULT 0,
    agent_utilization_json TEXT NOT NULL DEFAULT '[]'
  );

CREATE INDEX IF NOT EXISTS idx_workload_history_sampled ON workload_history(sampled_at DESC);

CREATE TABLE IF NOT EXISTS failure_records (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    domain TEXT NOT NULL,
    error_message TEXT NOT NULL,
    error_signature TEXT NOT NULL,
    error_type TEXT NOT NULL DEFAULT 'unknown',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

CREATE INDEX IF NOT EXISTS idx_failure_records_agent ON failure_records(agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_failure_records_domain ON failure_records(domain, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_failure_records_signature ON failure_records(error_signature);

CREATE TABLE IF NOT EXISTS failure_patterns (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    domain TEXT NOT NULL,
    agent_id TEXT,
    error_signature TEXT NOT NULL,
    occurrence_count INTEGER NOT NULL DEFAULT 1,
    first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    affected_sessions TEXT[] NOT NULL DEFAULT '{}',
    recommended_action TEXT,
    is_resolved BOOLEAN NOT NULL DEFAULT FALSE,
    UNIQUE(domain, agent_id, error_signature)
  );

CREATE INDEX IF NOT EXISTS idx_failure_patterns_domain ON failure_patterns(domain, is_resolved, occurrence_count DESC);

CREATE INDEX IF NOT EXISTS idx_failure_patterns_agent ON failure_patterns(agent_id, is_resolved, occurrence_count DESC);

CREATE TABLE IF NOT EXISTS anti_recommendations (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    domain TEXT,
    reason TEXT NOT NULL,
    failure_count INTEGER NOT NULL DEFAULT 0,
    confidence REAL NOT NULL DEFAULT 0.5,
    valid_until TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(agent_id, domain)
  );

CREATE INDEX IF NOT EXISTS idx_anti_recommendations_agent ON anti_recommendations(agent_id, valid_until);

CREATE INDEX IF NOT EXISTS idx_anti_recommendations_valid ON anti_recommendations(valid_until);
