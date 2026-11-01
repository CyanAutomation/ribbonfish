CREATE TABLE IF NOT EXISTS capture_decisions (
  capture_id TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  assessed_at INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('pending', 'capture', 'defer_once', 'error')),
  reason TEXT NOT NULL,
  state_json TEXT,
  decision_json TEXT,
  model TEXT,
  PRIMARY KEY (capture_id, due_at),
  FOREIGN KEY (capture_id) REFERENCES capture_targets(capture_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS capture_decisions_age_idx ON capture_decisions(assessed_at);
