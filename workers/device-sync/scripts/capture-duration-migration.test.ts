import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const migration = await readFile(new URL("../migrations/0015_capture_duration_samples.sql", import.meta.url), "utf8");

test("capture duration migration stores one bounded record per Browser Run attempt", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE capture_targets (capture_id TEXT PRIMARY KEY);
      CREATE TABLE capture_jobs (job_id TEXT PRIMARY KEY);
      INSERT INTO capture_targets VALUES ('capture-1');
      INSERT INTO capture_jobs VALUES ('job-1');
    `);
    database.exec(migration);
    database.exec(migration);

    database.prepare(
      "INSERT INTO capture_duration_samples (sample_id, capture_id, job_id, attempt, sampled_at, browser_ms, browser_ms_source, reserve_ms, browser_run_elapsed_ms, capture_elapsed_ms, outcome, readiness_mode) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("sample-1", "capture-1", "job-1", 1, 100, 1200, "response_header", 60_000, 1400, 1800, "succeeded", "domcontentloaded");

    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM capture_duration_samples").get()?.count, 1);
    database.prepare("UPDATE capture_duration_samples SET readiness_mode = 'selector', readiness_selector = ? WHERE sample_id = ?")
      .run("main.ready", "sample-1");
    assert.equal(database.prepare("SELECT readiness_selector FROM capture_duration_samples WHERE sample_id = ?").get("sample-1")?.readiness_selector, "main.ready");
    assert.throws(() => database.prepare("UPDATE capture_duration_samples SET readiness_selector = ? WHERE sample_id = ?")
      .run("a".repeat(257), "sample-1"), /CHECK constraint failed/);
    assert.throws(() => database.prepare(
      "INSERT INTO capture_duration_samples (sample_id, capture_id, job_id, attempt, sampled_at, browser_ms, browser_ms_source, reserve_ms, browser_run_elapsed_ms, capture_elapsed_ms, outcome, readiness_mode) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("sample-2", "capture-1", "job-1", 1, 101, 1200, "response_header", 60_000, 1400, 1800, "succeeded", "domcontentloaded"), /UNIQUE constraint failed/);
    assert.throws(() => database.prepare("UPDATE capture_duration_samples SET browser_ms_source = 'made_up' WHERE sample_id = ?")
      .run("sample-1"), /CHECK constraint failed/);
    assert.throws(() => database.prepare("UPDATE capture_duration_samples SET capture_elapsed_ms = -1 WHERE sample_id = ?")
      .run("sample-1"), /CHECK constraint failed/);
  } finally { database.close(); }
});
