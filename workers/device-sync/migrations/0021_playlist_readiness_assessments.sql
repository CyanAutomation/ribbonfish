CREATE TABLE IF NOT EXISTS playlist_readiness_assessments (
  assessment_id TEXT PRIMARY KEY,
  playlist_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  assessed_at INTEGER NOT NULL,
  deterministic_status TEXT NOT NULL CHECK (deterministic_status IN ('ready', 'review', 'blocked')),
  decision_json TEXT NOT NULL,
  model TEXT,
  FOREIGN KEY (playlist_id, revision) REFERENCES playlists(playlist_id, revision) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS playlist_readiness_assessments_latest_idx
  ON playlist_readiness_assessments(playlist_id, revision, assessed_at DESC);
