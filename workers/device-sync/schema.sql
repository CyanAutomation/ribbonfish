CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);

CREATE TABLE IF NOT EXISTS enrollments (
  code_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  claim_id TEXT
);

CREATE INDEX IF NOT EXISTS devices_enabled_idx ON devices(enabled);

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
