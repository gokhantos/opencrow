-- Drop cross_session_context table (overengineered, never actually called)
-- Related: prompt-context.ts simplified to only use user_preferences

DROP TABLE IF EXISTS cross_session_context;
