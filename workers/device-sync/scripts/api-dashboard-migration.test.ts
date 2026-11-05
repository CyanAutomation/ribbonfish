import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("API dashboard migration preserves references and enables 1- and 5-minute schedules", async () => {
  const latest = await readFile(new URL("../schema.sql", import.meta.url), "utf8");
  const prior = latest
    .replace("CHECK (capture_interval_seconds IN (60, 300, 900, 1800, 3600, 10800, 21600, 43200, 86400))", "CHECK (capture_interval_seconds IN (900, 1800, 3600, 10800, 21600, 43200, 86400))")
    .replace("  capture_type TEXT NOT NULL DEFAULT 'browser-screenshot' CHECK (capture_type IN ('browser-screenshot', 'api-dashboard')),\n  api_sources_json TEXT,\n  api_status_json TEXT,\n  api_content_hash TEXT,\n  api_last_fetch_at INTEGER,\n  api_last_image_at INTEGER,\n", "")
    .replace("  api_fetch_ms INTEGER NOT NULL DEFAULT 0 CHECK (api_fetch_ms >= 0),\n  api_render_ms INTEGER NOT NULL DEFAULT 0 CHECK (api_render_ms >= 0),\n  api_asset_reused INTEGER NOT NULL DEFAULT 0 CHECK (api_asset_reused IN (0, 1)),\n", "");
  assert.notEqual(prior, latest, "migration fixture must use the pre-dashboard schema");
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(prior);
  const digest = "a".repeat(64);
  db.prepare("INSERT INTO capture_targets (capture_id, variant_key, url, capture_interval_seconds, viewport_width, viewport_height, placeholder_sha256, placeholder_size, created_at, next_due_at) VALUES ('capture-a', 'site-a', 'https://example.org/', 900, 1920, 1080, ?, 10, 1, 2)").run(digest);
  db.exec("INSERT INTO playlists (playlist_id, revision, rotation_interval, created_at) VALUES ('playlist-a', 'revision-a', '90s', 1)");
  db.exec("INSERT INTO playlist_capture_items (playlist_id, revision, position, capture_id) VALUES ('playlist-a', 'revision-a', 0, 'capture-a')");
  db.exec("INSERT INTO capture_jobs (job_id, capture_id, status, created_at) VALUES ('job-a', 'capture-a', 'succeeded', 3)");
  db.prepare("INSERT INTO capture_history (capture_id, job_id, sha256, size, captured_at) VALUES ('capture-a', 'job-a', ?, 10, 4)").run("b".repeat(64));
  db.exec("INSERT INTO capture_decisions (capture_id, due_at, assessed_at, action, reason) VALUES ('capture-a', 5, 5, 'capture', 'keep')");
  db.exec("INSERT INTO capture_skip_approvals (capture_id, due_at, expires_at, actor_id, created_at) VALUES ('capture-a', 5, 6, 'operator', 5)");
  db.exec("BEGIN");
  db.exec(await readFile(new URL("../migrations/0017_api_dashboards.sql", import.meta.url), "utf8"));
  db.exec("COMMIT");
  db.prepare("UPDATE capture_targets SET capture_type = 'api-dashboard', api_sources_json = '{}', capture_interval_seconds = 60 WHERE capture_id = 'capture-a'").run();
  assert.equal(db.prepare("SELECT capture_type, capture_interval_seconds FROM capture_targets WHERE capture_id = 'capture-a'").get()?.capture_type, "api-dashboard");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM playlist_capture_items").get()?.count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM capture_jobs").get()?.count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM capture_history").get()?.count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM capture_decisions").get()?.count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM capture_skip_approvals").get()?.count, 1);
  db.close();
});
