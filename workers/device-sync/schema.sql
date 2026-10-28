CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  token_hash TEXT,
  public_key TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  CHECK ((token_hash IS NOT NULL AND public_key IS NULL) OR (token_hash IS NULL AND public_key IS NOT NULL))
);

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
