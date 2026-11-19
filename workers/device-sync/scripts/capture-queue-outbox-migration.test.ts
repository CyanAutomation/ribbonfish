import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

test("capture queue outbox migration preserves queued jobs and makes them dispatchable", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE capture_jobs (
        job_id TEXT PRIMARY KEY,
        capture_id TEXT NOT NULL,
        status TEXT NOT NULL,
        retry_after_at INTEGER,
        created_at INTEGER NOT NULL
      );
      INSERT INTO capture_jobs (job_id, capture_id, status, created_at)
        VALUES ('orphaned-job', 'capture-1', 'queued', 100);
    `);
    db.exec(await readFile(new URL("../migrations/0020_capture_queue_outbox.sql", import.meta.url), "utf8"));

    assert.deepEqual({ ...db.prepare(
      "SELECT status, queue_dispatch_attempts, queue_dispatch_after_at, queue_dispatch_lease_until FROM capture_jobs WHERE job_id = 'orphaned-job'",
    ).get() }, {
      status: "queued", queue_dispatch_attempts: 0, queue_dispatch_after_at: null, queue_dispatch_lease_until: null,
    });
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'capture_jobs_queue_dispatch_idx'").get()?.name,
      "capture_jobs_queue_dispatch_idx");
  } finally {
    db.close();
  }
});
