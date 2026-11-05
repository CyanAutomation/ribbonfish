-- Extend shared capture targets for API dashboards while preserving all child rows and asset triggers.
ALTER TABLE capture_jobs ADD COLUMN api_fetch_ms INTEGER NOT NULL DEFAULT 0 CHECK (api_fetch_ms >= 0);
ALTER TABLE capture_jobs ADD COLUMN api_render_ms INTEGER NOT NULL DEFAULT 0 CHECK (api_render_ms >= 0);
ALTER TABLE capture_jobs ADD COLUMN api_asset_reused INTEGER NOT NULL DEFAULT 0 CHECK (api_asset_reused IN (0, 1));
PRAGMA defer_foreign_keys = ON;
CREATE TABLE capture_decisions_0017_backup AS SELECT * FROM capture_decisions;
CREATE TABLE capture_skip_approvals_0017_backup AS SELECT * FROM capture_skip_approvals;
CREATE TABLE capture_targets_0017 (
  capture_id TEXT PRIMARY KEY,
  variant_key TEXT NOT NULL UNIQUE,
  url TEXT NOT NULL,
  capture_interval_seconds INTEGER NOT NULL CHECK (capture_interval_seconds IN (60, 300, 900, 1800, 3600, 10800, 21600, 43200, 86400)),
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
  wait_for_selector TEXT,
  name TEXT,
  last_error TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  schedule_reviewed_at INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  capture_type TEXT NOT NULL DEFAULT 'browser-screenshot' CHECK (capture_type IN ('browser-screenshot', 'api-dashboard')),
  api_sources_json TEXT,
  api_status_json TEXT,
  api_content_hash TEXT,
  api_last_fetch_at INTEGER,
  api_last_image_at INTEGER,
  CHECK ((current_sha256 IS NULL AND current_size IS NULL) OR (current_sha256 IS NOT NULL AND current_size > 0))
);
INSERT INTO capture_targets_0017 (capture_id, variant_key, url, capture_interval_seconds, viewport_width, viewport_height, placeholder_sha256, placeholder_size, current_sha256, current_size, created_at, next_due_at, last_attempt_at, last_success_at, validator_etag, validator_last_modified, wait_for_selector, name, last_error, failure_count, schedule_reviewed_at, enabled, capture_type, api_sources_json, api_status_json, api_content_hash, api_last_fetch_at, api_last_image_at)
SELECT capture_id, variant_key, url, capture_interval_seconds, viewport_width, viewport_height, placeholder_sha256, placeholder_size, current_sha256, current_size, created_at, next_due_at, last_attempt_at, last_success_at, validator_etag, validator_last_modified, wait_for_selector, name, last_error, failure_count, schedule_reviewed_at, enabled, 'browser-screenshot', NULL, NULL, NULL, NULL, NULL FROM capture_targets;

DROP TABLE capture_targets;
ALTER TABLE capture_targets_0017 RENAME TO capture_targets;
INSERT INTO capture_decisions SELECT * FROM capture_decisions_0017_backup;
INSERT INTO capture_skip_approvals SELECT * FROM capture_skip_approvals_0017_backup;
DROP TABLE capture_decisions_0017_backup;
DROP TABLE capture_skip_approvals_0017_backup;
PRAGMA defer_foreign_keys = OFF;

CREATE INDEX IF NOT EXISTS capture_targets_due_idx ON capture_targets(enabled, next_due_at);
CREATE INDEX IF NOT EXISTS capture_targets_placeholder_digest_idx ON capture_targets(placeholder_sha256);
CREATE INDEX IF NOT EXISTS capture_targets_current_digest_idx ON capture_targets(current_sha256);

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
