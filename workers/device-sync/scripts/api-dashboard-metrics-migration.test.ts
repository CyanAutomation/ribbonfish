import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("API dashboard metrics migration adds bounded per-capture measurements and preserves existing jobs", async () => {
  const latest = await readFile(new URL("../schema.sql", import.meta.url), "utf8");
  const columns = [
    "api_total_ms INTEGER NOT NULL DEFAULT 0 CHECK (api_total_ms >= 0),",
    "api_request_count INTEGER NOT NULL DEFAULT 0 CHECK (api_request_count >= 0),",
    "api_not_modified_count INTEGER NOT NULL DEFAULT 0 CHECK (api_not_modified_count >= 0),",
    "api_failed_request_count INTEGER NOT NULL DEFAULT 0 CHECK (api_failed_request_count >= 0),",
    "api_response_bytes INTEGER NOT NULL DEFAULT 0 CHECK (api_response_bytes >= 0),",
    "api_source_count INTEGER NOT NULL DEFAULT 0 CHECK (api_source_count >= 0),",
    "api_unavailable_source_count INTEGER NOT NULL DEFAULT 0 CHECK (api_unavailable_source_count >= 0),",
    "api_stale_source_count INTEGER NOT NULL DEFAULT 0 CHECK (api_stale_source_count >= 0),",
    "api_content_hash_match INTEGER NOT NULL DEFAULT 0 CHECK (api_content_hash_match IN (0, 1)),",
    "api_render_failed INTEGER NOT NULL DEFAULT 0 CHECK (api_render_failed IN (0, 1)),",
    "api_outcome TEXT CHECK (api_outcome IS NULL OR api_outcome IN ('complete', 'partial', 'all_failed')),",
  ];
  let prior = latest;
  for (const column of columns) prior = prior.replace(`  ${column}\n`, "");
  assert.notEqual(prior, latest, "migration fixture must use the schema before API dashboard metrics");
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(prior);
    db.prepare("INSERT INTO capture_targets (capture_id, variant_key, url, capture_interval_seconds, viewport_width, viewport_height, placeholder_sha256, placeholder_size, created_at, next_due_at) VALUES ('capture-a', 'target-a', 'https://api-dashboard.invalid/', 300, 1920, 1080, ?, 10, 1, 2)").run("a".repeat(64));
    db.exec("INSERT INTO capture_jobs (job_id, capture_id, status, created_at) VALUES ('job-a', 'capture-a', 'succeeded', 3)");
    db.exec(await readFile(new URL("../migrations/0018_api_dashboard_metrics.sql", import.meta.url), "utf8"));
    assert.deepEqual({ ...db.prepare("SELECT api_total_ms, api_request_count, api_render_failed, api_outcome FROM capture_jobs WHERE job_id = 'job-a'").get() }, {
      api_total_ms: 0, api_request_count: 0, api_render_failed: 0, api_outcome: null,
    });
    db.exec("UPDATE capture_jobs SET api_total_ms = 850, api_request_count = 12, api_not_modified_count = 4, api_response_bytes = 25000, api_source_count = 7, api_unavailable_source_count = 1, api_render_failed = 1, api_outcome = 'partial' WHERE job_id = 'job-a'");
    assert.deepEqual({ ...db.prepare("SELECT api_total_ms, api_request_count, api_not_modified_count, api_response_bytes, api_source_count, api_unavailable_source_count, api_render_failed, api_outcome FROM capture_jobs WHERE job_id = 'job-a'").get() }, {
      api_total_ms: 850, api_request_count: 12, api_not_modified_count: 4, api_response_bytes: 25000, api_source_count: 7, api_unavailable_source_count: 1, api_render_failed: 1, api_outcome: "partial",
    });
    assert.throws(() => db.exec("UPDATE capture_jobs SET api_outcome = 'healthy' WHERE job_id = 'job-a'"), /CHECK constraint failed/);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM capture_jobs").get()?.count, 1);
  } finally { db.close(); }
});
