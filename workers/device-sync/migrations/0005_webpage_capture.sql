CREATE TABLE IF NOT EXISTS capture_targets (
  capture_id TEXT PRIMARY KEY,
  variant_key TEXT NOT NULL UNIQUE,
  url TEXT NOT NULL,
  capture_interval_seconds INTEGER NOT NULL CHECK (capture_interval_seconds >= 60 AND capture_interval_seconds <= 2592000),
  viewport_width INTEGER NOT NULL CHECK (viewport_width >= 320 AND viewport_width <= 3840),
  viewport_height INTEGER NOT NULL CHECK (viewport_height >= 240 AND viewport_height <= 2160),
  placeholder_sha256 TEXT NOT NULL,
  placeholder_size INTEGER NOT NULL CHECK (placeholder_size > 0),
  current_sha256 TEXT,
  current_size INTEGER,
  created_at INTEGER NOT NULL,
  next_due_at INTEGER NOT NULL,
  last_attempt_at INTEGER,
  last_success_at INTEGER,
  last_error TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  CHECK ((current_sha256 IS NULL AND current_size IS NULL) OR (current_sha256 IS NOT NULL AND current_size > 0))
);

CREATE INDEX IF NOT EXISTS capture_targets_due_idx ON capture_targets(enabled, next_due_at);

CREATE TABLE IF NOT EXISTS playlist_capture_items (
  playlist_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  position INTEGER NOT NULL,
  capture_id TEXT NOT NULL,
  PRIMARY KEY (playlist_id, revision, position),
  FOREIGN KEY (playlist_id, revision) REFERENCES playlists(playlist_id, revision),
  FOREIGN KEY (capture_id) REFERENCES capture_targets(capture_id)
);

CREATE INDEX IF NOT EXISTS playlist_capture_items_target_idx ON playlist_capture_items(capture_id);

CREATE TABLE IF NOT EXISTS capture_jobs (
  job_id TEXT PRIMARY KEY,
  capture_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'deferred')),
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  lease_until INTEGER,
  error TEXT,
  FOREIGN KEY (capture_id) REFERENCES capture_targets(capture_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS capture_jobs_open_target_idx
  ON capture_jobs(capture_id) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS capture_jobs_status_idx ON capture_jobs(status, created_at);

CREATE TABLE IF NOT EXISTS capture_history (
  capture_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size > 0),
  captured_at INTEGER NOT NULL,
  browser_ms INTEGER NOT NULL DEFAULT 0 CHECK (browser_ms >= 0),
  PRIMARY KEY (capture_id, job_id),
  FOREIGN KEY (capture_id) REFERENCES capture_targets(capture_id),
  FOREIGN KEY (job_id) REFERENCES capture_jobs(job_id)
);

CREATE INDEX IF NOT EXISTS capture_history_retention_idx ON capture_history(capture_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS capture_history_digest_idx ON capture_history(sha256);

CREATE TABLE IF NOT EXISTS capture_usage (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  usage_day TEXT NOT NULL,
  browser_ms INTEGER NOT NULL DEFAULT 0 CHECK (browser_ms >= 0),
  last_started_at INTEGER
);
