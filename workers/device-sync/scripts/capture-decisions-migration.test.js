import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const migration = await readFile(new URL("../migrations/0010_capture_decisions.sql", import.meta.url), "utf8");

test("capture decision migration preserves existing targets and can be applied repeatedly", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("PRAGMA foreign_keys = ON; CREATE TABLE capture_targets (capture_id TEXT PRIMARY KEY); INSERT INTO capture_targets VALUES ('existing');");
    database.exec(migration);
    database.exec(migration);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM capture_targets WHERE capture_id = 'existing'").get().count, 1);
    database.prepare("INSERT INTO capture_decisions (capture_id, due_at, assessed_at, action, reason, state_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run("existing", 100, 50, "capture", "keep schedule", JSON.stringify({ seconds_until_due: 50 }));
    assert.deepEqual(JSON.parse(database.prepare("SELECT state_json FROM capture_decisions").get().state_json), { seconds_until_due: 50 });
    assert.throws(() => database.prepare("INSERT INTO capture_decisions (capture_id, due_at, assessed_at, action, reason) VALUES (?, ?, ?, ?, ?)")
      .run("existing", 100, 51, "capture", "duplicate"));
    database.prepare("DELETE FROM capture_targets WHERE capture_id = ?").run("existing");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM capture_decisions").get().count, 0);
  } finally { database.close(); }
});
