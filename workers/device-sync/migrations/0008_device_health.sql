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
