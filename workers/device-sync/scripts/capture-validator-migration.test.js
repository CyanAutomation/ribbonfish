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
    );
    INSERT INTO capture_targets VALUES ('existing-capture', 'digest', 123, 456);`);
    database.exec(migration);
    const existing = database.prepare(`SELECT current_sha256, current_size, last_success_at,
      validator_etag, validator_last_modified FROM capture_targets WHERE capture_id = ?`).get("existing-capture");
    assert.deepEqual({ ...existing }, {
      current_sha256: "digest",
      current_size: 123,
      last_success_at: 456,
      validator_etag: null,
      validator_last_modified: null,
    }, "existing capture state is preserved and new validators start empty");

    database.prepare(`UPDATE capture_targets SET validator_etag = ?, validator_last_modified = ?
      WHERE capture_id = ?`).run('"revision-1"', "Wed, 21 Oct 2015 07:28:00 GMT", "existing-capture");
    database.prepare(`INSERT INTO capture_targets
      (capture_id, current_sha256, current_size, last_success_at, validator_etag, validator_last_modified)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run("without-validators", null, null, null, null, null);
    const withoutValidators = database.prepare(`SELECT validator_etag, validator_last_modified
      FROM capture_targets WHERE capture_id = ?`).get("without-validators");
    assert.deepEqual({ ...withoutValidators }, {
      validator_etag: null,
      validator_last_modified: null,
    }, "both validator columns accept null values");

    const columns = new Set(database.prepare("PRAGMA table_info(capture_targets)").all().map((row) => row.name));
    assert.ok(columns.has("validator_etag"));
    assert.ok(columns.has("validator_last_modified"));
    const updated = database.prepare(`SELECT validator_etag, validator_last_modified
      FROM capture_targets WHERE capture_id = ?`).get("existing-capture");
    assert.deepEqual({ ...updated }, {
      validator_etag: '"revision-1"',
      validator_last_modified: "Wed, 21 Oct 2015 07:28:00 GMT",
    });
  } finally {
    database.close();
  }
});
