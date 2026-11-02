import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const migration = await readFile(new URL("../migrations/0013_capture_efficiency_audit.sql", import.meta.url), "utf8");

test("capture efficiency migration adds readiness and audit fields without relabeling old records", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE capture_targets (capture_id TEXT PRIMARY KEY);
      CREATE TABLE capture_jobs (job_id TEXT PRIMARY KEY, created_at INTEGER);
      CREATE TABLE capture_history (capture_id TEXT, job_id TEXT, browser_ms INTEGER, captured_at INTEGER);
      CREATE TABLE capture_decisions (capture_id TEXT, due_at INTEGER, action TEXT);
      INSERT INTO capture_targets VALUES ('existing-capture');
      INSERT INTO capture_jobs VALUES ('existing-job', 1);
      INSERT INTO capture_history VALUES ('existing-capture', 'existing-job', 45000, 2);
      INSERT INTO capture_decisions VALUES ('existing-capture', 123, 'defer_once');
    `);
    database.exec(migration);

    assert.deepEqual({ ...database.prepare("SELECT wait_for_selector FROM capture_targets WHERE capture_id = ?").get("existing-capture") }, {
      wait_for_selector: null,
    });
    assert.deepEqual({ ...database.prepare("SELECT validator_outcome, result_kind FROM capture_jobs WHERE job_id = ?").get("existing-job") }, {
      validator_outcome: "unknown",
      result_kind: "unknown",
    });
    assert.deepEqual({ ...database.prepare("SELECT browser_ms_total, browser_ms_response_header, browser_ms_reserve FROM capture_jobs WHERE job_id = ?").get("existing-job") }, {
      browser_ms_total: null,
      browser_ms_response_header: null,
      browser_ms_reserve: null,
    });
    assert.equal(database.prepare("SELECT browser_ms_legacy_unknown FROM capture_jobs WHERE job_id = ?").get("existing-job").browser_ms_legacy_unknown, 1);
    assert.deepEqual({ ...database.prepare("SELECT browser_ms, browser_ms_source FROM capture_history WHERE job_id = ?").get("existing-job") }, {
      browser_ms: 45000,
      browser_ms_source: "unknown",
    });
    assert.deepEqual({ ...database.prepare("SELECT scheduled_due_at FROM capture_jobs WHERE job_id = ?").get("existing-job") }, {
      scheduled_due_at: null,
    });
    assert.deepEqual({ ...database.prepare("SELECT observed_result, observed_at, observed_delay_ms FROM capture_decisions WHERE due_at = 123").get() }, {
      observed_result: null,
      observed_at: null,
      observed_delay_ms: null,
    });
    assert.throws(() => database.prepare("UPDATE capture_history SET browser_ms_source = 'made_up' WHERE job_id = ?").run("existing-job"), /CHECK constraint failed/);
  } finally {
    database.close();
  }
});
