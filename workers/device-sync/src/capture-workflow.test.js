import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { enqueueCapture } from "./capture-workflow.js";
import { fetchHandler, queueHandler, scheduledHandler } from "./index.js";
import { handleAdminRequest } from "./admin.js";

const placeholder = new Uint8Array(await readFile(new URL("../public/admin/capture-pending.png", import.meta.url)));
const screenshot = new Uint8Array(await readFile(new URL("../../../agent/defaults/assets/service-health.png", import.meta.url)));

function sqliteD1(sqlite) {
  function statement(sql, values = []) {
    return {
      bind(...bound) { return statement(sql, bound); },
      async first() { return sqlite.prepare(sql).get(...values) ?? null; },
      async all() { return { results: sqlite.prepare(sql).all(...values) }; },
      async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }; },
      sql,
      values,
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

function environment(sqlite, { quickAction } = {}) {
  const objects = new Map([["admin/capture-pending.png", placeholder]]);
  const messages = [];
  const DB = sqliteD1(sqlite);
  return {
    objects,
    messages,
    DB,
    env: {
      DB,
      ADMIN_ENABLED: "true",
      ADMIN_ACCESS_REQUIRED: "false",
      DAILY_BROWSER_BUDGET_MS: "540000",
      CAPTURE_MIN_REQUEST_GAP_MS: "0",
      CAPTURE_ALLOWED_HOSTS: "example.com",
      CAPTURE_QUEUE: { async send(body) { messages.push(body); } },
      BROWSER: { async quickAction(...args) {
        if (!quickAction) throw new Error("Browser Run not configured");
        return quickAction(...args);
      } },
      ASSETS: {
        async get(key) {
          const bytes = objects.get(key);
          return bytes ? {
            size: bytes.byteLength,
            body: new Response(bytes).body,
            async arrayBuffer() { return bytes.slice().buffer; },
          } : null;
        },
        async head(key) {
          const bytes = objects.get(key);
          return bytes ? { size: bytes.byteLength } : null;
        },
        async put(key, value) { objects.set(key, new Uint8Array(value)); },
        async delete(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key); },
        async list({ prefix = "", cursor, limit = 1000 } = {}) {
          const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
          const remaining = cursor ? keys.filter((key) => key > cursor) : keys;
          const page = remaining.slice(0, limit);
          const truncated = remaining.length > page.length;
          return {
            objects: page.map((key) => ({ key, size: objects.get(key).byteLength, uploaded: new Date() })),
            truncated,
            ...(truncated ? { cursor: page.at(-1) } : {}),
          };
        },
      },
    },
  };
}

async function request(path, { method = "GET", body, headers = {} } = {}) {
  return new Request(`https://worker.test${path}`, {
    method,
    headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function freshDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec(await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
  sqlite.exec(await readFile(new URL("../migrations/0005_webpage_capture.sql", import.meta.url), "utf8"));
  return sqlite;
}

async function createCapturePlaylist(env, url = "https://example.com/status") {
  const response = await handleAdminRequest(await request("/admin/api/playlists", {
    method: "POST",
    body: {
      id: "operations",
      rotation_interval: "15s",
      assets: [],
      captures: [{
        url,
        capture_interval_seconds: 60,
        viewport: { width: 1280, height: 720 },
      }],
    },
  }), env);
  return { response, body: await response.json() };
}

function addDevice(sqlite) {
  const token = "device-token-for-capture-workflow-test";
  const tokenHash = createHash("sha256").update(token).digest("hex");
  sqlite.prepare("INSERT INTO devices (device_id, token_hash, enabled, created_at) VALUES (?, ?, 1, ?)")
    .run("pi-office", tokenHash, Date.now());
  return token;
}

test("a webpage is a playlist item with a holding PNG before its first scheduled capture", async () => {
  const sqlite = await freshDatabase();
  try {
    const { env } = environment(sqlite);
    const created = await createCapturePlaylist(env);
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.capture_count, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM playlist_capture_items").get().count, 1);

    const activation = await handleAdminRequest(await request("/admin/api/active-playlist", {
      method: "PUT",
      body: { playlist_id: "operations", revision: created.body.revision },
    }), env);
    assert.equal(activation.status, 200);

    const token = addDevice(sqlite);
    const response = await fetchHandler(new Request("https://worker.test/v2/playlist", {
      headers: { "X-Ribbonfish-Device-ID": "pi-office", Authorization: `Bearer ${token}` },
    }), env);
    assert.equal(response.status, 200);
    const playlist = await response.json();
    assert.equal(playlist.assets.length, 1);
    assert.equal(playlist.assets[0].sha256, created.body.captures[0].placeholder_sha256);
  } finally {
    sqlite.close();
  }
});

test("scheduled capture updates the playlist slot to a content-addressed screenshot", async () => {
  const sqlite = await freshDatabase();
  try {
    const calls = [];
    const { env, messages, objects } = environment(sqlite, {
      async quickAction(action, options) {
        calls.push({ action, options });
        return new Response(screenshot, {
          headers: { "Content-Type": "image/png", "X-Browser-Ms-Used": "1234" },
        });
      },
    });
    const created = await createCapturePlaylist(env);
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    await handleAdminRequest(await request("/admin/api/active-playlist", {
      method: "PUT",
      body: { playlist_id: "operations", revision: created.body.revision },
    }), env);
    const token = addDevice(sqlite);
    const before = await fetchHandler(new Request("https://worker.test/v2/playlist", {
      headers: { "X-Ribbonfish-Device-ID": "pi-office", Authorization: `Bearer ${token}` },
    }), env);
    const oldTag = before.headers.get("ETag");

    await scheduledHandler({ scheduledTime: Date.now() }, env, {});
    assert.equal(messages.length, 1);
    const message = { body: messages[0], acked: false, async ack() { this.acked = true; }, retry() { throw new Error("unexpected retry"); } };
    await queueHandler({ messages: [message] }, env);
    assert.equal(message.acked, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, "screenshot");
    assert.equal(calls[0].options.url, "https://example.com/status");

    const target = sqlite.prepare("SELECT current_sha256, current_size FROM capture_targets").get();
    const expected = createHash("sha256").update(screenshot).digest("hex");
    assert.equal(target.current_sha256, expected);
    assert.equal(target.current_size, screenshot.byteLength);
    assert.ok(objects.has(`assets/${expected}`));
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM capture_history").get().count, 1);

    const after = await fetchHandler(new Request("https://worker.test/v2/playlist", {
      headers: {
        "X-Ribbonfish-Device-ID": "pi-office",
        Authorization: `Bearer ${token}`,
        "If-None-Match": oldTag,
      },
    }), env);
    assert.equal(after.status, 200, "a new screenshot changes the device snapshot ETag");
    const updated = await after.json();
    assert.equal(updated.assets[0].sha256, expected);
    assert.equal(after.headers.get("ETag"), `"${updated.revision}"`);

    const downloaded = await fetchHandler(new Request(`https://worker.test/v2/assets/${expected}`, {
      headers: { "X-Ribbonfish-Device-ID": "pi-office", Authorization: `Bearer ${token}` },
    }), env);
    assert.equal(downloaded.status, 200, await downloaded.clone().text());
    assert.deepEqual(new Uint8Array(await downloaded.arrayBuffer()), screenshot);
  } finally {
    sqlite.close();
  }
});

test("trusted unchanged HTTP validators skip Browser Run and preserve the cached screenshot", async () => {
  const sqlite = await freshDatabase();
  const originalFetch = globalThis.fetch;
  try {
    let browserCalls = 0;
    let probeRequest;
    const { env, objects } = environment(sqlite, {
      async quickAction() { browserCalls++; throw new Error("Browser Run should be skipped"); },
    });
    env.CAPTURE_VALIDATOR_HOSTS = "example.com";
    env.DAILY_BROWSER_BUDGET_MS = "1";
    const created = await createCapturePlaylist(env);
    const captureID = created.body.captures[0].capture_id;
    const sha256 = createHash("sha256").update(screenshot).digest("hex");
    objects.set(`assets/${sha256}`, screenshot);
    sqlite.prepare(
      "UPDATE capture_targets SET current_sha256 = ?, current_size = ?, last_success_at = ?, validator_etag = ? WHERE capture_id = ?",
    ).run(sha256, screenshot.byteLength, Date.now() - 60_000, '"source-v1"', captureID);
    const requested = await handleAdminRequest(await request(`/admin/api/captures/${captureID}/run`, {
      method: "POST", body: {},
    }), env);
    const jobID = (await requested.json()).job_id;
    globalThis.fetch = async (url, options) => {
      probeRequest = { url: String(url), options };
      return new Response(null, { status: 304 });
    };

    const message = { body: { job_id: jobID }, acked: false, ack() { this.acked = true; }, retry() { throw new Error("unexpected retry"); } };
    await queueHandler({ messages: [message] }, env);

    assert.equal(message.acked, true);
    assert.equal(probeRequest.url, "https://example.com/status");
    assert.equal(probeRequest.options.method, "HEAD");
    assert.equal(probeRequest.options.headers.get("If-None-Match"), '"source-v1"');
    assert.equal(browserCalls, 0);
    assert.equal(sqlite.prepare("SELECT status FROM capture_jobs WHERE job_id = ?").get(jobID).status, "succeeded");
    const preserved = sqlite.prepare("SELECT current_sha256, validator_etag FROM capture_targets WHERE capture_id = ?").get(captureID);
    assert.equal(preserved.current_sha256, sha256);
    assert.equal(preserved.validator_etag, '"source-v1"');
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM capture_history").get().count, 0);
    assert.equal(sqlite.prepare("SELECT browser_ms FROM capture_usage WHERE singleton = 1").get() ?? null, null,
      "a validator hit does not consume Browser Run budget");
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.close();
  }
});

test("capture requests reject private targets and queueing coalesces each target", async () => {
  const sqlite = await freshDatabase();
  try {
    const { env, messages } = environment(sqlite);
    const disallowed = await createCapturePlaylist(env, "https://not-allowed.example/status");
    assert.equal(disallowed.response.status, 400);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM playlists").get().count, 0);

    const unsafe = await createCapturePlaylist(env, "https://127.0.0.1/private");
    assert.equal(unsafe.response.status, 400);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM playlists").get().count, 0);

    const created = await createCapturePlaylist(env);
    const { capture_id } = created.body.captures[0];
    const first = await handleAdminRequest(await request(`/admin/api/captures/${capture_id}/run`, { method: "POST", body: {} }), env);
    const second = await handleAdminRequest(await request(`/admin/api/captures/${capture_id}/run`, { method: "POST", body: {} }), env);
    assert.equal(first.status, 202);
    assert.equal(second.status, 202);
    assert.equal(messages.length, 1);
    assert.equal((await first.json()).job_id, (await second.json()).job_id);
  } finally {
    sqlite.close();
  }
});

test("manual capture runs reject a target removed from the allowlist before enqueueing", async () => {
  const sqlite = await freshDatabase();
  try {
    const { env, messages } = environment(sqlite);
    const created = await createCapturePlaylist(env);
    const captureID = created.body.captures[0].capture_id;
    env.CAPTURE_ALLOWED_HOSTS = "other.example";

    const response = await handleAdminRequest(await request(`/admin/api/captures/${captureID}/run`, {
      method: "POST", body: {},
    }), env);

    assert.equal(response.status, 409);
    assert.match(await response.text(), /allowlist/i);
    assert.equal(messages.length, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM capture_jobs").get().count, 0);
  } finally {
    sqlite.close();
  }
});

test("scheduled capture dispatch skips targets removed from the allowlist", async () => {
  const sqlite = await freshDatabase();
  try {
    const { env, messages } = environment(sqlite);
    const created = await createCapturePlaylist(env);
    const captureID = created.body.captures[0].capture_id;
    const originalDue = sqlite.prepare("SELECT next_due_at FROM capture_targets WHERE capture_id = ?")
      .get(captureID).next_due_at;
    env.CAPTURE_ALLOWED_HOSTS = "other.example";

    await assert.rejects(
      enqueueCapture(captureID, env, { now: originalDue + 10_000, scheduled: true }),
      /allowlist/i,
    );

    assert.equal(messages.length, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM capture_jobs").get().count, 0);
    assert.equal(sqlite.prepare("SELECT next_due_at FROM capture_targets WHERE capture_id = ?")
      .get(captureID).next_due_at, originalDue);
  } finally {
    sqlite.close();
  }
});

test("coalescing a scheduled request leaves the target due time unchanged", async () => {
  const sqlite = await freshDatabase();
  try {
    const { env } = environment(sqlite);
    const created = await createCapturePlaylist(env);
    const captureID = created.body.captures[0].capture_id;
    const requested = await handleAdminRequest(await request(`/admin/api/captures/${captureID}/run`, {
      method: "POST", body: {},
    }), env);
    assert.equal(requested.status, 202);
    const originalDue = sqlite.prepare("SELECT next_due_at FROM capture_targets WHERE capture_id = ?")
      .get(captureID).next_due_at;

    const result = await enqueueCapture(captureID, env, { now: originalDue + 10_000, scheduled: true });

    assert.equal(result.queued, false);
    assert.equal(sqlite.prepare("SELECT next_due_at FROM capture_targets WHERE capture_id = ?")
      .get(captureID).next_due_at, originalDue);
  } finally {
    sqlite.close();
  }
});

test("capture overview reports the safe holding preview and queued status", async () => {
  const sqlite = await freshDatabase();
  try {
    const { env } = environment(sqlite);
    const created = await createCapturePlaylist(env, "https://example.com/status?token=private-value");
    const captureID = created.body.captures[0].capture_id;
    await handleAdminRequest(await request(`/admin/api/captures/${captureID}/run`, {
      method: "POST", body: {},
    }), env);

    const response = await handleAdminRequest(await request("/admin/api/overview"), env);
    const overview = await response.json();
    assert.equal(response.status, 200);
    assert.equal(overview.capture_targets[0].sha256, created.body.captures[0].placeholder_sha256);
    assert.equal(overview.capture_targets[0].job_status, "queued");
    assert.equal(overview.capture_targets[0].display_url, "https://example.com/status");
    assert.equal(JSON.stringify(overview).includes("private-value"), false);
  } finally {
    sqlite.close();
  }
});

test("deleting an inactive playlist removes its capture-slot references", async () => {
  const sqlite = await freshDatabase();
  try {
    const { env } = environment(sqlite);
    const created = await createCapturePlaylist(env);
    assert.equal(created.response.status, 201);

    const deleted = await handleAdminRequest(await request("/admin/api/playlists/operations", {
      method: "DELETE",
    }), env);

    assert.equal(deleted.status, 200, await deleted.clone().text());
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM playlists").get().count, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM playlist_capture_items").get().count, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM capture_targets").get().count, 1);
  } finally {
    sqlite.close();
  }
});

test("Browser Run failures use bounded delayed retries and leave the holding image active", async () => {
  const sqlite = await freshDatabase();
  try {
    let calls = 0;
    const { env, messages } = environment(sqlite, {
      async quickAction() {
        calls += 1;
        return new Response("temporarily unavailable", { status: 503 });
      },
    });
    const created = await createCapturePlaylist(env);
    const captureID = created.body.captures[0].capture_id;
    const requested = await handleAdminRequest(await request(`/admin/api/captures/${captureID}/run`, {
      method: "POST", body: {},
    }), env);
    const jobID = (await requested.json()).job_id;
    const delivery = (attempt) => ({
      body: { job_id: jobID },
      attempt,
      acked: false,
      retryDelay: null,
      ack() { this.acked = true; },
      retry(options) { this.retryDelay = options.delaySeconds; },
    });

    const first = delivery(1);
    await queueHandler({ messages: [first] }, env);
    assert.equal(first.retryDelay, 60);
    const second = delivery(2);
    await queueHandler({ messages: [second] }, env);
    assert.equal(second.retryDelay, 180);
    const third = delivery(3);
    await queueHandler({ messages: [third] }, env);
    assert.equal(third.acked, true);
    assert.equal(calls, 3);
    assert.equal(sqlite.prepare("SELECT status FROM capture_jobs WHERE job_id = ?").get(jobID).status, "failed");
    assert.equal(sqlite.prepare("SELECT current_sha256 FROM capture_targets WHERE capture_id = ?").get(captureID).current_sha256, null);
    assert.equal(sqlite.prepare("SELECT browser_ms FROM capture_usage WHERE singleton = 1").get().browser_ms, 3 * 45_000,
      "requests without a usage header consume the configured safety reserve");
  } finally {
    sqlite.close();
  }
});

test("unexpected capture exceptions fail without retrying the queue delivery", async () => {
  const sqlite = await freshDatabase();
  try {
    let calls = 0;
    const { env } = environment(sqlite, {
      async quickAction() {
        calls += 1;
        return { ok: true, headers: null };
      },
    });
    const created = await createCapturePlaylist(env);
    const captureID = created.body.captures[0].capture_id;
    const requested = await handleAdminRequest(await request(`/admin/api/captures/${captureID}/run`, {
      method: "POST", body: {},
    }), env);
    const jobID = (await requested.json()).job_id;
    const message = {
      body: { job_id: jobID },
      acked: false,
      retryDelay: null,
      ack() { this.acked = true; },
      retry(options) { this.retryDelay = options.delaySeconds; },
    };

    await queueHandler({ messages: [message] }, env);

    assert.equal(message.acked, true);
    assert.equal(message.retryDelay, null);
    assert.equal(calls, 1);
    assert.equal(sqlite.prepare("SELECT status FROM capture_jobs WHERE job_id = ?").get(jobID).status, "failed");
  } finally {
    sqlite.close();
  }
});

test("daily browser budget defers queued work until the next UTC day", async () => {
  const sqlite = await freshDatabase();
  try {
    let browserCalls = 0;
    const { env, messages } = environment(sqlite, {
      async quickAction() { browserCalls += 1; return new Response(screenshot, { headers: { "Content-Type": "image/png" } }); },
    });
    env.DAILY_BROWSER_BUDGET_MS = "1";
    env.CAPTURE_BUDGET_RESERVE_MS = "2";
    const created = await createCapturePlaylist(env);
    const captureID = created.body.captures[0].capture_id;
    await handleAdminRequest(await request("/admin/api/active-playlist", {
      method: "PUT", body: { playlist_id: "operations", revision: created.body.revision },
    }), env);
    await scheduledHandler({ scheduledTime: Date.now() }, env);
    const message = { body: messages[0], acked: false, ack() { this.acked = true; }, retry() { throw new Error("budget deferral should not retry a queue message"); } };
    await queueHandler({ messages: [message] }, env);

    assert.equal(browserCalls, 0);
    assert.equal(message.acked, true);
    assert.equal(sqlite.prepare("SELECT status FROM capture_jobs").get().status, "deferred");
    assert.ok(sqlite.prepare("SELECT next_due_at FROM capture_targets WHERE capture_id = ?").get(captureID).next_due_at > Date.now());
  } finally {
    sqlite.close();
  }
});

test("retention removes captures older than 30 days and restores their holding asset", async () => {
  const sqlite = await freshDatabase();
  try {
    const { env, objects } = environment(sqlite);
    const created = await createCapturePlaylist(env);
    const captureID = created.body.captures[0].capture_id;
    const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
    const digests = [];
    for (let index = 0; index < 11; index += 1) {
      const jobID = crypto.randomUUID();
      const digest = (index + 1).toString(16).padStart(64, "0");
      digests.push(digest);
      sqlite.prepare("INSERT INTO capture_jobs (job_id, capture_id, status, created_at, finished_at) VALUES (?, ?, 'succeeded', ?, ?)")
        .run(jobID, captureID, old + index, old + index);
      sqlite.prepare("INSERT INTO capture_history (capture_id, job_id, sha256, size, captured_at, browser_ms) VALUES (?, ?, ?, 10, ?, 100)")
        .run(captureID, jobID, digest, old + index);
      objects.set(`assets/${digest}`, screenshot);
    }
    sqlite.prepare("UPDATE capture_targets SET current_sha256 = ?, current_size = ?, last_success_at = ?, next_due_at = ? WHERE capture_id = ?")
      .run(digests.at(-1), screenshot.byteLength, old, Date.now() + 86_400_000, captureID);

    await scheduledHandler({ scheduledTime: Date.now() }, env);

    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM capture_history WHERE capture_id = ?").get(captureID).count, 0);
    assert.equal(sqlite.prepare("SELECT current_sha256 FROM capture_targets WHERE capture_id = ?").get(captureID).current_sha256, null);
    assert.equal(objects.has(`assets/${digests.at(-1)}`), false);
    assert.equal(objects.has(`assets/${created.body.captures[0].placeholder_sha256}`), true);
    assert.equal((await scheduledHandler({ scheduledTime: Date.now() }, env)).cleaned_targets, 0,
      "already-pruned targets must not occupy the cleanup batch again");
  } finally {
    sqlite.close();
  }
});
