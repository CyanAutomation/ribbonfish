CREATE TABLE IF NOT EXISTS capture_duration_samples (
  sample_id TEXT PRIMARY KEY,
  capture_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  sampled_at INTEGER NOT NULL,
  browser_ms INTEGER NOT NULL CHECK (browser_ms >= 0),
  browser_ms_source TEXT NOT NULL CHECK (browser_ms_source IN ('response_header', 'reserve', 'unknown')),
  reserve_ms INTEGER NOT NULL CHECK (reserve_ms >= 0),
  browser_run_elapsed_ms INTEGER NOT NULL CHECK (browser_run_elapsed_ms >= 0),
  capture_elapsed_ms INTEGER NOT NULL CHECK (capture_elapsed_ms >= 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
  readiness_mode TEXT NOT NULL CHECK (readiness_mode IN ('domcontentloaded', 'selector')),
  readiness_selector TEXT CHECK (readiness_selector IS NULL OR length(readiness_selector) <= 256),
  UNIQUE (job_id, attempt),
  FOREIGN KEY (capture_id) REFERENCES capture_targets(capture_id),
  FOREIGN KEY (job_id) REFERENCES capture_jobs(job_id)
);

CREATE INDEX IF NOT EXISTS capture_duration_samples_site_time_idx
  ON capture_duration_samples(capture_id, sampled_at DESC);
CREATE INDEX IF NOT EXISTS capture_duration_samples_time_idx
  ON capture_duration_samples(sampled_at);
