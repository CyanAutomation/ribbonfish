-- Rebase stored configuration onto the supported five-value interval contract.
UPDATE capture_targets
SET capture_interval_seconds = 86400,
    next_due_at = CASE
      WHEN last_success_at IS NULL THEN CAST(strftime('%s', 'now') AS INTEGER) * 1000
      ELSE MAX(CAST(strftime('%s', 'now') AS INTEGER) * 1000, last_success_at + 86400000)
    END;

UPDATE playlists SET rotation_interval = '90s';

-- A changed active rotation interval must produce a new revision token so devices
-- cannot receive a stale 304 response for their previously cached playlist.
CREATE TEMP TABLE interval_active_revision AS
SELECT playlist_id, revision AS old_revision,
       'r-' || lower(hex(randomblob(16))) AS new_revision
FROM active_playlist WHERE singleton = 1;

UPDATE playlists
SET revision = (SELECT new_revision FROM interval_active_revision)
WHERE (playlist_id, revision) IN (SELECT playlist_id, old_revision FROM interval_active_revision);

UPDATE playlist_assets
SET revision = (SELECT new_revision FROM interval_active_revision)
WHERE (playlist_id, revision) IN (SELECT playlist_id, old_revision FROM interval_active_revision);

UPDATE playlist_capture_items
SET revision = (SELECT new_revision FROM interval_active_revision)
WHERE (playlist_id, revision) IN (SELECT playlist_id, old_revision FROM interval_active_revision);

UPDATE active_playlist
SET revision = (SELECT new_revision FROM interval_active_revision)
WHERE (playlist_id, revision) IN (SELECT playlist_id, old_revision FROM interval_active_revision);

DROP TABLE interval_active_revision;
