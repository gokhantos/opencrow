-- Visual Workflow Builder schema
-- All statements are idempotent

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  nodes_json JSONB NOT NULL DEFAULT '[]',
  edges_json JSONB NOT NULL DEFAULT '[]',
  viewport_json JSONB NOT NULL DEFAULT '{"x":0,"y":0,"zoom":1}',
  created_at BIGINT NOT NULL DEFAULT extract(epoch from now())::bigint,
  updated_at BIGINT NOT NULL DEFAULT extract(epoch from now())::bigint
);
