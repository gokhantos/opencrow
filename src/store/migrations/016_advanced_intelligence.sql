CREATE TABLE IF NOT EXISTS prediction_records (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id TEXT NOT NULL,
    task_hash TEXT NOT NULL,
    task_text TEXT NOT NULL,
    predicted_domain TEXT NOT NULL,
    predicted_agent TEXT NOT NULL,
    confidence_score REAL NOT NULL,
    actual_domain TEXT,
    actual_agent TEXT,
    was_correct BOOLEAN,
    features_json TEXT NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

CREATE INDEX IF NOT EXISTS idx_prediction_records_domain ON prediction_records(predicted_domain, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_prediction_records_correct ON prediction_records(was_correct, created_at DESC);

CREATE TABLE IF NOT EXISTS user_preferences (
    id TEXT PRIMARY KEY,
    preference_type TEXT NOT NULL CHECK(preference_type IN ('communication', 'coding', 'workflow', 'tool', 'model')),
    preference_key TEXT NOT NULL,
    preference_value TEXT NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.5,
    source_session_id TEXT,
    expires_at TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

CREATE INDEX IF NOT EXISTS idx_user_preferences_type ON user_preferences(preference_type, is_active);

CREATE INDEX IF NOT EXISTS idx_user_preferences_active ON user_preferences(is_active, updated_at DESC);

-- cross_session_context removed (dropped in 034_drop_cross_session_context.sql)

-- self_reflection_logs table removed - redundant with failure-analyzer.ts

CREATE TABLE IF NOT EXISTS prediction_models (
    id TEXT PRIMARY KEY,
    model_version TEXT NOT NULL,
    training_data_count INTEGER NOT NULL,
    weights_json TEXT NOT NULL DEFAULT '{}',
    accuracy_metrics_json TEXT NOT NULL DEFAULT '{}',
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    trained_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ
  );

CREATE INDEX IF NOT EXISTS idx_prediction_models_active ON prediction_models(is_active, trained_at DESC);

CREATE TABLE IF NOT EXISTS preference_extractions (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    session_id TEXT NOT NULL,
    message_id TEXT,
    extracted_preferences_json TEXT NOT NULL DEFAULT '[]',
    extraction_confidence REAL NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

CREATE INDEX IF NOT EXISTS idx_preference_extractions_session ON preference_extractions(session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS prediction_performance (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    domain TEXT NOT NULL,
    total_predictions INTEGER NOT NULL DEFAULT 0,
    correct_predictions INTEGER NOT NULL DEFAULT 0,
    accuracy_rate REAL NOT NULL DEFAULT 0,
    last_predicted_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

CREATE INDEX IF NOT EXISTS idx_prediction_performance_domain ON prediction_performance(domain);

ALTER TABLE task_embeddings ADD COLUMN IF NOT EXISTS complexity_score INTEGER DEFAULT 1;
