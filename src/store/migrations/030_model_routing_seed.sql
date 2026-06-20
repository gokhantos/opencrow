-- Seed per-process model routes. Values mirror the prior hardcoded defaults.
-- Idempotent: DO NOTHING preserves any operator-customized rows on re-run.
INSERT INTO config_overrides (namespace, key, value_json, updated_at) VALUES
  ('model-routing', 'signal.facets',       '{"provider":"alibaba","model":"deepseek-v4-flash"}', EXTRACT(EPOCH FROM now())::bigint),
  ('model-routing', 'signal.observations', '{"provider":"alibaba","model":"deepseek-v4-flash"}', EXTRACT(EPOCH FROM now())::bigint),
  ('model-routing', 'sige.fast-agent',     '{"provider":"anthropic","model":"claude-haiku-4-5-20251001"}', EXTRACT(EPOCH FROM now())::bigint),
  ('model-routing', 'sige.judge.0',        '{"provider":"anthropic","model":"claude-haiku-4-5"}', EXTRACT(EPOCH FROM now())::bigint),
  ('model-routing', 'sige.judge.1',        '{"provider":"openrouter","model":"deepseek/deepseek-chat-v3.1"}', EXTRACT(EPOCH FROM now())::bigint),
  ('model-routing', 'sige.judge.2',        '{"provider":"alibaba","model":"qwen3.7-plus"}', EXTRACT(EPOCH FROM now())::bigint),
  ('model-routing', 'pipeline.generator',  '{"provider":"anthropic","model":"claude-sonnet-4-6"}', EXTRACT(EPOCH FROM now())::bigint),
  ('model-routing', 'agent-templates',     '{"provider":"agent-sdk","model":"claude-haiku-4-5"}', EXTRACT(EPOCH FROM now())::bigint)
ON CONFLICT (namespace, key) DO NOTHING;
