import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const migration = await readFile(new URL("../migrations/0009_capture_skip_approvals.sql", import.meta.url), "utf8");

test("capture skip migration is repeatable and approvals cascade with their target", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("PRAGMA foreign_keys = ON; CREATE TABLE capture_targets (capture_id TEXT PRIMARY KEY);");
    database.exec(migration);
    database.exec(migration);
    database.prepare("INSERT INTO capture_targets (capture_id) VALUES (?)").run("capture-1");
    database.prepare(
      "INSERT INTO capture_skip_approvals (capture_id, due_at, expires_at, actor_id, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("capture-1", 100, 200, "admin@example.com", 50);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM capture_skip_approvals").get().count, 1);
    database.prepare("DELETE FROM capture_targets WHERE capture_id = ?").run("capture-1");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM capture_skip_approvals").get().count, 0);
  } finally {
    database.close();
  }
});
