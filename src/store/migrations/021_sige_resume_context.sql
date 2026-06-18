-- Adds resume_context_json to sige_sessions for durable resume after restart.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sige_sessions' AND column_name = 'resume_context_json'
  ) THEN
    ALTER TABLE sige_sessions ADD COLUMN resume_context_json JSONB;
  END IF;
END $$;
