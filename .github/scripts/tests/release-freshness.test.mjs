import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCurrentTree, treeEntry } from '../release-freshness.mjs';
test('only matching release trees are current', () => {
  assert.equal(isCurrentTree('abc', 'abc'), true);
  assert.equal(isCurrentTree('abc', 'def'), false);
  assert.throws(() => isCurrentTree('', 'abc'));
});
test('tree lookup fails closed', () => {
  assert.equal(treeEntry([{ path: 'agent', type: 'tree', sha: 'abc' }], 'agent'), 'abc');
  assert.throws(() => treeEntry([{ path: 'agent', type: 'blob', sha: 'abc' }], 'agent'));
});

test('stale promotion fails even when GitHub provides GITHUB_OUTPUT', async () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, delimiter } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'freshness-'));
  try {
    writeFileSync(join(dir, 'git'), '#!/bin/sh\necho old\n', { mode: 0o755 });
    writeFileSync(join(dir, 'gh'), '#!/bin/sh\ncase "$2" in */commits/main) echo \'{"sha":"head","commit":{"tree":{"sha":"root"}}}\' ;; *) echo \'{"tree":[{"path":"agent","type":"tree","sha":"new"}]}\' ;; esac\n', { mode: 0o755 });
    const output = join(dir, 'output');
    const env = { ...process.env, PATH: dir + delimiter + process.env.PATH, GITHUB_OUTPUT: output, GITHUB_REPOSITORY: 'owner/repo' };
    const script = new URL('../release-freshness.mjs', import.meta.url).pathname;
    const stale = spawnSync(process.execPath, [script, 'agent'], { env });
    assert.equal(stale.status, 1, stale.stderr.toString());
    assert.match(readFileSync(output, 'utf8'), /current=false/);
    const skipped = spawnSync(process.execPath, [script, 'agent', '--allow-stale'], { env });
    assert.equal(skipped.status, 0, skipped.stderr.toString());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
