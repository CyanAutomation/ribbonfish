import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pendingMigrations, ledgerNames } from './migration-readiness.js';
test('finds migrations absent from the production ledger', () => {
  assert.deepEqual(pendingMigrations(['0001_a.sql', '0002_b.sql'], ['0001_a.sql']), ['0002_b.sql']);
  assert.deepEqual(pendingMigrations(['0001_a.sql'], ['0001_a.sql']), []);
});
test('rejects malformed or failed ledger responses', () => {
  assert.throws(() => ledgerNames([{ success: false, results: [] }]));
  assert.throws(() => ledgerNames([{ success: true, results: [{}] }]));
  assert.deepEqual(ledgerNames([{ success: true, results: [{name: '0001_a.sql'}] }]), ['0001_a.sql']);
});
