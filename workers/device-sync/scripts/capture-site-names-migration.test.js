import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

test("site names migration preserves existing capture sites", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE capture_targets (capture_id TEXT PRIMARY KEY, url TEXT NOT NULL);");
    db.exec("INSERT INTO capture_targets VALUES ('existing', 'https://example.com/');");
    db.exec(await readFile(new URL("../migrations/0014_capture_site_names.sql", import.meta.url), "utf8"));
    const row = db.prepare("SELECT url, name FROM capture_targets WHERE capture_id = ?").get("existing");
    assert.equal(row.url, "https://example.com/");
    assert.equal(row.name, null);
  } finally { db.close(); }
});
