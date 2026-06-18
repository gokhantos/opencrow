-- Add last_activity_at to sige_sessions for stuck-run detection.
-- Records the most recent meaningful progress epoch (seconds). NULL means no
-- activity has been recorded yet (pre-migration rows and fresh sessions before
-- the first touch).
-- Idempotent: ADD COLUMN IF NOT EXISTS is safe to re-run.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sige_sessions' AND column_name = 'last_activity_at'
  ) THEN
    ALTER TABLE sige_sessions ADD COLUMN last_activity_at BIGINT;
  END IF;
END $$;
