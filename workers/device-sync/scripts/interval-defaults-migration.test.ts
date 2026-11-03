import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const migration = await readFile(new URL("../migrations/0011_interval_defaults.sql", import.meta.url), "utf8");

test("interval migration defaults current capture schedules and playlist rotations", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE capture_targets (capture_id TEXT PRIMARY KEY, capture_interval_seconds INTEGER NOT NULL,
        next_due_at INTEGER NOT NULL, created_at INTEGER NOT NULL, last_success_at INTEGER);
      CREATE TABLE playlists (playlist_id TEXT NOT NULL, revision TEXT NOT NULL, rotation_interval TEXT NOT NULL,
        created_at INTEGER NOT NULL, PRIMARY KEY (playlist_id, revision));
      CREATE TABLE playlist_assets (playlist_id TEXT NOT NULL, revision TEXT NOT NULL, position INTEGER NOT NULL,
        sha256 TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY (playlist_id, revision, position));
      CREATE TABLE playlist_capture_items (playlist_id TEXT NOT NULL, revision TEXT NOT NULL, position INTEGER NOT NULL,
        capture_id TEXT NOT NULL, PRIMARY KEY (playlist_id, revision, position),
        FOREIGN KEY (playlist_id, revision) REFERENCES playlists(playlist_id, revision),
        FOREIGN KEY (capture_id) REFERENCES capture_targets(capture_id));
      CREATE TABLE active_playlist (singleton INTEGER PRIMARY KEY, playlist_id TEXT NOT NULL, revision TEXT NOT NULL);
      INSERT INTO capture_targets VALUES ('capture-1', 300, 20, 10, 15);
      INSERT INTO capture_targets VALUES ('capture-never-succeeded', 300, 20, ${Date.now()}, NULL);
      INSERT INTO playlists VALUES ('welcome', 'old-active', '15s', 10);
      INSERT INTO playlists VALUES ('welcome', 'old-history', '20s', 9);
      INSERT INTO playlist_assets VALUES ('welcome', 'old-active', 0, 'digest', 4);
      INSERT INTO playlist_capture_items VALUES ('welcome', 'old-active', 1, 'capture-1');
      INSERT INTO active_playlist VALUES (1, 'welcome', 'old-active');
    `);
    // D1 applies each migration as a transaction with foreign keys enabled.
    database.exec("BEGIN");
    database.exec(migration);
    database.exec("COMMIT");
    assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(database.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name = 'interval_active_revision'").get()?.count, 0);

    assert.equal(database.prepare("SELECT capture_interval_seconds FROM capture_targets WHERE capture_id = 'capture-1'").get()?.capture_interval_seconds, 86400);
    const playlists = database.prepare("SELECT revision, rotation_interval FROM playlists ORDER BY revision").all();
    assert.ok(playlists.every((row) => row.rotation_interval === "90s"));
    const active = database.prepare(`SELECT a.revision, p.rotation_interval FROM active_playlist a
      JOIN playlists p ON p.playlist_id = a.playlist_id AND p.revision = a.revision WHERE a.singleton = 1`).get();
    assert.ok(active);
    assert.equal(active.rotation_interval, "90s");
    assert.ok(typeof active.revision === "string");
    assert.notEqual(active.revision, "old-active", "active revision changes so devices do not reuse the old ETag");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM playlist_assets WHERE revision = ?").get(active.revision)?.count, 1);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM playlist_capture_items WHERE revision = ?").get(active.revision)?.count, 1);
    const target = database.prepare("SELECT next_due_at FROM capture_targets WHERE capture_id = 'capture-1'").get();
    assert.ok(target && typeof target.next_due_at === "number");
    assert.ok(target.next_due_at >= Date.now() - 5000, "a stale target is due promptly after migration");
    const firstCapture = database.prepare("SELECT next_due_at FROM capture_targets WHERE capture_id = 'capture-never-succeeded'").get();
    assert.ok(firstCapture && typeof firstCapture.next_due_at === "number");
    assert.ok(firstCapture.next_due_at <= Date.now() + 5000, "a target without a successful capture stays due immediately");
  } finally {
    database.close();
  }
});

test("interval migration avoids temporary tables unsupported by remote D1", () => {
  assert.doesNotMatch(migration, /\bCREATE\s+TEMP(?:ORARY)?\s+TABLE\b/i);
});
