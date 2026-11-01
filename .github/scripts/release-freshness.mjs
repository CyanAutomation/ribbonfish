import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function treeEntry(tree, name) {
  const entry = tree.find(item => item.path === name && item.type === 'tree');
  if (!entry?.sha) throw new Error(`Missing tree ${name}`);
  return entry.sha;
}

export function isCurrentTree(local, remote) {
  if (!local || !remote) throw new Error('Missing tree SHA');
  return local === remote;
}

function main() {
  const path = process.argv[2];
  const allowStale = process.argv[3] === '--allow-stale';
  if (process.argv.length > 4 || (process.argv[3] && !allowStale)) throw new Error('Invalid arguments');
  if (!['agent', 'workers/device-sync'].includes(path)) throw new Error('Invalid release path');
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error('Missing GITHUB_REPOSITORY');
  const local = execFileSync('git', ['rev-parse', `HEAD:${path}`], { encoding: 'utf8' }).trim();
  const api = endpoint => JSON.parse(execFileSync('gh', ['api', endpoint], { encoding: 'utf8' }));
  const head = api(`repos/${repo}/commits/main`);
  let sha = head.commit.tree.sha;
  for (const part of path.split('/')) sha = treeEntry(api(`repos/${repo}/git/trees/${sha}`).tree, part);
  const current = isCurrentTree(local, sha);
  console.log(`Release inputs ${current ? 'match' : 'differ from'} main (${head.sha})`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `current=${current}\n`);
  if (!current && !allowStale) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
