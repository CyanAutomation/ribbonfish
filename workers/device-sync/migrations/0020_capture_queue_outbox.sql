ALTER TABLE capture_jobs ADD COLUMN queue_dispatch_attempts INTEGER NOT NULL DEFAULT 0 CHECK (queue_dispatch_attempts >= 0);
ALTER TABLE capture_jobs ADD COLUMN queue_dispatch_after_at INTEGER;
ALTER TABLE capture_jobs ADD COLUMN queue_dispatch_lease_until INTEGER;

CREATE INDEX IF NOT EXISTS capture_jobs_queue_dispatch_idx
  ON capture_jobs(status, queue_dispatch_after_at, queue_dispatch_lease_until, created_at);
