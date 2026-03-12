-- Workflow execution tracking schema
-- All statements are idempotent

CREATE TABLE IF NOT EXISTS workflow_executions (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  trigger_input JSONB NOT NULL DEFAULT '{}',
  result JSONB,
  error TEXT,
  started_at BIGINT,
  finished_at BIGINT,
  created_at BIGINT NOT NULL DEFAULT extract(epoch from now())::bigint
);
CREATE INDEX IF NOT EXISTS idx_wf_exec_workflow ON workflow_executions(workflow_id);

CREATE TABLE IF NOT EXISTS workflow_execution_steps (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  execution_id TEXT NOT NULL REFERENCES workflow_executions(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  node_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  input JSONB,
  output JSONB,
  error TEXT,
  started_at BIGINT,
  finished_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_wf_step_exec ON workflow_execution_steps(execution_id);
