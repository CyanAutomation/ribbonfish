CREATE TABLE IF NOT EXISTS devices (
  device_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  manifest_key TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS enrollments (
  code_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  claim_id TEXT
);

CREATE INDEX IF NOT EXISTS devices_enabled_idx ON devices(enabled);
