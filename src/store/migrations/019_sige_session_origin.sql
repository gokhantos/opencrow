-- Add origin column to sige_sessions to distinguish human-initiated vs autonomous sessions.
-- Default 'human' ensures all existing rows are correctly tagged retroactively.
-- Idempotent: the DO $$ block silently swallows duplicate_column errors.
DO $$ BEGIN
  ALTER TABLE sige_sessions ADD COLUMN origin TEXT NOT NULL DEFAULT 'human';
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;
