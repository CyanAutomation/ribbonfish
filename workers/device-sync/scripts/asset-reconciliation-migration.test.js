import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

const migration = await readFile(new URL("../migrations/0006_asset_reconciliation.sql", import.meta.url), "utf8");

test("asset reconciliation migration is repeatable, backfills current references, and guards deletion races", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE playlists (playlist_id TEXT, revision TEXT, rotation_interval TEXT, created_at INTEGER,
        PRIMARY KEY (playlist_id, revision));
      CREATE TABLE playlist_assets (playlist_id TEXT, revision TEXT, position INTEGER, sha256 TEXT, size INTEGER);
      CREATE TABLE capture_targets (capture_id TEXT PRIMARY KEY, placeholder_sha256 TEXT, placeholder_size INTEGER,
        current_sha256 TEXT, current_size INTEGER);
      CREATE TABLE capture_history (capture_id TEXT, job_id TEXT, sha256 TEXT, size INTEGER);
      INSERT INTO playlists VALUES ('p', 'r1', '15s', 1);
      INSERT INTO playlist_assets VALUES ('p', 'r1', 0, '${"a".repeat(64)}', 11);
      INSERT INTO capture_targets VALUES ('c', '${"b".repeat(64)}', 12, '${"c".repeat(64)}', 13);
      INSERT INTO capture_history VALUES ('c', 'j', '${"c".repeat(64)}', 13);
    `);

    database.exec(migration);
    database.exec(migration);

    const assets = database.prepare("SELECT sha256, size, state FROM managed_assets ORDER BY sha256").all()
      .map((row) => ({ sha256: row.sha256, size: row.size, state: row.state }));
    assert.deepEqual(assets, [
      { sha256: "a".repeat(64), size: 11, state: "live" },
      { sha256: "b".repeat(64), size: 12, state: "live" },
      { sha256: "c".repeat(64), size: 13, state: "live" },
    ]);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM asset_reconciliation_state").get().count, 1);
    const leaseUntil = Date.now() + 60_000;
    database.prepare(
      "INSERT INTO managed_assets (sha256, size, state, expires_at, write_lease_until, updated_at) " +
      "VALUES (?, 17, 'pending', ?, ?, ?)",
    ).run("7".repeat(64), leaseUntil, leaseUntil, Date.now());
    database.prepare("INSERT INTO playlist_assets VALUES ('p', 'r2', 1, ?, 17)").run("7".repeat(64));
    const pendingAsset = database.prepare(
      "SELECT state, expires_at, write_lease_until FROM managed_assets WHERE sha256 = ?",
    ).get("7".repeat(64));
    assert.deepEqual({ ...pendingAsset }, {
      state: "pending",
      expires_at: leaseUntil,
      write_lease_until: leaseUntil,
    }, "adding a reference must preserve an in-flight upload lease");

    database.prepare(
      "INSERT INTO managed_assets (sha256, size, state, expires_at, write_lease_until, updated_at) " +
      "VALUES (?, 18, 'staged', ?, NULL, ?)",
    ).run("8".repeat(64), leaseUntil, Date.now());
    database.prepare("INSERT INTO playlist_assets VALUES ('p', 'r2', 2, ?, 18)").run("8".repeat(64));
    assert.deepEqual(
      { ...database.prepare("SELECT state, expires_at, write_lease_until FROM managed_assets WHERE sha256 = ?").get("8".repeat(64)) },
      { state: "live", expires_at: null, write_lease_until: null },
      "attaching a staged asset promotes it to live",
    );
    database.prepare("INSERT INTO playlist_assets VALUES ('p', 'r2', 0, ?, 14)").run("d".repeat(64));
    assert.deepEqual(
      { ...database.prepare("SELECT size, state FROM managed_assets WHERE sha256 = ?").get("d".repeat(64)) },
      { size: 14, state: "live" },
      "new references register content even when they bypass the Worker upload route",
    );
    database.prepare("INSERT INTO capture_targets VALUES ('new-target', ?, 15, ?, 16)")
      .run("e".repeat(64), "f".repeat(64));
    assert.equal(database.prepare("SELECT state FROM managed_assets WHERE sha256 = ?").get("f".repeat(64)).state,
      "live", "new current-image references are registered too");
    database.prepare("UPDATE managed_assets SET state = 'deleting' WHERE sha256 = ?").run("a".repeat(64));
    assert.throws(() => database.prepare(
      "INSERT INTO playlist_assets VALUES ('p', 'r1', 1, ?, 11)",
    ).run("a".repeat(64)), /asset deletion in progress/);
  } finally {
    database.close();
  }
});
