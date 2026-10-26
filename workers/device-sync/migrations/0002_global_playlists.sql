ALTER TABLE devices DROP COLUMN manifest_key;

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
