import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const wrangler = createRequire(import.meta.url).resolve("wrangler");

// Local migrations use Wrangler D1; production migration sequencing is documented in ../README.md.
test("interval defaults migration executes on an isolated local D1 database", async (t) => {
  const persistTo = await mkdtemp(join(tmpdir(), "ribbonfish-local-d1-"));
  t.after(() => rm(persistTo, { recursive: true, force: true }));
  const migration = await readFile(join(packageRoot, "migrations/0011_interval_defaults.sql"), "utf8");
  const fixture = join(persistTo, "interval-defaults.sql");
  await writeFile(fixture, `
    PRAGMA foreign_keys = ON;
    CREATE TABLE capture_targets (capture_id TEXT PRIMARY KEY, capture_interval_seconds INTEGER NOT NULL,
      next_due_at INTEGER NOT NULL, created_at INTEGER NOT NULL, last_success_at INTEGER);
    CREATE TABLE playlists (playlist_id TEXT NOT NULL, revision TEXT NOT NULL, rotation_interval TEXT NOT NULL,
      created_at INTEGER NOT NULL, PRIMARY KEY (playlist_id, revision));
    CREATE TABLE playlist_assets (playlist_id TEXT NOT NULL, revision TEXT NOT NULL, position INTEGER NOT NULL,
      sha256 TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY (playlist_id, revision, position));
    CREATE TABLE playlist_capture_items (playlist_id TEXT NOT NULL, revision TEXT NOT NULL, position INTEGER NOT NULL,
      capture_id TEXT NOT NULL, PRIMARY KEY (playlist_id, revision, position),
      FOREIGN KEY (playlist_id, revision) REFERENCES playlists(playlist_id, revision),
      FOREIGN KEY (capture_id) REFERENCES capture_targets(capture_id));
    CREATE TABLE active_playlist (singleton INTEGER PRIMARY KEY, playlist_id TEXT NOT NULL, revision TEXT NOT NULL);
    INSERT INTO capture_targets VALUES ('capture-1', 300, 20, 10, 15);
    INSERT INTO playlists VALUES ('welcome', 'old-active', '15s', 10);
    INSERT INTO playlist_assets VALUES ('welcome', 'old-active', 0, 'digest', 4);
    INSERT INTO playlist_capture_items VALUES ('welcome', 'old-active', 1, 'capture-1');
    INSERT INTO active_playlist VALUES (1, 'welcome', 'old-active');
    ${migration}
  `);

  const result = spawnSync(process.execPath, [
    wrangler,
    "d1",
    "execute",
    "ribbonfish-devices",
    "--local",
    "--persist-to",
    persistTo,
    "--config",
    "wrangler.management.toml",
    "--file",
    fixture,
  ], {
    cwd: packageRoot,
    env: { ...process.env, CI: "1" },
    encoding: "utf8",
    timeout: 30_000,
  });

  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Resource location: local/);
});
