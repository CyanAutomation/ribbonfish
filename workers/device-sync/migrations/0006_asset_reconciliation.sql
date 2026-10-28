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
  INSERT OR REPLACE INTO managed_assets (sha256, size, state, expires_at, write_lease_until, updated_at)
  VALUES (NEW.sha256, NEW.size, 'live', NULL, NULL, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
END;

CREATE TRIGGER IF NOT EXISTS playlist_assets_register_update
AFTER UPDATE OF sha256, size ON playlist_assets
BEGIN
  INSERT OR REPLACE INTO managed_assets (sha256, size, state, expires_at, write_lease_until, updated_at)
  VALUES (NEW.sha256, NEW.size, 'live', NULL, NULL, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
END;

CREATE TRIGGER IF NOT EXISTS capture_targets_register_insert
AFTER INSERT ON capture_targets
WHEN NEW.placeholder_sha256 IS NOT NULL
BEGIN
  INSERT OR REPLACE INTO managed_assets (sha256, size, state, expires_at, write_lease_until, updated_at)
  VALUES (NEW.placeholder_sha256, NEW.placeholder_size, 'live', NULL, NULL, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
END;

CREATE TRIGGER IF NOT EXISTS capture_targets_register_current_insert
AFTER INSERT ON capture_targets
WHEN NEW.current_sha256 IS NOT NULL
BEGIN
  INSERT OR REPLACE INTO managed_assets (sha256, size, state, expires_at, write_lease_until, updated_at)
  VALUES (NEW.current_sha256, NEW.current_size, 'live', NULL, NULL, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
END;

CREATE TRIGGER IF NOT EXISTS capture_targets_register_placeholder_update
AFTER UPDATE OF placeholder_sha256, placeholder_size ON capture_targets
WHEN NEW.placeholder_sha256 IS NOT NULL
BEGIN
  INSERT OR REPLACE INTO managed_assets (sha256, size, state, expires_at, write_lease_until, updated_at)
  VALUES (NEW.placeholder_sha256, NEW.placeholder_size, 'live', NULL, NULL, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
END;

CREATE TRIGGER IF NOT EXISTS capture_targets_register_current_update
AFTER UPDATE OF current_sha256, current_size ON capture_targets
WHEN NEW.current_sha256 IS NOT NULL
BEGIN
  INSERT OR REPLACE INTO managed_assets (sha256, size, state, expires_at, write_lease_until, updated_at)
  VALUES (NEW.current_sha256, NEW.current_size, 'live', NULL, NULL, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
END;

CREATE TRIGGER IF NOT EXISTS capture_history_register_insert
AFTER INSERT ON capture_history
BEGIN
  INSERT OR REPLACE INTO managed_assets (sha256, size, state, expires_at, write_lease_until, updated_at)
  VALUES (NEW.sha256, NEW.size, 'live', NULL, NULL, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
END;

CREATE TRIGGER IF NOT EXISTS capture_history_register_update
AFTER UPDATE OF sha256, size ON capture_history
BEGIN
  INSERT OR REPLACE INTO managed_assets (sha256, size, state, expires_at, write_lease_until, updated_at)
  VALUES (NEW.sha256, NEW.size, 'live', NULL, NULL, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
END;
