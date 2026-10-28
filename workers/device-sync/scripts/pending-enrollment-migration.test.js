import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const migration = await readFile(new URL("../migrations/0004_pending_device_enrollment.sql", import.meta.url), "utf8");

test("pending enrollment migration preserves legacy devices and enforces unique key identities", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE devices (
        device_id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER
      );
      CREATE INDEX devices_enabled_idx ON devices(enabled);
      INSERT INTO devices VALUES ('pi-existing', 'legacy-hash', 1, 10, 20);
    `);

    database.exec(migration);
    const legacy = database.prepare("SELECT * FROM devices WHERE device_id = 'pi-existing'").get();
    assert.equal(legacy.token_hash, "legacy-hash");
    assert.equal(legacy.public_key, null);
    assert.equal(legacy.last_seen_at, 20);

    const insert = database.prepare(
      "INSERT INTO devices (device_id, token_hash, public_key, enabled, created_at) VALUES (?, NULL, ?, 1, 30)",
    );
    insert.run("pi-keyed", "same-public-key");
    assert.throws(() => insert.run("pi-duplicate", "same-public-key"), /UNIQUE constraint failed/);
    assert.throws(() => database.prepare(
      "INSERT INTO devices (device_id, token_hash, public_key, enabled, created_at) VALUES ('invalid', NULL, NULL, 1, 30)",
    ).run(), /CHECK constraint failed/);
    assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'enrollment_requests'").get()?.name,
      "enrollment_requests");
  } finally {
    database.close();
  }
});
