-- SIGE (Strategic Idea Generation Engine) schema
-- All statements are idempotent

-- Top-level session tracking
CREATE TABLE IF NOT EXISTS sige_sessions (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  seed_input TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  config_json TEXT NOT NULL,
  game_formulation_json TEXT,
  expert_result_json TEXT,
  social_result_json TEXT,
  fused_scores_json TEXT,
  report TEXT,
  error TEXT,
  created_at BIGINT NOT NULL DEFAULT extract(epoch from now())::bigint,
  finished_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_sige_sessions_status ON sige_sessions (status);
CREATE INDEX IF NOT EXISTS idx_sige_sessions_created_at ON sige_sessions (created_at DESC);

-- Game structures derived per session
CREATE TABLE IF NOT EXISTS sige_game_formulations (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  session_id TEXT NOT NULL REFERENCES sige_sessions(id),
  game_type TEXT NOT NULL,
  players_json TEXT NOT NULL,
  strategies_json TEXT NOT NULL,
  payoff_matrix_json TEXT,
  information_structure_json TEXT NOT NULL,
  move_sequence TEXT NOT NULL,
  constraints_json TEXT,
  signal_spaces_json TEXT,
  created_at BIGINT NOT NULL DEFAULT extract(epoch from now())::bigint
);

CREATE INDEX IF NOT EXISTS idx_sige_game_formulations_session ON sige_game_formulations (session_id);

-- Individual agent actions per round
CREATE TABLE IF NOT EXISTS sige_agent_actions (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  session_id TEXT NOT NULL REFERENCES sige_sessions(id),
  round INTEGER NOT NULL,
  agent_role TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  content TEXT NOT NULL,
  confidence REAL,
  target_ideas_json TEXT,
  reasoning TEXT,
  score REAL,
  created_at BIGINT NOT NULL DEFAULT extract(epoch from now())::bigint
);

CREATE INDEX IF NOT EXISTS idx_sige_agent_actions_session_round ON sige_agent_actions (session_id, round);

-- Expert and social simulation results per session
CREATE TABLE IF NOT EXISTS sige_simulation_results (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  session_id TEXT NOT NULL REFERENCES sige_sessions(id),
  layer TEXT NOT NULL,
  round INTEGER,
  result_json TEXT NOT NULL,
  score REAL,
  created_at BIGINT NOT NULL DEFAULT extract(epoch from now())::bigint
);

CREATE INDEX IF NOT EXISTS idx_sige_simulation_results_session_layer ON sige_simulation_results (session_id, layer);

-- Per-idea scoring breakdown
CREATE TABLE IF NOT EXISTS sige_idea_scores (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  idea_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sige_sessions(id),
  expert_score REAL,
  social_score REAL,
  fused_score REAL,
  incentive_json TEXT,
  strategic_metadata_json TEXT,
  created_at BIGINT NOT NULL DEFAULT extract(epoch from now())::bigint
);

CREATE INDEX IF NOT EXISTS idx_sige_idea_scores_session ON sige_idea_scores (session_id);
CREATE INDEX IF NOT EXISTS idx_sige_idea_scores_idea ON sige_idea_scores (idea_id);

-- Evolutionary strategy tracking across sessions
CREATE TABLE IF NOT EXISTS sige_population_dynamics (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  session_id TEXT NOT NULL REFERENCES sige_sessions(id),
  strategy TEXT NOT NULL,
  fitness REAL NOT NULL,
  generation INTEGER NOT NULL,
  metadata_json TEXT,
  created_at BIGINT NOT NULL DEFAULT extract(epoch from now())::bigint
);

CREATE INDEX IF NOT EXISTS idx_sige_population_dynamics_session_gen ON sige_population_dynamics (session_id, generation);

-- Extend generated_ideas with SIGE linkage columns
ALTER TABLE generated_ideas ADD COLUMN IF NOT EXISTS sige_session_id TEXT;
ALTER TABLE generated_ideas ADD COLUMN IF NOT EXISTS game_theoretic_score REAL;
ALTER TABLE generated_ideas ADD COLUMN IF NOT EXISTS strategic_metadata_json TEXT;

CREATE INDEX IF NOT EXISTS idx_generated_ideas_sige_session ON generated_ideas (sige_session_id);
