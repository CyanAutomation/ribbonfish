import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { deleteUnreferencedAssets, reconcileAssets } from "./asset-maintenance.js";
import { storePngAsset } from "./asset-store.js";
import { beginAssetWrite, markAssetLiveStatement } from "./asset-registry.js";

const placeholder = new Uint8Array(await readFile(new URL("../public/admin/capture-pending.png", import.meta.url)));
const screenshot = new Uint8Array(await readFile(new URL("../../../agent/defaults/assets/service-health.png", import.meta.url)));
const placeholderDigest = createHash("sha256").update(placeholder).digest("hex");
const screenshotDigest = createHash("sha256").update(screenshot).digest("hex");
const DAY_MS = 24 * 60 * 60 * 1000;

function sqliteD1(sqlite, maxBindings = Infinity) {
  function statement(sql, values = []) {
    return {
      bind(...bound) {
        if (bound.length > maxBindings) throw new Error(`D1 binding limit exceeded: ${bound.length}`);
        return statement(sql, bound);
      },
      async first() { return sqlite.prepare(sql).get(...values) ?? null; },
      async all() { return { results: sqlite.prepare(sql).all(...values) }; },
      async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }; },
    };
  }
  return {
    prepare(sql) { return statement(sql); },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const item of statements) results.push(await item.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function environment(sqlite, { pageCap = Infinity, failDelete, maxBindings } = {}) {
  const objects = new Map([[
    "admin/capture-pending.png",
    { bytes: placeholder, uploaded: new Date(0) },
  ]]);
  const listCalls = [];
  let deleteFailure = failDelete;
  const DB = sqliteD1(sqlite, maxBindings);
  const ASSETS = {
    async head(key) {
      const object = objects.get(key);
      return object ? { size: object.bytes.byteLength, uploaded: object.uploaded } : null;
    },
    async get(key) {
      const object = objects.get(key);
      if (!object) return null;
      return {
        size: object.bytes.byteLength,
        async arrayBuffer() { return object.bytes.slice().buffer; },
      };
    },
    async put(key, value) {
      objects.set(key, { bytes: new Uint8Array(value), uploaded: new Date() });
    },
    async delete(keys) {
      if (deleteFailure) {
        const error = deleteFailure;
        deleteFailure = null;
        throw error;
      }
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
    async list({ prefix = "", cursor, limit = 1000 } = {}) {
      listCalls.push({ prefix, cursor, limit });
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      const afterCursor = cursor ? keys.filter((key) => key > cursor) : keys;
      const page = afterCursor.slice(0, Math.min(limit, pageCap));
      const truncated = afterCursor.length > page.length;
      return {
        objects: page.map((key) => ({
          key,
          size: objects.get(key).bytes.byteLength,
          uploaded: objects.get(key).uploaded,
        })),
        truncated,
        ...(truncated ? { cursor: page.at(-1) } : {}),
      };
    },
  };
  return { DB, ASSETS, objects, listCalls, env: { DB, ASSETS } };
}

async function freshDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec(await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
  sqlite.exec(await readFile(new URL("../migrations/0005_webpage_capture.sql", import.meta.url), "utf8"));
  sqlite.exec(await readFile(new URL("../migrations/0006_asset_reconciliation.sql", import.meta.url), "utf8"));
  return sqlite;
}

function insertCapture(sqlite, { captureID = "capture-1", current = null, lastSuccess = null } = {}) {
  sqlite.prepare(
    "INSERT INTO capture_targets (capture_id, variant_key, url, capture_interval_seconds, viewport_width, viewport_height, " +
    "placeholder_sha256, placeholder_size, current_sha256, current_size, created_at, next_due_at, last_success_at) " +
    "VALUES (?, ?, ?, 60, 1280, 720, ?, ?, ?, ?, 1, 1, ?)",
  ).run(captureID, `variant-${captureID}`, "https://example.com/", placeholderDigest, placeholder.byteLength,
    current, current ? screenshot.byteLength : null, lastSuccess);
  return captureID;
}

test("stored but unattached PNGs receive a staging lease and survive until it expires", async () => {
  const sqlite = await freshDatabase();
  try {
    const { env, objects } = environment(sqlite);
    const now = Date.now();
    const asset = await storePngAsset(screenshot, env.ASSETS, { db: env.DB, now });
    const lease = sqlite.prepare("SELECT state, expires_at FROM managed_assets WHERE sha256 = ?").get(asset.sha256);
    assert.equal(lease.state, "staged");
    assert.ok(lease.expires_at > now);

    await reconcileAssets(env, now + 1_000);
    assert.ok(objects.has(`assets/${asset.sha256}`), "a playlist may still be attaching this upload");

    await reconcileAssets(env, lease.expires_at + 1);
    assert.equal(objects.has(`assets/${asset.sha256}`), false);
  } finally {
    sqlite.close();
  }
});

test("expired registry records are retried as known assets without the legacy orphan grace", async () => {
  const sqlite = await freshDatabase();
  try {
    const { env, objects } = environment(sqlite);
    const now = Date.now();
    const sha256 = "9".repeat(64);
    const missingSha256 = "8".repeat(64);
    objects.set(`assets/${sha256}`, { bytes: screenshot, uploaded: new Date(now) });
    sqlite.prepare(
      "INSERT INTO managed_assets (sha256, size, state, expires_at, updated_at) VALUES (?, ?, 'live', NULL, ?)",
    ).run(sha256, screenshot.byteLength, now);
    sqlite.prepare(
      "INSERT INTO managed_assets (sha256, size, state, expires_at, updated_at) VALUES (?, ?, 'live', NULL, ?)",
    ).run(missingSha256, screenshot.byteLength, now);

    await reconcileAssets(env, now + 1);

    assert.equal(objects.has(`assets/${sha256}`), false);
    assert.equal(sqlite.prepare("SELECT 1 FROM managed_assets WHERE sha256 = ?").get(sha256), undefined);
    assert.equal(sqlite.prepare("SELECT 1 FROM managed_assets WHERE sha256 = ?").get(missingSha256), undefined,
      "a stale D1 asset record is removed even when the R2 object is already missing");
  } finally {
    sqlite.close();
  }
});

test("capture pruning deletes unreferenced assets in D1-safe pages", async () => {
  const sqlite = await freshDatabase();
  try {
    const { env, objects } = environment(sqlite, { maxBindings: 40 });
    const now = Date.now();
    const digests = Array.from({ length: 41 }, (_, index) => index.toString(16).padStart(64, "0"));
    for (const sha256 of digests) {
      objects.set(`assets/${sha256}`, { bytes: screenshot, uploaded: new Date(now - DAY_MS) });
    }

    const deleted = await deleteUnreferencedAssets(env, digests, now);

    assert.equal(deleted, digests.length);
    assert.ok(digests.every((sha256) => !objects.has(`assets/${sha256}`)));
  } finally {
    sqlite.close();
  }
});

test("orphan sweep paginates by cursor and leaves non-content keys alone", async () => {
  const sqlite = await freshDatabase();
  try {
    const { env, objects, listCalls } = environment(sqlite, { pageCap: 1 });
    const old = new Date(Date.now() - 2 * DAY_MS);
    objects.set(`assets/${"a".repeat(64)}`, { bytes: screenshot, uploaded: old });
    objects.set(`assets/${"b".repeat(64)}`, { bytes: screenshot, uploaded: old });
    objects.set("admin/keep.png", { bytes: placeholder, uploaded: old });

    await reconcileAssets(env, Date.now());
    await reconcileAssets(env, Date.now());

    assert.equal(objects.has(`assets/${"a".repeat(64)}`), false);
    assert.equal(objects.has(`assets/${"b".repeat(64)}`), false);
    assert.equal(objects.has("admin/keep.png"), true);
    assert.ok(listCalls.some((call) => call.cursor), "the next pass resumes with R2's cursor");
  } finally {
    sqlite.close();
  }
});

test("a failed R2 deletion stays claimed and is retried on a later maintenance pass", async () => {
  const sqlite = await freshDatabase();
  try {
    const failure = new Error("temporary R2 delete failure");
    const { env, objects } = environment(sqlite, { failDelete: failure });
    const sha256 = "c".repeat(64);
    objects.set(`assets/${sha256}`, { bytes: screenshot, uploaded: new Date(Date.now() - 2 * DAY_MS) });

    await reconcileAssets(env, Date.now());
    assert.ok(objects.has(`assets/${sha256}`));
    assert.equal(sqlite.prepare("SELECT state FROM managed_assets WHERE sha256 = ?").get(sha256).state, "deleting");

    await reconcileAssets(env, Date.now() + 1);
    assert.equal(objects.has(`assets/${sha256}`), false);
    assert.equal(sqlite.prepare("SELECT 1 FROM managed_assets WHERE sha256 = ?").get(sha256), undefined);
  } finally {
    sqlite.close();
  }
});

test("an active write lease protects an object if its last reference is removed", async () => {
  const sqlite = await freshDatabase();
  try {
    const { env, objects } = environment(sqlite);
    const now = Date.now();
    objects.set(`assets/${screenshotDigest}`, { bytes: screenshot, uploaded: new Date(now - DAY_MS) });
    sqlite.prepare("INSERT INTO playlists (playlist_id, revision, rotation_interval, created_at) VALUES ('p', 'r1', '15s', 1)").run();
    await env.DB.batch([
      markAssetLiveStatement(env.DB, screenshotDigest, screenshot.byteLength, now),
      env.DB.prepare("INSERT INTO playlist_assets (playlist_id, revision, position, sha256, size) VALUES ('p', 'r1', 0, ?, ?)")
        .bind(screenshotDigest, screenshot.byteLength),
    ]);

    await beginAssetWrite(env.DB, screenshotDigest, screenshot.byteLength, now);
    sqlite.prepare("DELETE FROM playlist_assets WHERE sha256 = ?").run(screenshotDigest);
    await reconcileAssets(env, now + 1);

    assert.ok(objects.has(`assets/${screenshotDigest}`));
    assert.equal(sqlite.prepare("SELECT state FROM managed_assets WHERE sha256 = ?").get(screenshotDigest).state, "pending");
  } finally {
    sqlite.close();
  }
});

test("missing capture objects clear stale current/history references and missing playlist assets remain reportable", async () => {
  const sqlite = await freshDatabase();
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.map((value) =>
    typeof value === "string" ? value : JSON.stringify(value)).join(" "));
  try {
    const { env } = environment(sqlite);
    const captureID = insertCapture(sqlite, { current: screenshotDigest, lastSuccess: Date.now() - 1_000 });
    const jobID = crypto.randomUUID();
    sqlite.prepare("INSERT INTO capture_jobs (job_id, capture_id, status, created_at, finished_at) VALUES (?, ?, 'succeeded', 1, 1)")
      .run(jobID, captureID);
    sqlite.prepare("INSERT INTO capture_history (capture_id, job_id, sha256, size, captured_at) VALUES (?, ?, ?, ?, ?)")
      .run(captureID, jobID, screenshotDigest, screenshot.byteLength, Date.now() - 1_000);
    sqlite.prepare("INSERT INTO playlists (playlist_id, revision, rotation_interval, created_at) VALUES ('p', 'r1', '15s', 1)").run();
    sqlite.prepare("INSERT INTO playlist_assets (playlist_id, revision, position, sha256, size) VALUES ('p', 'r1', 0, ?, ?)")
      .run("d".repeat(64), screenshot.byteLength);

    await reconcileAssets(env, Date.now());

    assert.equal(sqlite.prepare("SELECT current_sha256 FROM capture_targets WHERE capture_id = ?").get(captureID).current_sha256, null);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM capture_history WHERE sha256 = ?").get(screenshotDigest).count, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM playlist_assets WHERE sha256 = ?").get("d".repeat(64)).count, 1,
      "immutable playlist revisions are preserved for operator repair");
    assert.ok(warnings.some((message) => message.includes("missing_playlist_asset")));
  } finally {
    console.warn = originalWarn;
    sqlite.close();
  }
});

test("a missing holding object is restored from the published holding image", async () => {
  const sqlite = await freshDatabase();
  try {
    const { env, objects } = environment(sqlite);
    const captureID = insertCapture(sqlite);
    await storePngAsset(placeholder, env.ASSETS, { db: env.DB });
    objects.delete(`assets/${placeholderDigest}`);

    await reconcileAssets(env, Date.now());

    assert.ok(objects.has(`assets/${placeholderDigest}`));
    assert.ok(sqlite.prepare("SELECT state FROM managed_assets WHERE sha256 = ?").get(placeholderDigest));
    assert.equal(sqlite.prepare("SELECT placeholder_sha256 FROM capture_targets WHERE capture_id = ?").get(captureID).placeholder_sha256,
      placeholderDigest);
  } finally {
    sqlite.close();
  }
});

test("D1 reference pagination reaches later missing images and resolves issues after repair", async () => {
  const sqlite = await freshDatabase();
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const { env, objects } = environment(sqlite);
    env.ASSET_RECONCILIATION_PAGE_SIZE = "1";
    sqlite.prepare("INSERT INTO playlists (playlist_id, revision, rotation_interval, created_at) VALUES ('p', 'r1', '15s', 1)").run();
    for (const [position, sha256] of [[0, "1".repeat(64)], [1, "2".repeat(64)]]) {
      sqlite.prepare("INSERT INTO playlist_assets (playlist_id, revision, position, sha256, size) VALUES ('p', 'r1', ?, ?, 10)")
        .run(position, sha256);
    }

    await reconcileAssets(env, Date.now());
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM asset_integrity_issues WHERE resolved_at IS NULL").get().count, 1);
    await reconcileAssets(env, Date.now() + 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM asset_integrity_issues WHERE resolved_at IS NULL").get().count, 2);

    objects.set(`assets/${"2".repeat(64)}`, { bytes: screenshot, uploaded: new Date() });
    await reconcileAssets(env, Date.now() + 2);
    await reconcileAssets(env, Date.now() + 3);
    await reconcileAssets(env, Date.now() + 4);
    assert.ok(sqlite.prepare(
      "SELECT resolved_at FROM asset_integrity_issues WHERE sha256 = ? AND issue_type = 'missing_playlist_asset'",
    ).get("2".repeat(64)).resolved_at > 0);
  } finally {
    console.warn = originalWarn;
    sqlite.close();
  }
});

test("missing-reference repairs stay bounded and continue from the last processed digest", async () => {
  const sqlite = await freshDatabase();
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const { env } = environment(sqlite);
    sqlite.prepare("INSERT INTO playlists (playlist_id, revision, rotation_interval, created_at) VALUES ('p', 'r1', '15s', 1)").run();
    const digests = Array.from({ length: 6 }, (_, index) => (index + 1).toString(16).padStart(64, "0"));
    for (const [position, sha256] of digests.entries()) {
      sqlite.prepare("INSERT INTO playlist_assets (playlist_id, revision, position, sha256, size) VALUES ('p', 'r1', ?, ?, 10)")
        .run(position, sha256);
    }

    await reconcileAssets(env, Date.now());
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM asset_integrity_issues WHERE resolved_at IS NULL").get().count, 3);
    assert.equal(sqlite.prepare("SELECT reference_cursor FROM asset_reconciliation_state").get().reference_cursor, digests[2]);

    await reconcileAssets(env, Date.now() + 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM asset_integrity_issues WHERE resolved_at IS NULL").get().count, 6);
    assert.equal(sqlite.prepare("SELECT reference_cursor FROM asset_reconciliation_state").get().reference_cursor, null);
  } finally {
    console.warn = originalWarn;
    sqlite.close();
  }
});

test("reference writes cannot race an asset deletion claim", async () => {
  const sqlite = await freshDatabase();
  try {
    const sha256 = "e".repeat(64);
    sqlite.prepare("INSERT INTO managed_assets (sha256, size, state, expires_at, updated_at) VALUES (?, 10, 'deleting', NULL, 1)")
      .run(sha256);
    sqlite.prepare("INSERT INTO playlists (playlist_id, revision, rotation_interval, created_at) VALUES ('p', 'r1', '15s', 1)").run();

    assert.throws(() => sqlite.prepare(
      "INSERT INTO playlist_assets (playlist_id, revision, position, sha256, size) VALUES ('p', 'r1', 0, ?, 10)",
    ).run(sha256), /asset deletion in progress/);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM playlist_assets").get().count, 0);
  } finally {
    sqlite.close();
  }
});
