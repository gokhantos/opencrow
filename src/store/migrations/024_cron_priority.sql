ALTER TABLE cron_jobs ADD COLUMN IF NOT EXISTS priority INT NOT NULL DEFAULT 10;
CREATE INDEX IF NOT EXISTS idx_cron_jobs_priority ON cron_jobs (priority);
