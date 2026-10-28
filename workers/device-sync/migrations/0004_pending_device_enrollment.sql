CREATE TABLE devices_new (
  device_id TEXT PRIMARY KEY,
  token_hash TEXT,
  public_key TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  CHECK ((token_hash IS NOT NULL AND public_key IS NULL) OR (token_hash IS NULL AND public_key IS NOT NULL))
);

INSERT INTO devices_new (device_id, token_hash, public_key, enabled, created_at, last_seen_at)
SELECT device_id, token_hash, NULL, enabled, created_at, last_seen_at FROM devices;

DROP TABLE devices;
ALTER TABLE devices_new RENAME TO devices;

CREATE INDEX devices_enabled_idx ON devices(enabled);
CREATE UNIQUE INDEX devices_public_key_idx ON devices(public_key) WHERE public_key IS NOT NULL;

CREATE TABLE enrollment_requests (
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

CREATE INDEX enrollment_requests_pending_idx ON enrollment_requests(status, expires_at, created_at);
