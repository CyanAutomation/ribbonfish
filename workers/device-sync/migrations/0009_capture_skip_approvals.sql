CREATE TABLE IF NOT EXISTS capture_skip_approvals (
  capture_id TEXT PRIMARY KEY,
  due_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  actor_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (capture_id) REFERENCES capture_targets(capture_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS capture_skip_approvals_expiry_idx
  ON capture_skip_approvals(expires_at);
