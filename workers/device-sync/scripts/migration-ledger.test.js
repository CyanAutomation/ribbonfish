import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrationLedgerSQL } from "./migration-ledger.js";

// Contract source: ../README.md#local-development (fresh local D1 bootstrap).

test("fresh database bootstrap creates a sorted, unique, idempotent migration ledger", () => {
  const database = new DatabaseSync(":memory:");
  try {
    const sql = migrationLedgerSQL([
      "0002_global_playlists.sql",
      "0001_add_enrollment_claim_id.sql",
      "0002_global_playlists.sql",
    ]);

    database.exec(sql);
    database.exec(sql);
    const names = database.prepare("SELECT name FROM d1_migrations ORDER BY name")
      .all()
      .map((row) => row.name);
    assert.deepEqual(names, [
      "0001_add_enrollment_claim_id.sql",
      "0002_global_playlists.sql",
    ]);
  } finally {
    database.close();
  }
});

test("migration ledger rejects names that could escape SQL string quoting", () => {
  assert.throws(() => migrationLedgerSQL(["bad'); DROP TABLE devices;--"]), /migration filenames/);
});
