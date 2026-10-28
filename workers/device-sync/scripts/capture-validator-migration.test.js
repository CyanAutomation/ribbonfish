import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const migration = await readFile(new URL("../migrations/0007_capture_validators.sql", import.meta.url), "utf8");

test("capture validator migration adds nullable validator columns", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`CREATE TABLE capture_targets (
      capture_id TEXT PRIMARY KEY,
      current_sha256 TEXT,
      current_size INTEGER,
      last_success_at INTEGER
    );`);
    database.exec(migration);
    const columns = new Set(database.prepare("PRAGMA table_info(capture_targets)").all().map((row) => row.name));
    assert.ok(columns.has("validator_etag"));
    assert.ok(columns.has("validator_last_modified"));
  } finally {
    database.close();
  }
});
