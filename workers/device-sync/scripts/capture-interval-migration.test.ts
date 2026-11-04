import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

test("capture interval migration adds choices and preserves target relationships and triggers", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    const schema = await readFile(new URL("../schema.sql", import.meta.url), "utf8");
    const previousSchema = schema.replace(
      "CHECK (capture_interval_seconds IN (900, 1800, 3600, 10800, 21600, 43200, 86400))",
      "CHECK (capture_interval_seconds IN (900, 1800, 3600, 21600, 86400))",
    );
    assert.notEqual(previousSchema, schema, "fixture must start with the old interval constraint");
    db.exec(previousSchema);

    db.prepare(
      "INSERT INTO capture_targets (capture_id, variant_key, url, capture_interval_seconds, viewport_width, viewport_height, " +
      "placeholder_sha256, placeholder_size, created_at, next_due_at, name, failure_count, schedule_reviewed_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("capture-1", "example:1920x1080", "https://example.com/", 900, 1920, 1080, "a".repeat(64), 4, 10, 50, "stored site", 2, 30);
    assert.throws(() => db.prepare(
      "INSERT INTO capture_targets (capture_id, variant_key, url, capture_interval_seconds, viewport_width, viewport_height, " +
      "placeholder_sha256, placeholder_size, created_at, next_due_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("capture-pre-migration", "pre-migration:1920x1080", "https://example.com/", 10800, 1920, 1080, "g".repeat(64), 4, 10, 50), /CHECK constraint failed/);
    db.prepare("INSERT INTO playlists (playlist_id, revision, rotation_interval, created_at) VALUES (?, ?, ?, ?)")
      .run("ops", "revision-1", "90s", 10);
    db.prepare("INSERT INTO playlist_capture_items (playlist_id, revision, position, capture_id) VALUES (?, ?, ?, ?)")
      .run("ops", "revision-1", 0, "capture-1");
    db.prepare("INSERT INTO capture_jobs (job_id, capture_id, status, created_at) VALUES (?, ?, ?, ?)")
      .run("job-1", "capture-1", "succeeded", 20);
    db.prepare("INSERT INTO capture_history (capture_id, job_id, sha256, size, captured_at) VALUES (?, ?, ?, ?, ?)")
      .run("capture-1", "job-1", "c".repeat(64), 4, 30);
    db.prepare(
      "INSERT INTO capture_duration_samples (sample_id, capture_id, job_id, attempt, sampled_at, browser_ms, " +
      "browser_ms_source, reserve_ms, browser_run_elapsed_ms, capture_elapsed_ms, outcome, readiness_mode) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("sample-1", "capture-1", "job-1", 1, 30, 500, "response_header", 100, 600, 700, "succeeded", "domcontentloaded");
    db.prepare("INSERT INTO capture_decisions (capture_id, due_at, assessed_at, action, reason) VALUES (?, ?, ?, ?, ?)")
      .run("capture-1", 40, 40, "capture", "keep current schedule");
    db.prepare("INSERT INTO capture_skip_approvals (capture_id, due_at, expires_at, actor_id, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("capture-1", 40, 50, "operator", 40);

    const migration = await readFile(new URL("../migrations/0016_capture_intervals.sql", import.meta.url), "utf8");
    db.exec(`BEGIN;\n${migration}\nCOMMIT;`);

    const target = db.prepare(
      "SELECT capture_interval_seconds, next_due_at, name, failure_count, schedule_reviewed_at FROM capture_targets WHERE capture_id = ?",
    ).get("capture-1");
    assert.deepEqual({ ...target }, {
      capture_interval_seconds: 900,
      next_due_at: 50,
      name: "stored site",
      failure_count: 2,
      schedule_reviewed_at: 30,
    });
    for (const table of [
      "playlist_capture_items", "capture_jobs", "capture_history", "capture_duration_samples",
      "capture_decisions", "capture_skip_approvals",
    ]) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count, 1, `${table} row survives`);
    }
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);

    for (const [captureID, interval, digest] of [
      ["capture-3h", 10800, "b".repeat(64)],
      ["capture-12h", 43200, "d".repeat(64)],
    ] as const) {
      db.prepare(
        "INSERT INTO capture_targets (capture_id, variant_key, url, capture_interval_seconds, viewport_width, viewport_height, " +
        "placeholder_sha256, placeholder_size, created_at, next_due_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(captureID, `${captureID}:1920x1080`, "https://example.com/", interval, 1920, 1080, digest, 4, 60, 60);
      assert.equal(
        db.prepare("SELECT state FROM managed_assets WHERE sha256 = ?").get(digest)?.state,
        "live",
        "asset registration trigger remains active",
      );
    }

    assert.throws(() => db.prepare(
      "INSERT INTO capture_targets (capture_id, variant_key, url, capture_interval_seconds, viewport_width, viewport_height, " +
      "placeholder_sha256, placeholder_size, created_at, next_due_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("capture-invalid", "invalid:1920x1080", "https://example.com/", 300, 1920, 1080, "e".repeat(64), 4, 60, 60), /CHECK constraint failed/);

    db.prepare("INSERT INTO managed_assets (sha256, size, state, expires_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("f".repeat(64), 4, "deleting", null, 70);
    assert.throws(() => db.prepare("UPDATE capture_targets SET placeholder_sha256 = ?, placeholder_size = ? WHERE capture_id = ?")
      .run("f".repeat(64), 4, "capture-1"), /asset deletion in progress/);
  } finally { db.close(); }
});
