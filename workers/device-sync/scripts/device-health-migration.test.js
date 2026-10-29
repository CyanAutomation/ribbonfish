import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const migration = await readFile(new URL("../migrations/0008_device_health.sql", import.meta.url), "utf8");

test("device health migration creates bounded-history tables linked to enrolled devices", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("PRAGMA foreign_keys = ON;");
    database.exec(`CREATE TABLE devices (
      device_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1
    );`);
    database.exec(migration);
    const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    assert.ok(tables.has("device_health_latest"));
    assert.ok(tables.has("device_health_samples"));
    assert.ok(tables.has("device_health_events"));
    const healthColumns = new Set(database.prepare("PRAGMA table_info(device_health_latest)").all().map((row) => row.name));
    assert.ok(healthColumns.has("health_status"));

    database.prepare("INSERT INTO devices (device_id) VALUES (?)").run("ribbonfish-1");
    database.prepare(`INSERT INTO device_health_latest
      (device_id, instance_id, received_at, reported_state, health_status, health_key, agent_version, sync_status, report_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("ribbonfish-1", "instance-1", 1000, "ready", "healthy", "key", "agent-1", "ok", "{}");
    database.prepare("INSERT INTO device_health_samples VALUES (?, ?, ?, ?)")
      .run("ribbonfish-1", 0, 1000, "{}");
    database.prepare(`INSERT INTO device_health_events
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("event-1", "ribbonfish-1", "instance-1", 1000, "device.first_report", "ready", null, "{}");
    assert.throws(() => database.prepare(`INSERT INTO device_health_events
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("event-2", "ribbonfish-1", "instance-1", 2000, "raw.log.line", "ready", null, "{}"), /CHECK constraint failed/);

    database.prepare("DELETE FROM devices WHERE device_id = ?").run("ribbonfish-1");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM device_health_latest").get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM device_health_samples").get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM device_health_events").get().count, 0);
  } finally {
    database.close();
  }
});
