-- Drop NOT NULL constraint on seed_input to allow autonomous (seedless) sessions.
-- Idempotent: the DO $$ block catches and ignores any error if the column is
-- already nullable (Postgres raises no standard error code for a no-op DROP NOT NULL,
-- but guards against re-runs on already-migrated schemas).
DO $$ BEGIN
  ALTER TABLE sige_sessions ALTER COLUMN seed_input DROP NOT NULL;
EXCEPTION WHEN others THEN NULL;
END $$;
