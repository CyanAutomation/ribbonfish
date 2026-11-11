ALTER TABLE capture_jobs ADD COLUMN retry_cycle_attempts INTEGER NOT NULL DEFAULT 0 CHECK (retry_cycle_attempts >= 0);
ALTER TABLE capture_jobs ADD COLUMN recovery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (recovery_attempts >= 0);
ALTER TABLE capture_jobs ADD COLUMN retry_after_at INTEGER;

UPDATE capture_jobs SET retry_cycle_attempts = attempts;

CREATE INDEX IF NOT EXISTS capture_jobs_retry_due_idx ON capture_jobs(status, retry_after_at, created_at);
