import test from "node:test";
import assert from "node:assert/strict";
import { migrationLedgerSQL } from "./migration-ledger.js";

test("fresh database bootstrap records the current migration set idempotently", () => {
  const sql = migrationLedgerSQL([
    "0002_global_playlists.sql",
    "0001_add_enrollment_claim_id.sql",
    "0002_global_playlists.sql",
  ]);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS d1_migrations/);
  assert.match(sql, /INSERT OR IGNORE INTO d1_migrations/);
  assert.ok(sql.indexOf("0001_add_enrollment_claim_id.sql") < sql.indexOf("0002_global_playlists.sql"));
  assert.equal(sql.match(/0002_global_playlists\.sql/g)?.length, 1);
});

test("migration ledger rejects names that could escape SQL string quoting", () => {
  assert.throws(() => migrationLedgerSQL(["bad'); DROP TABLE devices;--"]), /migration filenames/);
});
