-- Add enabled column to workflows for trigger activation
ALTER TABLE workflows ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT false;
