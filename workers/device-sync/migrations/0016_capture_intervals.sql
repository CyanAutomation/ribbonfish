-- Rebuild capture_targets to widen its CHECK constraint. Defer non-cascading
-- references while the table is replaced, and preserve rows in the two child
-- tables whose foreign keys would otherwise cascade during DROP TABLE.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE capture_decisions_0016_backup AS
SELECT * FROM capture_decisions;

CREATE TABLE capture_skip_approvals_0016_backup AS
SELECT * FROM capture_skip_approvals;

CREATE TABLE capture_targets_0016 (
  capture_id TEXT PRIMARY KEY,
  variant_key TEXT NOT NULL UNIQUE,
  url TEXT NOT NULL,
  capture_interval_seconds INTEGER NOT NULL CHECK (capture_interval_seconds IN (900, 1800, 3600, 10800, 21600, 43200, 86400)),
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
  CHECK ((current_sha256 IS NULL AND current_size IS NULL) OR (current_sha256 IS NOT NULL AND current_size > 0))
);

INSERT INTO capture_targets_0016 (
  capture_id, variant_key, url, capture_interval_seconds, viewport_width, viewport_height,
  placeholder_sha256, placeholder_size, current_sha256, current_size, created_at, next_due_at,
  last_attempt_at, last_success_at, validator_etag, validator_last_modified, wait_for_selector,
  name, last_error, failure_count, schedule_reviewed_at, enabled
)
SELECT
  capture_id, variant_key, url, capture_interval_seconds, viewport_width, viewport_height,
  placeholder_sha256, placeholder_size, current_sha256, current_size, created_at, next_due_at,
  last_attempt_at, last_success_at, validator_etag, validator_last_modified, wait_for_selector,
  name, last_error, failure_count, schedule_reviewed_at, enabled
FROM capture_targets;

DROP TABLE capture_targets;
ALTER TABLE capture_targets_0016 RENAME TO capture_targets;

INSERT INTO capture_decisions (
  capture_id, due_at, assessed_at, action, reason, state_json, decision_json, model,
  observed_at, observed_result, observed_delay_ms
)
SELECT
  capture_id, due_at, assessed_at, action, reason, state_json, decision_json, model,
  observed_at, observed_result, observed_delay_ms
FROM capture_decisions_0016_backup;

INSERT INTO capture_skip_approvals (capture_id, due_at, expires_at, actor_id, created_at)
SELECT capture_id, due_at, expires_at, actor_id, created_at
FROM capture_skip_approvals_0016_backup;

DROP TABLE capture_decisions_0016_backup;
DROP TABLE capture_skip_approvals_0016_backup;

-- Force an immediate check now that the original target IDs and cascade rows
-- are restored; do not carry deferred constraint bookkeeping into COMMIT.
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
