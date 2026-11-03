import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const migration = await readFile(new URL("../migrations/0012_site_schedule_review.sql", import.meta.url), "utf8");

test("existing capture sites remain eligible after schedule review tracking is added", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("CREATE TABLE capture_targets (capture_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);");
    database.exec("INSERT INTO capture_targets VALUES ('existing-site', 12345);");
    database.exec(migration);
    assert.equal(database.prepare("SELECT schedule_reviewed_at FROM capture_targets WHERE capture_id = 'existing-site'").get()?.schedule_reviewed_at, 12345);
    database.prepare("INSERT INTO capture_targets (capture_id, created_at) VALUES ('new-site', 67890)").run();
    assert.equal(database.prepare("SELECT schedule_reviewed_at FROM capture_targets WHERE capture_id = 'new-site'").get()?.schedule_reviewed_at, null);
  } finally {
    database.close();
  }
});
