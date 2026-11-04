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

test("capture interval migration preserves D1 relationships and accepts the new values", async (t) => {
  const persistTo = await mkdtemp(join(tmpdir(), "ribbonfish-local-d1-"));
  t.after(() => rm(persistTo, { recursive: true, force: true }));
  const schema = await readFile(join(packageRoot, "schema.sql"), "utf8");
  const previousSchema = schema.replace(
    "CHECK (capture_interval_seconds IN (900, 1800, 3600, 10800, 21600, 43200, 86400))",
    "CHECK (capture_interval_seconds IN (900, 1800, 3600, 21600, 86400))",
  );
  assert.notEqual(previousSchema, schema, "fixture must start with the old interval constraint");
  const migration = await readFile(join(packageRoot, "migrations/0016_capture_intervals.sql"), "utf8");
  const fixture = join(persistTo, "capture-intervals.sql");
  await writeFile(fixture, `
    PRAGMA foreign_keys = ON;
    ${previousSchema}
    INSERT INTO capture_targets (capture_id, variant_key, url, capture_interval_seconds, viewport_width, viewport_height,
      placeholder_sha256, placeholder_size, created_at, next_due_at)
    VALUES ('capture-1', 'example:1920x1080', 'https://example.com/', 900, 1920, 1080, '${"a".repeat(64)}', 4, 10, 50);
    INSERT INTO playlists (playlist_id, revision, rotation_interval, created_at) VALUES ('ops', 'revision-1', '90s', 10);
    INSERT INTO playlist_capture_items (playlist_id, revision, position, capture_id) VALUES ('ops', 'revision-1', 0, 'capture-1');
    INSERT INTO capture_jobs (job_id, capture_id, status, created_at) VALUES ('job-1', 'capture-1', 'succeeded', 20);
    INSERT INTO capture_history (capture_id, job_id, sha256, size, captured_at)
      VALUES ('capture-1', 'job-1', '${"c".repeat(64)}', 4, 30);
    INSERT INTO capture_duration_samples (sample_id, capture_id, job_id, attempt, sampled_at, browser_ms,
      browser_ms_source, reserve_ms, browser_run_elapsed_ms, capture_elapsed_ms, outcome, readiness_mode)
      VALUES ('sample-1', 'capture-1', 'job-1', 1, 30, 500, 'response_header', 100, 600, 700, 'succeeded', 'domcontentloaded');
    INSERT INTO capture_decisions (capture_id, due_at, assessed_at, action, reason)
      VALUES ('capture-1', 40, 40, 'capture', 'keep current schedule');
    INSERT INTO capture_skip_approvals (capture_id, due_at, expires_at, actor_id, created_at)
      VALUES ('capture-1', 40, 50, 'operator', 40);
    ${migration}
    INSERT INTO capture_targets (capture_id, variant_key, url, capture_interval_seconds, viewport_width, viewport_height,
      placeholder_sha256, placeholder_size, created_at, next_due_at)
    VALUES ('capture-3h', '3h:1920x1080', 'https://example.com/', 10800, 1920, 1080, '${"b".repeat(64)}', 4, 60, 60);
    INSERT INTO capture_targets (capture_id, variant_key, url, capture_interval_seconds, viewport_width, viewport_height,
      placeholder_sha256, placeholder_size, created_at, next_due_at)
    VALUES ('capture-12h', '12h:1920x1080', 'https://example.com/', 43200, 1920, 1080, '${"d".repeat(64)}', 4, 60, 60);
    CREATE TABLE capture_interval_migration_assertions (passed INTEGER NOT NULL CHECK (passed = 1));
    INSERT INTO capture_interval_migration_assertions
    SELECT CASE WHEN
      (SELECT COUNT(*) FROM capture_targets) = 3 AND
      (SELECT COUNT(*) FROM playlist_capture_items) = 1 AND
      (SELECT COUNT(*) FROM capture_jobs) = 1 AND
      (SELECT COUNT(*) FROM capture_history) = 1 AND
      (SELECT COUNT(*) FROM capture_duration_samples) = 1 AND
      (SELECT COUNT(*) FROM capture_decisions) = 1 AND
      (SELECT COUNT(*) FROM capture_skip_approvals) = 1
    THEN 1 ELSE 0 END;
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
