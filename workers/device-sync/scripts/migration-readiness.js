import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function ledgerNames(response) {
  if (!Array.isArray(response) || response.length !== 1 || response[0].success !== true || !Array.isArray(response[0].results) || response[0].results.some(row => typeof row.name !== 'string')) throw new Error('Invalid D1 migration ledger response');
  return response[0].results.map(row => row.name);
}
export function pendingMigrations(local, applied) {
  if (!Array.isArray(local) || !Array.isArray(applied)) throw new Error('Invalid migration list');
  const done = new Set(applied);
  return local.filter(name => /^\d+_.*\.sql$/.test(name) && !done.has(name)).sort();
}
function main() {
  const output = execFileSync('./node_modules/.bin/wrangler', ['d1', 'execute', 'ribbonfish-devices', '--remote', '--config', 'wrangler.management.toml', '--command', 'SELECT name FROM d1_migrations', '--json'], { encoding: 'utf8' });
  const pending = pendingMigrations(readdirSync('migrations'), ledgerNames(JSON.parse(output)));
  if (pending.length) throw new Error(`Unapplied migrations: ${pending.join(', ')}. Apply migrations before deploying.`);
  console.log('All repository migrations have been applied.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
