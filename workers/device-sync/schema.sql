CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  token_hash TEXT,
  public_key TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  CHECK ((token_hash IS NOT NULL AND public_key IS NULL) OR (token_hash IS NULL AND public_key IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS device_health_latest (
  device_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  reported_state TEXT NOT NULL CHECK (reported_state IN ('starting', 'ready', 'degraded', 'startup_failed', 'stopping')),
  health_status TEXT NOT NULL CHECK (health_status IN ('unknown', 'starting', 'healthy', 'degraded', 'stale', 'offline', 'stopping')),
  health_key TEXT NOT NULL,
  agent_version TEXT NOT NULL,
  sync_status TEXT NOT NULL CHECK (sync_status IN ('unknown', 'ok', 'failed')),
  applied_playlist_id TEXT,
  applied_revision TEXT,
  report_json TEXT NOT NULL,
  FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS device_health_samples (
  device_id TEXT NOT NULL,
  bucket_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  report_json TEXT NOT NULL,
  PRIMARY KEY (device_id, bucket_at),
  FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS device_health_samples_time_idx ON device_health_samples(device_id, received_at DESC);
CREATE TABLE IF NOT EXISTS device_health_events (
  event_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('device.first_report', 'device.agent_restarted', 'device.health_changed')),
  reported_state TEXT NOT NULL CHECK (reported_state IN ('starting', 'ready', 'degraded', 'startup_failed', 'stopping')),
  error_code TEXT,
  metadata_json TEXT NOT NULL,
  FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS device_health_events_time_idx ON device_health_events(device_id, received_at DESC);

CREATE TABLE IF NOT EXISTS enrollments (
  code_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  claim_id TEXT
);

CREATE INDEX IF NOT EXISTS devices_enabled_idx ON devices(enabled);
CREATE UNIQUE INDEX IF NOT EXISTS devices_public_key_idx ON devices(public_key) WHERE public_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS enrollment_requests (
  request_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_at INTEGER,
  actor_id TEXT,
  decision_id TEXT
);

CREATE INDEX IF NOT EXISTS enrollment_requests_pending_idx ON enrollment_requests(status, expires_at, created_at);

CREATE TABLE IF NOT EXISTS playlists (
  playlist_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  rotation_interval TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, revision)
);

CREATE TABLE IF NOT EXISTS playlist_assets (
  playlist_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  position INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, revision, position)
);

CREATE INDEX IF NOT EXISTS playlist_assets_digest_idx ON playlist_assets(sha256);

CREATE TABLE IF NOT EXISTS active_playlist (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  playlist_id TEXT NOT NULL,
  revision TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  event_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL DEFAULT 'anonymous',
  event_type TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  metadata_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_events_occurred_at_idx ON audit_events(occurred_at DESC);

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
  validator_etag TEXT,
  validator_last_modified TEXT,
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
CREATE UNIQUE INDEX IF NOT EXISTS capture_jobs_open_target_idx ON capture_jobs(capture_id) WHERE status IN ('queued', 'running');
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

CREATE TABLE IF NOT EXISTS managed_assets (
  sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^a-f0-9]*'),
  size INTEGER NOT NULL CHECK (size > 0),
  state TEXT NOT NULL CHECK (state IN ('pending', 'staged', 'live', 'deleting')),
  expires_at INTEGER,
  write_lease_until INTEGER,
  updated_at INTEGER NOT NULL,
  CHECK ((state IN ('pending', 'staged') AND expires_at IS NOT NULL) OR
         (state IN ('live', 'deleting') AND expires_at IS NULL))
);
CREATE INDEX IF NOT EXISTS managed_assets_state_idx ON managed_assets(state, expires_at);
CREATE INDEX IF NOT EXISTS managed_assets_updated_idx ON managed_assets(state, updated_at, sha256);
CREATE INDEX IF NOT EXISTS capture_targets_placeholder_digest_idx ON capture_targets(placeholder_sha256);
CREATE INDEX IF NOT EXISTS capture_targets_current_digest_idx ON capture_targets(current_sha256);

CREATE TABLE IF NOT EXISTS asset_reconciliation_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  r2_cursor TEXT,
  reference_cursor TEXT,
  lease_token TEXT,
  lease_until INTEGER,
  last_completed_at INTEGER
);
INSERT OR IGNORE INTO asset_reconciliation_state (singleton) VALUES (1);

CREATE TABLE IF NOT EXISTS asset_integrity_issues (
  sha256 TEXT NOT NULL,
  issue_type TEXT NOT NULL CHECK (issue_type IN ('missing_playlist_asset', 'missing_placeholder_asset')),
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  resolved_at INTEGER,
  PRIMARY KEY (sha256, issue_type)
);
CREATE INDEX IF NOT EXISTS asset_integrity_issues_open_idx
  ON asset_integrity_issues(resolved_at, last_seen_at);

INSERT OR IGNORE INTO managed_assets (sha256, size, state, expires_at, updated_at)
SELECT sha256, MAX(size), 'live', NULL, 0 FROM (
  SELECT sha256, size FROM playlist_assets
  UNION ALL
  SELECT placeholder_sha256 AS sha256, placeholder_size AS size FROM capture_targets
  UNION ALL
  SELECT current_sha256 AS sha256, current_size AS size FROM capture_targets WHERE current_sha256 IS NOT NULL
  UNION ALL
  SELECT sha256, size FROM capture_history
) GROUP BY sha256;

CREATE TRIGGER IF NOT EXISTS playlist_assets_not_deleting_insert
BEFORE INSERT ON playlist_assets
WHEN EXISTS (SELECT 1 FROM managed_assets WHERE sha256 = NEW.sha256 AND state = 'deleting')
BEGIN
  SELECT RAISE(ABORT, 'asset deletion in progress');
END;
CREATE TRIGGER IF NOT EXISTS playlist_assets_not_deleting_update
BEFORE UPDATE OF sha256, size ON playlist_assets
WHEN EXISTS (SELECT 1 FROM managed_assets WHERE sha256 = NEW.sha256 AND state = 'deleting')
BEGIN
  SELECT RAISE(ABORT, 'asset deletion in progress');
END;

CREATE TRIGGER IF NOT EXISTS capture_targets_not_deleting_insert
BEFORE INSERT ON capture_targets
WHEN EXISTS (
  SELECT 1 FROM managed_assets
  WHERE sha256 IN (NEW.placeholder_sha256, NEW.current_sha256) AND state = 'deleting'
)
BEGIN
  SELECT RAISE(ABORT, 'asset deletion in progress');
END;
CREATE TRIGGER IF NOT EXISTS capture_targets_not_deleting_update
BEFORE UPDATE OF placeholder_sha256, placeholder_size, current_sha256, current_size ON capture_targets
WHEN EXISTS (
  SELECT 1 FROM managed_assets
  WHERE sha256 IN (NEW.placeholder_sha256, NEW.current_sha256) AND state = 'deleting'
)
BEGIN
  SELECT RAISE(ABORT, 'asset deletion in progress');
END;

CREATE TRIGGER IF NOT EXISTS capture_history_not_deleting_insert
BEFORE INSERT ON capture_history
WHEN EXISTS (SELECT 1 FROM managed_assets WHERE sha256 = NEW.sha256 AND state = 'deleting')
BEGIN
  SELECT RAISE(ABORT, 'asset deletion in progress');
END;
CREATE TRIGGER IF NOT EXISTS capture_history_not_deleting_update
BEFORE UPDATE OF sha256, size ON capture_history
WHEN EXISTS (SELECT 1 FROM managed_assets WHERE sha256 = NEW.sha256 AND state = 'deleting')
BEGIN
  SELECT RAISE(ABORT, 'asset deletion in progress');
END;

CREATE TRIGGER IF NOT EXISTS playlist_assets_register_insert
AFTER INSERT ON playlist_assets
BEGIN
  INSERT INTO managed_assets (sha256, size, state, expires_at, write_lease_until, updated_at)
  VALUES (NEW.sha256, NEW.size, 'live', NULL, NULL, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  ON CONFLICT(sha256) DO UPDATE SET
    size = excluded.size,
    state = CASE
      WHEN managed_assets.state = 'pending'
        AND managed_assets.write_lease_until > excluded.updated_at THEN 'pending'
      ELSE 'live'
    END,
    expires_at = CASE
      WHEN managed_assets.state = 'pending'
        AND managed_assets.write_lease_until > excluded.updated_at THEN managed_assets.expires_at
      ELSE NULL
    END,
    write_lease_until = managed_assets.write_lease_until,
    updated_at = excluded.updated_at
  WHERE managed_assets.state != 'deleting';
END;

CREATE TRIGGER IF NOT EXISTS playlist_assets_register_update
AFTER UPDATE OF sha256, size ON playlist_assets
BEGIN
  INSERT INTO managed_assets (sha256, size, state, expires_at, write_lease_until, updated_at)
  VALUES (NEW.sha256, NEW.size, 'live', NULL, NULL, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  ON CONFLICT(sha256) DO UPDATE SET
    size = excluded.size,
    state = CASE
      WHEN managed_assets.state = 'pending'
        AND managed_assets.write_lease_until > excluded.updated_at THEN 'pending'
      ELSE 'live'
    END,
    expires_at = CASE
      WHEN managed_assets.state = 'pending'
        AND managed_assets.write_lease_until > excluded.updated_at THEN managed_assets.expires_at
      ELSE NULL
    END,
    write_lease_until = managed_assets.write_lease_until,
    updated_at = excluded.updated_at
  WHERE managed_assets.state != 'deleting';
END;

CREATE TRIGGER IF NOT EXISTS capture_targets_register_insert
AFTER INSERT ON capture_targets
WHEN NEW.placeholder_sha256 IS NOT NULL
BEGIN
  INSERT INTO managed_assets (sha256, size, state, expires_at, write_lease_until, updated_at)
  VALUES (NEW.placeholder_sha256, NEW.placeholder_size, 'live', NULL, NULL, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  ON CONFLICT(sha256) DO UPDATE SET
    size = excluded.size,
    state = CASE
      WHEN managed_assets.state = 'pending'
        AND managed_assets.write_lease_until > excluded.updated_at THEN 'pending'
      ELSE 'live'
    END,
    expires_at = CASE
      WHEN managed_assets.state = 'pending'
        AND managed_assets.write_lease_until > excluded.updated_at THEN managed_assets.expires_at
      ELSE NULL
    END,
    write_lease_until = managed_assets.write_lease_until,
    updated_at = excluded.updated_at
  WHERE managed_assets.state != 'deleting';
END;
CREATE TRIGGER IF NOT EXISTS capture_targets_register_current_insert
AFTER INSERT ON capture_targets
WHEN NEW.current_sha256 IS NOT NULL
BEGIN
  INSERT INTO managed_assets (sha256, size, state, expires_at, write_lease_until, updated_at)
  VALUES (NEW.current_sha256, NEW.current_size, 'live', NULL, NULL, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  ON CONFLICT(sha256) DO UPDATE SET
    size = excluded.size,
    state = CASE
      WHEN managed_assets.state = 'pending'
        AND managed_assets.write_lease_until > excluded.updated_at THEN 'pending'
      ELSE 'live'
    END,
    expires_at = CASE
      WHEN managed_assets.state = 'pending'
        AND managed_assets.write_lease_until > excluded.updated_at THEN managed_assets.expires_at
      ELSE NULL
    END,
    write_lease_until = managed_assets.write_lease_until,
    updated_at = excluded.updated_at
  WHERE managed_assets.state != 'deleting';
END;

CREATE TRIGGER IF NOT EXISTS capture_targets_register_placeholder_update
AFTER UPDATE OF placeholder_sha256, placeholder_size ON capture_targets
WHEN NEW.placeholder_sha256 IS NOT NULL
BEGIN
  INSERT INTO managed_assets (sha256, size, state, expires_at, write_lease_until, updated_at)
  VALUES (NEW.placeholder_sha256, NEW.placeholder_size, 'live', NULL, NULL, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  ON CONFLICT(sha256) DO UPDATE SET
    size = excluded.size,
    state = CASE
      WHEN managed_assets.state = 'pending'
        AND managed_assets.write_lease_until > excluded.updated_at THEN 'pending'
      ELSE 'live'
    END,
    expires_at = CASE
      WHEN managed_assets.state = 'pending'
        AND managed_assets.write_lease_until > excluded.updated_at THEN managed_assets.expires_at
      ELSE NULL
    END,
    write_lease_until = managed_assets.write_lease_until,
    updated_at = excluded.updated_at
  WHERE managed_assets.state != 'deleting';
END;

CREATE TRIGGER IF NOT EXISTS capture_targets_register_current_update
AFTER UPDATE OF current_sha256, current_size ON capture_targets
WHEN NEW.current_sha256 IS NOT NULL
BEGIN
  INSERT INTO managed_assets (sha256, size, state, expires_at, write_lease_until, updated_at)
  VALUES (NEW.current_sha256, NEW.current_size, 'live', NULL, NULL, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  ON CONFLICT(sha256) DO UPDATE SET
    size = excluded.size,
    state = CASE
      WHEN managed_assets.state = 'pending'
        AND managed_assets.write_lease_until > excluded.updated_at THEN 'pending'
      ELSE 'live'
    END,
    expires_at = CASE
      WHEN managed_assets.state = 'pending'
        AND managed_assets.write_lease_until > excluded.updated_at THEN managed_assets.expires_at
      ELSE NULL
    END,
    write_lease_until = managed_assets.write_lease_until,
    updated_at = excluded.updated_at
  WHERE managed_assets.state != 'deleting';
END;

CREATE TRIGGER IF NOT EXISTS capture_history_register_insert
AFTER INSERT ON capture_history
BEGIN
  INSERT INTO managed_assets (sha256, size, state, expires_at, write_lease_until, updated_at)
  VALUES (NEW.sha256, NEW.size, 'live', NULL, NULL, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  ON CONFLICT(sha256) DO UPDATE SET
    size = excluded.size,
    state = CASE
      WHEN managed_assets.state = 'pending'
        AND managed_assets.write_lease_until > excluded.updated_at THEN 'pending'
      ELSE 'live'
    END,
    expires_at = CASE
      WHEN managed_assets.state = 'pending'
        AND managed_assets.write_lease_until > excluded.updated_at THEN managed_assets.expires_at
      ELSE NULL
    END,
    write_lease_until = managed_assets.write_lease_until,
    updated_at = excluded.updated_at
  WHERE managed_assets.state != 'deleting';
END;

CREATE TRIGGER IF NOT EXISTS capture_history_register_update
AFTER UPDATE OF sha256, size ON capture_history
BEGIN
  INSERT INTO managed_assets (sha256, size, state, expires_at, write_lease_until, updated_at)
  VALUES (NEW.sha256, NEW.size, 'live', NULL, NULL, CAST(strftime('%s', 'now') AS INTEGER) * 1000)
  ON CONFLICT(sha256) DO UPDATE SET
    size = excluded.size,
    state = CASE
      WHEN managed_assets.state = 'pending'
        AND managed_assets.write_lease_until > excluded.updated_at THEN 'pending'
      ELSE 'live'
    END,
    expires_at = CASE
      WHEN managed_assets.state = 'pending'
        AND managed_assets.write_lease_until > excluded.updated_at THEN managed_assets.expires_at
      ELSE NULL
    END,
    write_lease_until = managed_assets.write_lease_until,
    updated_at = excluded.updated_at
  WHERE managed_assets.state != 'deleting';
END;
