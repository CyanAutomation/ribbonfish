import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const migration = await readFile(new URL("../migrations/0005_webpage_capture.sql", import.meta.url), "utf8");

test("webpage capture migration adds ordered playlist slots, scheduling state and retention history", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("CREATE TABLE playlists (playlist_id TEXT NOT NULL, revision TEXT NOT NULL, PRIMARY KEY (playlist_id, revision));");
    database.exec(migration);
    database.exec(migration);
    const names = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    for (const table of ["capture_targets", "playlist_capture_items", "capture_jobs", "capture_history", "capture_usage"]) {
      assert.ok(names.has(table), `${table} is created`);
    }
    assert.throws(() => database.prepare(
      "INSERT INTO capture_targets (capture_id, variant_key, url, capture_interval_seconds, viewport_width, viewport_height, placeholder_sha256, placeholder_size, created_at, next_due_at) VALUES ('bad', 'bad', 'https://example.com', 59, 1280, 720, 'a', 1, 1, 1)",
    ).run(), /CHECK constraint failed/);
  } finally {
    database.close();
  }
});
