import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

test("capture recovery migration preserves open jobs and seeds their retry cycle", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE capture_jobs (
        job_id TEXT PRIMARY KEY,
        capture_id TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER,
        lease_until INTEGER,
        error TEXT
      );
      INSERT INTO capture_jobs (job_id, capture_id, status, attempts, created_at, started_at, lease_until)
        VALUES ('open-job', 'capture-1', 'running', 2, 10, 20, 30);
      INSERT INTO capture_jobs (job_id, capture_id, status, attempts, created_at)
        VALUES ('finished-job', 'capture-1', 'succeeded', 3, 5);
    `);
    const migration = await readFile(new URL("../migrations/0019_capture_queue_recovery.sql", import.meta.url), "utf8");
    db.exec(migration);

    assert.deepEqual({ ...db.prepare(
      "SELECT status, attempts, retry_cycle_attempts, recovery_attempts, retry_after_at, lease_until FROM capture_jobs WHERE job_id = 'open-job'",
    ).get() }, {
      status: "running", attempts: 2, retry_cycle_attempts: 2, recovery_attempts: 0, retry_after_at: null, lease_until: 30,
    });
    assert.deepEqual({ ...db.prepare(
      "SELECT status, attempts, retry_cycle_attempts, recovery_attempts, retry_after_at FROM capture_jobs WHERE job_id = 'finished-job'",
    ).get() }, {
      status: "succeeded", attempts: 3, retry_cycle_attempts: 3, recovery_attempts: 0, retry_after_at: null,
    });
  } finally {
    db.close();
  }
});
