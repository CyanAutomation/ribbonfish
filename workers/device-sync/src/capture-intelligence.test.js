import test from 'node:test';
import assert from 'node:assert/strict';
import { decideCapturePolicy } from './capture-intelligence.js';

const now = 1_000_000;
const target = { capture_interval_seconds: 60, last_success_at: now - 60_000, next_due_at: now,
  current_asset_present: true, current_sha256: 'x', failure_count: 0, last_error: null, job_status: null,
  history: [{ sha256: 'x' }, { sha256: 'x' }, { sha256: 'x' }] };
const decision = { answers: { recommendation: { choice: 'skip_once' }, risk: { score: 0 } } };

test('stable captures can be proposed for one bounded deferral', () => {
  assert.deepEqual(decideCapturePolicy(target, decision, now), { action: 'defer_once', next_due_at: now + 60_000, reason: 'Three recent screenshots are identical and the current image is available.' });
});

test('uncertain, stale, missing or failed captures always retain their schedule', () => {
  for (const changed of [
    { last_success_at: now - 120_001 }, { current_asset_present: false }, { failure_count: 1 },
    { job_status: 'running' }, { history: [{ sha256: 'x' }, { sha256: 'y' }, { sha256: 'x' }] },
  ]) assert.equal(decideCapturePolicy({ ...target, ...changed }, decision, now).action, 'capture');
  assert.equal(decideCapturePolicy(target, null, now).action, 'capture');
  assert.equal(decideCapturePolicy(target, { answers: { recommendation: { choice: 'capture_now' } } }, now).action, 'capture');
});

test('a repeated deferral cannot exceed two configured intervals of image age', () => {
  assert.equal(decideCapturePolicy({ ...target, last_success_at: now - 120_000 }, decision, now).action, 'capture');
});
