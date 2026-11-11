import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { dispatchDueCaptures, enqueueCapture, handleCaptureQueue } from "./capture-workflow.ts";
import worker, { fetchHandler, queueHandler, scheduledHandler } from "./index.ts";
import { handleAdminRequest } from "./admin.ts";

const placeholder = new Uint8Array(await readFile(new URL("../public/admin/capture-pending.png", import.meta.url)));
const screenshot = new Uint8Array(await readFile(new URL("../../../agent/defaults/assets/service-health.png", import.meta.url)));
const originalFetch = globalThis.fetch;

before(() => {
  globalThis.fetch = async () => new Response(null, { status: 200 });
});

after(() => {
  globalThis.fetch = originalFetch;
});

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
      DAILY_BROWSER_BUDGET_MS: "600000",
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
  sqlite.exec(await readFile(new URL("../migrations/0009_capture_skip_approvals.sql", import.meta.url), "utf8"));
  return sqlite;
}

test("a confirmed screenshot skip is bound to one due time and consumed once", async () => {
  const sqlite = await freshDatabase();
  try {
    const { env, messages } = environment(sqlite);
    const created = await createCapturePlaylist(env);
    const captureID = created.body.captures[0].capture_id;
    const initialJob = messages.shift();
    sqlite.prepare("UPDATE capture_jobs SET status = 'succeeded' WHERE job_id = ?").run(initialJob.job_id);
    const dueAt = Date.now() + 5_000;
    const interval = sqlite.prepare("SELECT capture_interval_seconds FROM capture_targets WHERE capture_id = ?")
      .get(captureID).capture_interval_seconds;
    sqlite.prepare(
      "UPDATE capture_targets SET current_sha256 = ?, current_size = 1, last_success_at = ?, next_due_at = ?, failure_count = 0, last_error = NULL WHERE capture_id = ?",
    ).run("a".repeat(64), Date.now(), dueAt, captureID);
    env.ASSETS.put(`assets/${"a".repeat(64)}`, new Uint8Array([1]));
    for (let index = 0; index < 3; index++) {
      const jobID = crypto.randomUUID();
      const capturedAt = Date.now() - index * 1000;
      sqlite.prepare("INSERT INTO capture_jobs (job_id, capture_id, status, attempts, created_at) VALUES (?, ?, 'succeeded', 0, ?)")
        .run(jobID, captureID, capturedAt);
      sqlite.prepare("INSERT INTO capture_history (capture_id, job_id, sha256, size, captured_at, browser_ms) VALUES (?, ?, ?, 1, ?, 100)")
        .run(captureID, jobID, "a".repeat(64), capturedAt);
    }
    sqlite.prepare("INSERT OR IGNORE INTO active_playlist (singleton, playlist_id, revision) VALUES (1, 'operations', ?)")
      .run(created.body.revision);

    const confirmed = await handleAdminRequest(await request(`/admin/api/captures/${captureID.toUpperCase()}/skip-once`, {
      method: "POST", body: { due_at: dueAt },
    }), env);
    assert.equal(confirmed.status, 202, await confirmed.clone().text());
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM capture_skip_approvals WHERE capture_id = ?")
      .get(captureID).count, 1);

    const dispatch = await dispatchDueCaptures(env, dueAt + 1);
    assert.equal(dispatch.enqueued, 0);
    assert.equal(messages.length, 0, "confirmed skip avoids Browser Run queue use");
    assert.equal(sqlite.prepare("SELECT next_due_at FROM capture_targets WHERE capture_id = ?")
      .get(captureID).next_due_at, dueAt + interval * 1000);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM capture_skip_approvals WHERE capture_id = ?")
      .get(captureID).count, 0);
    const skipEvents = sqlite.prepare("SELECT event_type FROM audit_events WHERE subject_id = ? AND event_type LIKE 'capture.skip_once_%' ORDER BY occurred_at").all(captureID);
    assert.deepEqual(skipEvents.map((row) => row.event_type), ["capture.skip_once_confirmed", "capture.skip_once_applied"]);

    await dispatchDueCaptures(env, dueAt + interval * 1000 + 1);
    assert.equal(messages.length, 1, "the following scheduled capture is not skipped");
  } finally {
    sqlite.close();
  }
});

test("manual capture run normalizes uppercase UUIDs before the database lookup", async () => {
  const sqlite = await freshDatabase();
  try {
    const { env } = environment(sqlite);
    const created = await createCapturePlaylist(env);
    const captureID = created.body.captures[0].capture_id;
    const response = await handleAdminRequest(await request(`/admin/api/captures/${captureID.toUpperCase()}/run`, {
      method: "POST", body: {},
    }), env);
    assert.equal(response.status, 202, await response.clone().text());
    assert.equal((await response.json()).status, "queued");
  } finally {
    sqlite.close();
  }
});

test("scheduled recovery restages expired capture leases and dispatches the same job to the capture queue", async () => {
  const sqlite = await freshDatabase();
  try {
    let captureCalls = 0;
    const { env, messages } = environment(sqlite, {
      async quickAction() {
        captureCalls += 1;
        return new Response(screenshot, { headers: { "Content-Type": "image/png" } });
      },
    });
    const created = await createCapturePlaylist(env);
    const original = messages.shift();
    const now = Date.now();
    sqlite.prepare(
      "UPDATE capture_jobs SET status = 'running', attempts = 3, retry_cycle_attempts = 3, started_at = ?, lease_until = ? WHERE job_id = ?",
    ).run(now - 240_000, now - 1, original.job_id);
    const scheduledDueAt = sqlite.prepare("SELECT next_due_at FROM capture_targets WHERE capture_id = ?")
      .get(created.body.captures[0].capture_id).next_due_at;

    await scheduledHandler({ scheduledTime: now }, env);

    const staged = sqlite.prepare(
      "SELECT status, attempts, retry_cycle_attempts, recovery_attempts, retry_after_at, lease_until FROM capture_jobs WHERE job_id = ?",
    ).get(original.job_id);
    assert.deepEqual({ ...staged }, {
      status: "queued", attempts: 3, retry_cycle_attempts: 0, recovery_attempts: 1,
      retry_after_at: now + 60_000, lease_until: null,
    });
    assert.equal(messages.length, 0, "a recovery backoff is durable before queue publication");
    assert.equal(sqlite.prepare("SELECT next_due_at FROM capture_targets WHERE capture_id = ?")
      .get(created.body.captures[0].capture_id).next_due_at, scheduledDueAt);

    await scheduledHandler({ scheduledTime: now + 60_000 }, env);

    assert.deepEqual(messages, [{ job_id: original.job_id }], "recovery returns the original job to the sole capture queue");
    assert.equal(sqlite.prepare("SELECT retry_after_at FROM capture_jobs WHERE job_id = ?").get(original.job_id).retry_after_at, null);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM capture_jobs WHERE capture_id = ? AND status IN ('queued', 'running')")
      .get(created.body.captures[0].capture_id).count, 1);

    let acked = false;
    await queueHandler({ queue: "ribbonfish-captures", messages: [{ body: messages.shift(), ack() { acked = true; }, retry() { throw new Error("unexpected retry"); } }] }, env);
    assert.equal(acked, true);
    assert.equal(captureCalls, 1, "only delivery on the main capture queue executes the capture");
    assert.equal(sqlite.prepare("SELECT status FROM capture_jobs WHERE job_id = ?").get(original.job_id).status, "succeeded");
    assert.equal(sqlite.prepare("SELECT last_error FROM capture_targets WHERE capture_id = ?")
      .get(created.body.captures[0].capture_id).last_error, null);
  } finally {
    sqlite.close();
  }
});

test("dead-letter messages stage bounded recovery and never execute captures", async () => {
  const sqlite = await freshDatabase();
  try {
    const { env, messages } = environment(sqlite);
    const created = await createCapturePlaylist(env);
    const original = messages.shift();
    const now = Date.now();
    sqlite.prepare(
      "UPDATE capture_jobs SET status = 'queued', attempts = 3, retry_cycle_attempts = 3, lease_until = NULL WHERE job_id = ?",
    ).run(original.job_id);
    let acked = false;
    let retried = false;

    await queueHandler({
      queue: "ribbonfish-capture-dead-letter",
      messages: [{ body: original, ack() { acked = true; }, retry() { retried = true; } }],
    }, env);

    assert.equal(acked, true);
    assert.equal(retried, false);
    assert.equal(messages.length, 0, "dead-letter handling stages work instead of running or directly publishing it");
    const retryAt = sqlite.prepare("SELECT retry_after_at FROM capture_jobs WHERE job_id = ?").get(original.job_id).retry_after_at;
    assert.deepEqual({ ...sqlite.prepare(
      "SELECT status, attempts, retry_cycle_attempts, recovery_attempts, retry_after_at FROM capture_jobs WHERE job_id = ?",
    ).get(original.job_id) }, {
      status: "queued", attempts: 3, retry_cycle_attempts: 0, recovery_attempts: 1, retry_after_at: retryAt,
    });
    assert.ok(retryAt >= now + 60_000 && retryAt <= now + 61_000);

    await scheduledHandler({ scheduledTime: retryAt }, env);
    assert.deepEqual(messages, [{ job_id: original.job_id }]);
  } finally {
    sqlite.close();
  }
});

test("a failed recovery publish remains due and is retried on a later scheduled tick", async () => {
  const sqlite = await freshDatabase();
  try {
    const { env, messages } = environment(sqlite);
    const created = await createCapturePlaylist(env);
    const original = messages.shift();
    const now = Date.now();
    const retryAt = now + 60_000;
    sqlite.prepare(
      "UPDATE capture_jobs SET status = 'queued', retry_cycle_attempts = 0, recovery_attempts = 1, retry_after_at = ? WHERE job_id = ?",
    ).run(retryAt, original.job_id);
    env.CAPTURE_QUEUE = { async send() { throw new Error("queue unavailable"); } };

    await scheduledHandler({ scheduledTime: retryAt }, env);

    assert.equal(messages.length, 0);
    assert.equal(sqlite.prepare("SELECT retry_after_at FROM capture_jobs WHERE job_id = ?").get(original.job_id).retry_after_at, retryAt,
      "the D1 outbox remains due when queue publication fails");

    env.CAPTURE_QUEUE = { async send(body) { messages.push(body); } };
    await scheduledHandler({ scheduledTime: retryAt + 60_000 }, env);

    assert.deepEqual(messages, [{ job_id: original.job_id }]);
    assert.equal(sqlite.prepare("SELECT retry_after_at FROM capture_jobs WHERE job_id = ?").get(original.job_id).retry_after_at, null);
  } finally {
    sqlite.close();
  }
});

test("expired jobs stop recovering after the configured bounded recovery cycles", async () => {
  const sqlite = await freshDatabase();
  try {
    const { env, messages } = environment(sqlite);
    const created = await createCapturePlaylist(env);
    const original = messages.shift();
    const now = Date.now();
    const captureID = created.body.captures[0].capture_id;
    sqlite.prepare(
      "UPDATE capture_jobs SET status = 'running', attempts = 9, retry_cycle_attempts = 3, recovery_attempts = 3, started_at = ?, lease_until = ? WHERE job_id = ?",
    ).run(now - 240_000, now - 1, original.job_id);

    await scheduledHandler({ scheduledTime: now }, env);

    assert.equal(sqlite.prepare("SELECT status FROM capture_jobs WHERE job_id = ?").get(original.job_id).status, "failed");
    const target = sqlite.prepare("SELECT last_error, failure_count, next_due_at FROM capture_targets WHERE capture_id = ?").get(captureID);
    assert.match(target.last_error, /recovery limit/i);
    assert.equal(target.failure_count, 1);
    assert.ok(target.next_due_at > now, "the normal schedule remains available after this job exhausts recovery");
  } finally {
    sqlite.close();
  }
});

test("capture interval API updates a stored target, next due time, and audit record", async () => {
  const sqlite = await freshDatabase();
  try {
    const { env } = environment(sqlite);
    const created = await createCapturePlaylist(env);
    const captureID = created.body.captures[0].capture_id;
    sqlite.prepare("UPDATE capture_targets SET last_success_at = ? WHERE capture_id = ?").run(Date.now() - 1000, captureID);
    const response = await handleAdminRequest(await request(`/admin/api/captures/${captureID}`, {
      method: "PATCH", body: { capture_interval_seconds: 21600 },
    }), env);
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { capture_id: captureID, capture_interval_seconds: 21600 });
    const target = sqlite.prepare("SELECT capture_interval_seconds, next_due_at FROM capture_targets WHERE capture_id = ?")
      .get(captureID);
    assert.equal(target.capture_interval_seconds, 21600);
    assert.ok(target.next_due_at >= Date.now() + 21_590_000);
    const event = sqlite.prepare("SELECT event_type, metadata_json FROM audit_events WHERE subject_id = ? ORDER BY occurred_at DESC, rowid DESC LIMIT 1")
      .get(captureID);
    assert.equal(event.event_type, "capture.interval_updated");
    assert.deepEqual(JSON.parse(event.metadata_json), { capture_interval_seconds: 21600 });
  } finally {
    sqlite.close();
  }
});

test("a skip approval for a stale due time cannot suppress a screenshot", async () => {
  const sqlite = await freshDatabase();
  try {
    const { env, messages } = environment(sqlite);
    const created = await createCapturePlaylist(env);
    const captureID = created.body.captures[0].capture_id;
    sqlite.prepare("UPDATE capture_jobs SET status = 'succeeded' WHERE capture_id = ?").run(captureID);
    messages.length = 0;
    const dueAt = Date.now() + 5_000;
    sqlite.prepare("UPDATE capture_targets SET current_sha256 = ?, current_size = 1, last_success_at = ?, next_due_at = ? WHERE capture_id = ?")
      .run("a".repeat(64), Date.now(), dueAt, captureID);
    env.ASSETS.put(`assets/${"a".repeat(64)}`, new Uint8Array([1]));
    const unconfirmed = await handleAdminRequest(await request(`/admin/api/captures/${captureID}/skip-once`, {
      method: "POST", body: { due_at: dueAt },
    }), env);
    assert.equal(unconfirmed.status, 409, "unstable or insufficient screenshot history cannot be approved");
    sqlite.prepare("INSERT INTO capture_skip_approvals (capture_id, due_at, expires_at, actor_id, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(captureID, dueAt - 1, dueAt + 60_000, "admin@example.com", Date.now());
    sqlite.prepare("INSERT OR IGNORE INTO active_playlist (singleton, playlist_id, revision) VALUES (1, 'operations', ?)")
      .run(created.body.revision);

    await dispatchDueCaptures(env, dueAt + 1);
    assert.equal(messages.length, 1, "mismatched due-time approval falls through to normal capture");
  } finally {
    sqlite.close();
  }
});

async function createCapturePlaylist(env, url = "https://example.com/status", ctx, captureInterval = 900) {
  const siteResult = await registerCaptureSite(env, url, captureInterval, ctx);
  if (!siteResult.response.ok) return siteResult;
  const response = await handleAdminRequest(await request("/admin/api/playlists", {
    method: "POST",
    body: {
      id: "operations",
      rotation_interval: "90s",
      assets: [],
      captures: [{ capture_id: siteResult.body.capture_id }],
    },
  }), env, ctx);
  return { response, body: await response.json() };
}

async function registerCaptureSite(env, url, captureInterval = 900, ctx) {
  const response = await handleAdminRequest(await request("/admin/api/capture-sites", {
    method: "POST",
    body: { url, viewport: { width: 1280, height: 720 } },
  }), env, ctx);
  const site = await response.json();
  if (!response.ok) return { response, body: site };
  const review = await handleAdminRequest(await request(`/admin/api/captures/${site.capture_id}`, {
    method: "PATCH", body: { capture_interval_seconds: captureInterval ?? 86400 },
  }), env, ctx);
  return { response: review, body: await review.json() };
}

test("reviewed sites do not schedule captures until a playlist uses them", async () => {
  const sqlite = await freshDatabase();
  try {
    const { env, messages } = environment(sqlite);
    const site = await registerCaptureSite(env, "https://example.com/library-only", 900);
    assert.equal(site.response.status, 200);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM capture_jobs").get().count, 0);
    const result = await scheduledHandler({ scheduledTime: Date.now() }, env);
    assert.equal(result.enqueued, 0);
    assert.equal(messages.length, 0);
  } finally {
    sqlite.close();
  }
});

test("scheduled Worker event waits for a due capture to enter the queue", async () => {
  const sqlite = await freshDatabase();
  let releaseQueue;
  const dispatchGate = new Promise((resolve) => { releaseQueue = resolve; });
  let signalQueueStarted;
  const queueStarted = new Promise((resolve) => { signalQueueStarted = resolve; });
  try {
    const { env, messages } = environment(sqlite);
    const created = await createCapturePlaylist(env);
    const captureID = created.body.captures[0].capture_id;
    await handleAdminRequest(await request("/admin/api/active-playlist", {
      method: "PUT", body: { playlist_id: "operations", revision: created.body.revision },
    }), env);
    messages.length = 0;
    sqlite.prepare("UPDATE capture_jobs SET status = 'succeeded', finished_at = ? WHERE capture_id = ?")
      .run(Date.now(), captureID);
    sqlite.prepare("UPDATE capture_targets SET next_due_at = ? WHERE capture_id = ?")
      .run(Date.now() - 1, captureID);
    env.CAPTURE_QUEUE = { async send(body) {
      signalQueueStarted();
      await dispatchGate;
      messages.push(body);
    } };

    const scheduledTask = worker.scheduled({ scheduledTime: Date.now() }, env);
    await queueStarted;
    assert.equal(typeof scheduledTask?.then, "function", "the scheduled entry point must return its work promise");
    let scheduledTaskSettled = false;
    scheduledTask.then(() => { scheduledTaskSettled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(scheduledTaskSettled, false, "scheduled work must remain pending until queue dispatch completes");

    releaseQueue();
    await scheduledTask;
    assert.equal(messages.length, 1);
    assert.equal(sqlite.prepare("SELECT status FROM capture_jobs WHERE capture_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(captureID).status, "queued");
  } finally {
    releaseQueue?.();
    await new Promise((resolve) => setImmediate(resolve));
    sqlite.close();
  }
});

test("capture site registration returns 201 only for a new site", async () => {
  const sqlite = await freshDatabase();
  try {
    const { env } = environment(sqlite);
    const body = { url: "https://example.com/pending", viewport: { width: 1280, height: 720 } };
    const first = await handleAdminRequest(await request("/admin/api/capture-sites", { method: "POST", body }), env);
    const firstSite = await first.json();
    assert.equal(first.status, 201);
    assert.equal(firstSite.schedule_reviewed, false);

    const duplicate = await handleAdminRequest(await request("/admin/api/capture-sites", { method: "POST", body }), env);
    const duplicateSite = await duplicate.json();
    assert.equal(duplicate.status, 200);
    assert.equal(duplicateSite.capture_id, firstSite.capture_id);
    assert.equal(duplicateSite.schedule_reviewed, false);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM capture_targets").get().count, 1);
  } finally {
    sqlite.close();
  }
});

test("capture readiness selectors are optional, bounded, audited and used for later screenshots", async () => {
  const sqlite = await freshDatabase();
  try {
    const calls = [];
    const { env, messages } = environment(sqlite, {
      async quickAction(action, options) {
        calls.push({ action, options });
        return new Response(screenshot, {
          headers: { "Content-Type": "image/png", "X-Browser-Ms-Used": "1234" },
        });
      },
    });
    const created = await handleAdminRequest(await request("/admin/api/capture-sites", {
      method: "POST", body: { url: "https://example.com/ready", viewport: { width: 1280, height: 720 } },
    }), env);
    const site = await created.json();
    const originalDueAt = sqlite.prepare("SELECT next_due_at FROM capture_targets WHERE capture_id = ?")
      .get(site.capture_id).next_due_at;
    const configured = await handleAdminRequest(await request(`/admin/api/captures/${site.capture_id}/readiness`, {
      method: "PATCH", body: { wait_for_selector: " main .ready " },
    }), env);
    assert.equal(configured.status, 200, await configured.clone().text());
    assert.deepEqual(await configured.json(), { capture_id: site.capture_id, wait_for_selector: "main .ready" });
    assert.equal(messages.length, 0, "readiness configuration does not enqueue captures");

    const invalid = await handleAdminRequest(await request(`/admin/api/captures/${site.capture_id}/readiness`, {
      method: "PATCH", body: { wait_for_selector: "x".repeat(257) },
    }), env);
    assert.equal(invalid.status, 400);
    assert.equal(sqlite.prepare("SELECT wait_for_selector FROM capture_targets WHERE capture_id = ?")
      .get(site.capture_id).wait_for_selector, "main .ready");
    assert.equal(sqlite.prepare("SELECT next_due_at FROM capture_targets WHERE capture_id = ?")
      .get(site.capture_id).next_due_at, originalDueAt, "readiness configuration leaves the scheduled due time unchanged");

    const capture = await enqueueCapture(site.capture_id, env);
    const message = { body: { job_id: capture.job_id }, ack() {}, retry() { throw new Error("unexpected retry"); } };
    await queueHandler({ messages: [message] }, env);
    assert.deepEqual(calls[0].options.waitForSelector, { selector: "main .ready" });

    const overview = await handleAdminRequest(await request("/admin/api/overview"), env);
    assert.equal((await overview.json()).capture_targets[0].wait_for_selector, "main .ready");
    const audit = sqlite.prepare("SELECT event_type, metadata_json FROM audit_events WHERE subject_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(site.capture_id);
    assert.equal(audit.event_type, "capture.readiness_updated");
    assert.deepEqual(JSON.parse(audit.metadata_json), { wait_for_selector: "main .ready" });
  } finally {
    sqlite.close();
  }
});

function addDevice(sqlite) {
  const token = "device-token-for-capture-workflow-test";
  const tokenHash = createHash("sha256").update(token).digest("hex");
  sqlite.prepare("INSERT INTO devices (device_id, token_hash, enabled, created_at) VALUES (?, ?, 1, ?)")
    .run("pi-office", tokenHash, Date.now());
  return token;
}

test("saving a staged webpage queues its first capture and activation serves the captured image", async () => {
  const sqlite = await freshDatabase();
  try {
    const { env, messages } = environment(sqlite, {
      async quickAction() {
        return new Response(screenshot, {
          headers: { "Content-Type": "image/png", "X-Browser-Ms-Used": "1234" },
        });
      },
    });
    const created = await createCapturePlaylist(env, undefined, undefined, null);
    assert.equal(created.response.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.capture_count, 1);
    assert.equal(sqlite.prepare("SELECT capture_interval_seconds FROM capture_targets").get().capture_interval_seconds, 86400);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM playlist_capture_items").get().count, 1);
    assert.deepEqual(sqlite.prepare("SELECT event_type FROM audit_events ORDER BY occurred_at, rowid").all().map((row) => row.event_type), [
      "capture.site_created", "capture.schedule_reviewed", "playlist.revision_created",
    ]);
    assert.equal(messages.length, 1, "saving a playlist should queue the initial capture before activation");
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM active_playlist").get().count, 0);

    const message = {
      body: messages[0],
      acked: false,
      ack() { this.acked = true; },
      retry() { throw new Error("unexpected retry"); },
    };
    await queueHandler({ messages: [message] }, env);
    assert.equal(message.acked, true);
    assert.equal(sqlite.prepare("SELECT status FROM capture_jobs").get().status, "succeeded");
    assert.equal(sqlite.prepare("SELECT result_kind, validator_outcome FROM capture_jobs").get().result_kind, "screenshot");
    assert.equal(sqlite.prepare("SELECT validator_outcome FROM capture_jobs").get().validator_outcome, "no_stored_validator");
    assert.deepEqual({ ...sqlite.prepare("SELECT browser_ms_total, browser_ms_response_header, browser_ms_reserve FROM capture_jobs").get() }, {
      browser_ms_total: 1234, browser_ms_response_header: 1234, browser_ms_reserve: 0,
    });
    assert.deepEqual({ ...sqlite.prepare("SELECT browser_ms, browser_ms_source FROM capture_history").get() }, {
      browser_ms: 1234, browser_ms_source: "response_header",
    });

    const target = sqlite.prepare("SELECT current_sha256, next_due_at FROM capture_targets").get();
    const expected = createHash("sha256").update(screenshot).digest("hex");
    assert.equal(target.current_sha256, expected);

    await scheduledHandler({ scheduledTime: target.next_due_at + 1 }, env);
    assert.equal(messages.length, 1, "a staged target should not keep recurring after its first successful prewarm");

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
    assert.equal(playlist.assets[0].sha256, expected);

    await scheduledHandler({ scheduledTime: target.next_due_at + 1 }, env);
    assert.equal(messages.length, 2, "an activated target should resume its normal recurring captures");
  } finally {
    sqlite.close();
  }
});

test("API dashboard captures bypass Browser Run budgets and reuse the shared playlist asset path", async () => {
  const sqlite = await freshDatabase();
  const summary = JSON.parse(await readFile(new URL("./api-dashboard/fixtures/statuspage-summary.json", import.meta.url), "utf8"));
  const original = globalThis.fetch;
  let failApi = false;
  try {
    const captureTime = Date.now();
    let browserCalls = 0;
    let puts = 0;
    globalThis.fetch = async () => failApi
      ? new Response("unavailable", { status: 503, headers: { "Content-Type": "application/json" } })
      : new Response(JSON.stringify(summary), { headers: { "Content-Type": "application/json" } });
    const { env, messages, objects } = environment(sqlite, { async quickAction() { browserCalls++; throw new Error("browser must not run"); } });
    env.API_STATUS_ALLOWED_HOSTS = "status.example.org";
    env.DAILY_BROWSER_BUDGET_MS = "1";
    let standaloneApiStatusWrites = 0;
    const originalPrepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = (sql) => {
      const statement = originalPrepare(sql);
      if (sql !== "UPDATE capture_targets SET api_status_json = ? WHERE capture_id = ?") return statement;
      return {
        bind(...values) {
          const bound = statement.bind(...values);
          return {
            ...bound,
            async run() {
              standaloneApiStatusWrites++;
              return bound.run();
            },
          };
        },
      };
    };
    const originalPut = env.ASSETS.put;
    env.ASSETS.put = async (...args) => { puts++; return originalPut(...args); };
    const createdResponse = await handleAdminRequest(await request("/admin/api/api-dashboards", {
      method: "POST", body: { name: "Sample operations", capture_interval_seconds: 300, width: 1920, height: 1080,
        sources: [{ id: "source-one", provider: "atlassian-statuspage", display_name: "Sample services", enabled: true, hostname: "status.example.org" }] },
    }), env);
    assert.equal(createdResponse.status, 201, await createdResponse.clone().text());
    const dashboard = await createdResponse.json();
    const first = await enqueueCapture(dashboard.capture_id, env, { now: captureTime });
    const message = { body: { job_id: first.job_id }, ack() {}, retry() { throw new Error("unexpected retry"); } };
    await handleCaptureQueue({ messages: [message] }, env, captureTime);
    assert.equal(sqlite.prepare("SELECT status, error FROM capture_jobs WHERE job_id = ?").get(first.job_id).status, "succeeded", sqlite.prepare("SELECT error FROM capture_jobs WHERE job_id = ?").get(first.job_id).error);
    assert.equal(sqlite.prepare("SELECT status FROM capture_jobs WHERE job_id = ?").get(first.job_id).status, "succeeded");
    assert.equal(sqlite.prepare("SELECT result_kind FROM capture_jobs WHERE job_id = ?").get(first.job_id).result_kind, "screenshot");
    assert.equal(sqlite.prepare("SELECT api_fetch_ms > 0 AS fetched, api_render_ms > 0 AS rendered, api_asset_reused FROM capture_jobs WHERE job_id = ?").get(first.job_id).fetched, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM capture_usage").get().count, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM capture_duration_samples").get().count, 0);
    assert.equal(sqlite.prepare("SELECT SUM(browser_ms) AS total FROM capture_history").get().total, 0);
    assert.equal(browserCalls, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM capture_decisions WHERE capture_id = ?").get(dashboard.capture_id).count, 0);
    const current = sqlite.prepare("SELECT current_sha256, current_size, api_status_json FROM capture_targets WHERE capture_id = ?").get(dashboard.capture_id);
    assert.ok(objects.has(`assets/${current.current_sha256}`));
    assert.equal(JSON.parse(current.api_status_json)[0].freshness, "fresh");
    assert.equal(standaloneApiStatusWrites, 0, "API status cache writes are batched with capture finalization");
    const firstPutCount = puts;

    const second = await enqueueCapture(dashboard.capture_id, env, { now: captureTime });
    await handleCaptureQueue({ messages: [{ body: { job_id: second.job_id }, ack() {}, retry() { throw new Error("unexpected retry"); } }] }, env, captureTime);
    assert.equal(sqlite.prepare("SELECT api_asset_reused FROM capture_jobs WHERE job_id = ?").get(second.job_id).api_asset_reused, 1);
    assert.equal(sqlite.prepare("SELECT api_render_ms FROM capture_jobs WHERE job_id = ?").get(second.job_id).api_render_ms, 0, "unchanged visible status skips rasterization");
    assert.equal(puts, firstPutCount, "unchanged dashboard content reuses its current R2 asset");

    const dashboardList = await handleAdminRequest(await request("/admin/api/api-dashboards"), env);
    const listed = await dashboardList.json();
    assert.equal(listed[0].capture_id, dashboard.capture_id);
    assert.equal(listed[0].sources[0].freshness, "fresh");
    assert.deepEqual({
      samples: listed[0].recent_metrics.sample_count,
      successes: listed[0].recent_metrics.successes,
      failures: listed[0].recent_metrics.failures,
      requests: listed[0].recent_metrics.upstream_requests,
      contentHashMatches: listed[0].recent_metrics.content_hash_matches,
      renders: listed[0].recent_metrics.render_operations,
    }, { samples: 2, successes: 2, failures: 0, requests: 2, contentHashMatches: 1, renders: 1 });
    const successfulJobMetrics = { ...sqlite.prepare("SELECT api_total_ms > 0 AS total_measured, api_request_count, api_response_bytes > 0 AS bytes_measured, api_source_count, api_outcome FROM capture_jobs WHERE capture_id = ? AND status = 'succeeded' ORDER BY created_at DESC LIMIT 1").get(dashboard.capture_id) };
    assert.deepEqual(successfulJobMetrics, { total_measured: 1, api_request_count: 1, bytes_measured: 1, api_source_count: 1, api_outcome: "complete" });
    const updated = await handleAdminRequest(await request(`/admin/api/api-dashboards/${dashboard.capture_id}`, {
      method: "PATCH", body: { capture_interval_seconds: 60 },
    }), env);
    assert.equal(updated.status, 200);
    assert.equal(sqlite.prepare("SELECT capture_interval_seconds FROM capture_targets WHERE capture_id = ?").get(dashboard.capture_id).capture_interval_seconds, 60);

    sqlite.prepare("INSERT INTO playlists (playlist_id, revision, rotation_interval, created_at) VALUES ('api-playlist', 'revision-1', '90s', 1)").run();
    sqlite.prepare("INSERT INTO playlist_capture_items (playlist_id, revision, position, capture_id) VALUES ('api-playlist', 'revision-1', 0, ?)").run(dashboard.capture_id);
    sqlite.prepare("INSERT INTO active_playlist (singleton, playlist_id, revision) VALUES (1, 'api-playlist', 'revision-1')").run();
    const deviceToken = addDevice(sqlite);
    const playlistResponse = await fetchHandler(new Request("https://worker.test/v2/playlist", {
      headers: { "X-Ribbonfish-Device-ID": "pi-office", Authorization: `Bearer ${deviceToken}` },
    }), env);
    assert.equal(playlistResponse.status, 200);
    const playlist = await playlistResponse.json();
    assert.equal(playlist.assets[0].sha256, current.current_sha256);

    failApi = true;
    const failed = await enqueueCapture(dashboard.capture_id, env, { now: captureTime });
    let failureAcked = false;
    await handleCaptureQueue({ messages: [{ body: { job_id: failed.job_id }, ack() { failureAcked = true; }, retry() { throw new Error("retries are staged in D1"); } }] }, env, captureTime);
    assert.equal(failureAcked, true);
    assert.equal(sqlite.prepare("SELECT status FROM capture_jobs WHERE job_id = ?").get(failed.job_id).status, "queued");
    assert.equal(sqlite.prepare("SELECT retry_after_at FROM capture_jobs WHERE job_id = ?").get(failed.job_id).retry_after_at, captureTime + 60_000);
    assert.deepEqual({ ...sqlite.prepare("SELECT api_failed_request_count, api_outcome FROM capture_jobs WHERE job_id = ?").get(failed.job_id) }, { api_failed_request_count: 1, api_outcome: "all_failed" });
    assert.equal(sqlite.prepare("SELECT current_sha256, last_success_at FROM capture_targets WHERE capture_id = ?").get(dashboard.capture_id).current_sha256, current.current_sha256);
    assert.equal(JSON.parse(sqlite.prepare("SELECT api_status_json FROM capture_targets WHERE capture_id = ?").get(dashboard.capture_id).api_status_json)[0].freshness, "unavailable");

    sqlite.prepare("UPDATE capture_jobs SET retry_after_at = NULL WHERE capture_id = ? AND status = 'queued'").run(dashboard.capture_id);
    sqlite.prepare("UPDATE capture_targets SET api_sources_json = ? WHERE capture_id = ?").run(JSON.stringify({
      width: 1920, height: 1080,
      sources: [{ id: "source-one", provider: "atlassian-statuspage", display_name: "Sample services", enabled: true, hostname: "private.internal" }],
    }), dashboard.capture_id);
    const invalidConfig = await enqueueCapture(dashboard.capture_id, env, { now: captureTime });
    let invalidConfigRetried = false;
    let invalidConfigAcked = false;
    await handleCaptureQueue({ messages: [{ body: { job_id: invalidConfig.job_id }, ack() { invalidConfigAcked = true; }, retry() { invalidConfigRetried = true; } }] }, env, captureTime);
    assert.equal(invalidConfigRetried, false, "permanent source configuration failures should not be retried");
    assert.equal(invalidConfigAcked, true);
    assert.equal(sqlite.prepare("SELECT status FROM capture_jobs WHERE job_id = ?").get(invalidConfig.job_id).status, "failed");
    assert.equal(browserCalls, 0);
  } finally {
    globalThis.fetch = original;
    sqlite.close();
  }
});

test("API dashboards can be added to playlists without browser capture host allowlist validation", async () => {
  const sqlite = await freshDatabase();
  try {
    const { env } = environment(sqlite);
    env.API_STATUS_ALLOWED_HOSTS = "status.example.org";
    const dashboardResponse = await handleAdminRequest(await request("/admin/api/api-dashboards", {
      method: "POST", body: { name: "Sample operations", capture_interval_seconds: 300, width: 1920, height: 1080,
        sources: [{ id: "source-one", provider: "atlassian-statuspage", display_name: "Sample services", enabled: true, hostname: "status.example.org" }] },
    }), env);
    assert.equal(dashboardResponse.status, 201, await dashboardResponse.clone().text());
    const dashboard = await dashboardResponse.json();

    const response = await handleAdminRequest(await request("/admin/api/playlists", {
      method: "POST", body: { id: "dashboard-playlist", rotation_interval: "90s", assets: [], captures: [{ capture_id: dashboard.capture_id }] },
    }), env);

    assert.equal(response.status, 201, await response.clone().text());
    const playlist = await response.json();
    assert.equal(playlist.capture_count, 1);
    assert.equal(sqlite.prepare("SELECT capture_id FROM playlist_capture_items WHERE playlist_id = ? AND revision = ?")
      .get("dashboard-playlist", playlist.revision).capture_id, dashboard.capture_id);
  } finally {
    sqlite.close();
  }
});

test("API dashboard list flags stale captures and exposes the durable recovery schedule", async () => {
  const sqlite = await freshDatabase();
  try {
    const { env } = environment(sqlite);
    env.API_STATUS_ALLOWED_HOSTS = "status.example.org";
    const response = await handleAdminRequest(await request("/admin/api/api-dashboards", {
      method: "POST", body: { name: "Stale dashboard", capture_interval_seconds: 300, width: 1920, height: 1080,
        sources: [{ id: "source-one", provider: "atlassian-statuspage", display_name: "Sample services", enabled: true, hostname: "status.example.org" }] },
    }), env);
    assert.equal(response.status, 201, await response.clone().text());
    const dashboard = await response.json();
    const now = Date.now();
    sqlite.prepare("UPDATE capture_targets SET last_success_at = ?, next_due_at = ?, last_error = ? WHERE capture_id = ?")
      .run(now - 60 * 60_000, now - 30 * 60_000, "Capture lease expired before the job finished.", dashboard.capture_id);
    sqlite.prepare(
      "INSERT INTO capture_jobs (job_id, capture_id, status, attempts, recovery_attempts, retry_after_at, created_at) VALUES (?, ?, 'queued', 4, 2, ?, ?)",
    ).run(crypto.randomUUID(), dashboard.capture_id, now + 60_000, now);

    const listed = await handleAdminRequest(await request("/admin/api/api-dashboards"), env);
    const [result] = await listed.json();

    assert.equal(result.stale, true);
    assert.equal(result.recovery_attempts, 2);
    assert.equal(result.retry_after_at, now + 60_000);
  } finally {
    sqlite.close();
  }
});

test("playlist saves schedule capture dispatch after the response through waitUntil", async () => {
  const sqlite = await freshDatabase();
  try {
    const { env, messages } = environment(sqlite);
    let releaseQueue;
    const queueCanSend = new Promise((resolve) => { releaseQueue = resolve; });
    env.CAPTURE_QUEUE = { async send(body) { await queueCanSend; messages.push(body); } };
    const background = [];
    const ctx = { waitUntil(promise) { background.push(promise); } };

    const created = await createCapturePlaylist(env, "https://example.com/status", ctx);

    assert.equal(created.response.status, 201);
    assert.equal(messages.length, 0, "the request should not wait for queue dispatch");
    assert.equal(background.length, 1);
    releaseQueue();
    await Promise.all(background);
    assert.equal(messages.length, 1);
  } finally {
    sqlite.close();
  }
});

test("staged first captures retry on the scheduled dispatcher after a queue publish failure", async () => {
  const sqlite = await freshDatabase();
  try {
    const { env, messages } = environment(sqlite);
    env.CAPTURE_QUEUE = { async send() { throw new Error("queue unavailable"); } };

    const created = await createCapturePlaylist(env);

    assert.equal(created.response.status, 201, "a committed playlist remains saved if queue publishing fails");
    assert.equal(sqlite.prepare("SELECT status FROM capture_jobs").get().status, "failed");
    assert.equal(messages.length, 0);

    env.CAPTURE_QUEUE = { async send(body) { messages.push(body); } };
    const dispatch = await scheduledHandler({ scheduledTime: Date.now() + 1 }, env);

    assert.equal(dispatch.enqueued, 1);
    assert.equal(messages.length, 1);
    assert.equal(sqlite.prepare("SELECT status FROM capture_jobs ORDER BY created_at DESC LIMIT 1").get().status, "queued");
  } finally {
    sqlite.close();
  }
});

test("initial capture dispatch respects the pending limit and drains staged work later", async () => {
  const sqlite = await freshDatabase();
  try {
    const { env, messages } = environment(sqlite, {
      async quickAction() {
        return new Response(screenshot, { headers: { "Content-Type": "image/png" } });
      },
    });
    env.CAPTURE_MAX_PENDING = "1";
    const one = await registerCaptureSite(env, "https://example.com/one", 900);
    const two = await registerCaptureSite(env, "https://example.com/two", 900);
    const response = await handleAdminRequest(await request("/admin/api/playlists", {
      method: "POST", body: { id: "operations", rotation_interval: "90s", assets: [],
        captures: [{ capture_id: one.body.capture_id }, { capture_id: two.body.capture_id }] },
    }), env);
    const created = await response.json();
    assert.equal(response.status, 201);
    assert.equal(messages.length, 1);

    const firstMessage = { body: messages[0], ack() {}, retry() { throw new Error("unexpected retry"); } };
    await queueHandler({ messages: [firstMessage] }, env);
    const dispatch = await scheduledHandler({ scheduledTime: Date.now() }, env);

    assert.equal(dispatch.enqueued, 1);
    assert.equal(messages.length, 2);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM capture_jobs WHERE status IN ('queued', 'running')").get().count, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM playlist_capture_items WHERE playlist_id = ? AND revision = ?")
      .get("operations", created.revision).count, 2);
  } finally {
    sqlite.close();
  }
});

test("saving another revision reuses a recent screenshot without queueing a duplicate capture", async () => {
  const sqlite = await freshDatabase();
  try {
    const { env, messages } = environment(sqlite, {
      async quickAction() {
        return new Response(screenshot, { headers: { "Content-Type": "image/png" } });
      },
    });
    const first = await createCapturePlaylist(env);
    const message = { body: messages[0], ack() {}, retry() { throw new Error("unexpected retry"); } };
    await queueHandler({ messages: [message] }, env);
    env.CAPTURE_ALLOWED_HOSTS = "";

    const secondResponse = await handleAdminRequest(await request("/admin/api/playlists", {
      method: "POST",
      body: {
        id: "operations-copy",
        rotation_interval: "90s",
        assets: [],
        captures: [{ capture_id: first.body.captures[0].capture_id }],
      },
    }), env);

    assert.equal(secondResponse.status, 201, await secondResponse.clone().text());
    assert.equal(messages.length, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM capture_jobs").get().count, 1);
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
    const durationSample = sqlite.prepare(
      "SELECT attempt, browser_ms, browser_ms_source, reserve_ms, browser_run_elapsed_ms, capture_elapsed_ms, outcome, readiness_mode, readiness_selector " +
      "FROM capture_duration_samples WHERE capture_id = ?",
    ).get(created.body.captures[0].capture_id);
    assert.equal(durationSample.attempt, 1);
    assert.equal(durationSample.browser_ms, 1234);
    assert.equal(durationSample.browser_ms_source, "response_header");
    assert.equal(durationSample.reserve_ms, 60_000);
    assert.ok(durationSample.browser_run_elapsed_ms >= 0);
    assert.ok(durationSample.capture_elapsed_ms >= durationSample.browser_run_elapsed_ms);
    assert.equal(durationSample.outcome, "succeeded");
    assert.equal(durationSample.readiness_mode, "domcontentloaded");
    assert.equal(durationSample.readiness_selector, null);

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

test("reserve-based Browser Run accounting is explicitly distinguishable from measured duration", async () => {
  const sqlite = await freshDatabase();
  try {
    const { env, messages } = environment(sqlite, {
      async quickAction() { return new Response(screenshot, { headers: { "Content-Type": "image/png" } }); },
    });
    const created = await createCapturePlaylist(env);
    const message = { body: messages[0], ack() {}, retry() { throw new Error("unexpected retry"); } };
    await queueHandler({ messages: [message] }, env);
    assert.equal(sqlite.prepare("SELECT browser_ms, browser_ms_source FROM capture_history").get().browser_ms, 60_000);
    assert.equal(sqlite.prepare("SELECT browser_ms_source FROM capture_history").get().browser_ms_source, "reserve");
    assert.equal(sqlite.prepare("SELECT browser_ms FROM capture_usage WHERE singleton = 1").get().browser_ms, 60_000);
    assert.deepEqual({ ...sqlite.prepare("SELECT browser_ms_total, browser_ms_response_header, browser_ms_reserve FROM capture_jobs").get() }, {
      browser_ms_total: 60_000, browser_ms_response_header: 0, browser_ms_reserve: 60_000,
    });
    const overview = await handleAdminRequest(await request("/admin/api/overview"), env);
    const stats = (await overview.json()).capture_efficiency;
    assert.equal(stats.daily_usage.budget_ms, 600_000);
    assert.equal(stats.daily_usage.accounted_ms, 60_000);
    assert.equal(stats.last_30_days.browser_ms_sources.reserve, 1);
    assert.equal(stats.last_30_days.browser_run_ms.reserve, 60_000);
    assert.equal(stats.last_30_days.browser_run_ms.unclassified_jobs, 0);
    assert.equal(created.response.status, 201);
  } finally {
    sqlite.close();
  }
});

test("unchanged HTTP validators skip Browser Run for any recorded capture host", async () => {
  const sqlite = await freshDatabase();
  const originalFetch = globalThis.fetch;
  try {
    let browserCalls = 0;
    let probeRequest;
    const { env, objects } = environment(sqlite, {
      async quickAction() { browserCalls++; throw new Error("Browser Run should be skipped"); },
    });
    env.CAPTURE_ALLOWED_HOSTS = "example.com,other.example";
    env.DAILY_BROWSER_BUDGET_MS = "1";
    const created = await createCapturePlaylist(env, "https://other.example/status");
    const captureID = created.body.captures[0].capture_id;
    const sha256 = createHash("sha256").update(screenshot).digest("hex");
    objects.set(`assets/${sha256}`, screenshot);
    sqlite.prepare(
      "UPDATE capture_targets SET current_sha256 = ?, current_size = ?, last_success_at = ?, validator_etag = ?, validator_last_modified = ? WHERE capture_id = ?",
    ).run(sha256, screenshot.byteLength, Date.now() - 60_000, '"source-v1"', "Wed, 21 Oct 2015 07:28:00 GMT", captureID);
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
    assert.equal(probeRequest.url, "https://other.example/status");
    assert.equal(probeRequest.options.method, "HEAD");
    assert.equal(probeRequest.options.headers.get("If-None-Match"), '"source-v1"');
    assert.equal(probeRequest.options.headers.get("If-Modified-Since"), "Wed, 21 Oct 2015 07:28:00 GMT");
    assert.equal(browserCalls, 0);
    assert.deepEqual({ ...sqlite.prepare("SELECT status, result_kind, validator_outcome FROM capture_jobs WHERE job_id = ?").get(jobID) }, {
      status: "succeeded", result_kind: "validator_unchanged", validator_outcome: "unchanged",
    });
    const preserved = sqlite.prepare("SELECT current_sha256, validator_etag FROM capture_targets WHERE capture_id = ?").get(captureID);
    assert.equal(preserved.current_sha256, sha256);
    assert.equal(preserved.validator_etag, '"source-v1"');
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM capture_history").get().count, 0);
    assert.equal(sqlite.prepare("SELECT browser_ms FROM capture_usage WHERE singleton = 1").get() ?? null, null,
      "a validator hit does not consume Browser Run budget");
    const overview = await handleAdminRequest(await request("/admin/api/overview"), env);
    const efficiency = (await overview.json()).capture_efficiency;
    assert.equal(efficiency.last_30_days.validator_unchanged, 1);
    assert.equal(efficiency.last_30_days.successful_screenshots, 0);
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.close();
  }
});

test("a changed validator is audited and falls through to a fresh Browser Run screenshot", async () => {
  const sqlite = await freshDatabase();
  const originalFetch = globalThis.fetch;
  try {
    let browserCalls = 0;
    const { env, messages, objects } = environment(sqlite, {
      async quickAction() {
        browserCalls += 1;
        return new Response(screenshot, { headers: { "Content-Type": "image/png", "X-Browser-Ms-Used": "2500" } });
      },
    });
    const created = await createCapturePlaylist(env);
    const id = created.body.captures[0].capture_id;
    const digest = createHash("sha256").update(screenshot).digest("hex");
    objects.set(`assets/${digest}`, screenshot);
    sqlite.prepare("UPDATE capture_targets SET current_sha256 = ?, current_size = ?, last_success_at = ?, validator_etag = ? WHERE capture_id = ?")
      .run(digest, screenshot.byteLength, Date.now() - 60_000, '"source-v1"', id);
    globalThis.fetch = async () => new Response(null, { status: 200, headers: { ETag: '"source-v2"' } });

    await queueHandler({ messages: [{ body: messages[0], ack() {}, retry() { throw new Error("unexpected retry"); } }] }, env);

    assert.equal(browserCalls, 1);
    const job = sqlite.prepare("SELECT status, result_kind, validator_outcome FROM capture_jobs").get();
    assert.deepEqual({ ...job }, { status: "succeeded", result_kind: "screenshot", validator_outcome: "changed" });
    assert.equal(sqlite.prepare("SELECT validator_etag FROM capture_targets WHERE capture_id = ?").get(id).validator_etag, '"source-v2"');
    assert.equal(sqlite.prepare("SELECT browser_ms_source FROM capture_history").get().browser_ms_source, "response_header");
  } finally {
    globalThis.fetch = originalFetch;
    sqlite.close();
  }
});

test("unavailable validator probes are audited and cannot replace trusted validators", async () => {
  const sqlite = await freshDatabase();
  const originalFetch = globalThis.fetch;
  try {
    let browserCalls = 0;
    const { env, messages } = environment(sqlite, {
      async quickAction() {
        browserCalls += 1;
        return new Response(screenshot, { headers: { "Content-Type": "image/png", "X-Browser-Ms-Used": "2500" } });
      },
    });
    const created = await createCapturePlaylist(env);
    const id = created.body.captures[0].capture_id;
    sqlite.prepare("UPDATE capture_targets SET validator_etag = ? WHERE capture_id = ?").run('"source-v1"', id);
    globalThis.fetch = async () => new Response(null, { status: 503, headers: { ETag: '"bad-response"' } });

    await queueHandler({ messages: [{ body: messages[0], ack() {}, retry() { throw new Error("unexpected retry"); } }] }, env);

    assert.equal(browserCalls, 1);
    assert.equal(sqlite.prepare("SELECT validator_outcome FROM capture_jobs").get().validator_outcome, "unavailable");
    assert.equal(sqlite.prepare("SELECT validator_etag FROM capture_targets WHERE capture_id = ?").get(id).validator_etag, '"source-v1"');
    const overview = await handleAdminRequest(await request("/admin/api/overview"), env);
    assert.equal((await overview.json()).capture_efficiency.last_30_days.validator_outcomes.unavailable, 1);
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
    sqlite.prepare("DELETE FROM capture_jobs WHERE capture_id = ?").run(captureID);
    messages.length = 0;
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
    sqlite.prepare("DELETE FROM capture_jobs WHERE capture_id = ?").run(captureID);
    messages.length = 0;
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

test("removing a capture site disables future captures and preserves saved playlist snapshots", async () => {
  const sqlite = await freshDatabase();
  try {
    const { env } = environment(sqlite);
    const created = await createCapturePlaylist(env);
    assert.equal(created.response.status, 201);
    const captureID = created.body.captures[0].capture_id;

    const removed = await handleAdminRequest(await request(`/admin/api/captures/${captureID}`, {
      method: "DELETE",
    }), env);

    assert.equal(removed.status, 200, await removed.clone().text());
    assert.deepEqual(await removed.json(), { capture_id: captureID, removed: true });
    assert.equal(sqlite.prepare("SELECT enabled FROM capture_targets WHERE capture_id = ?").get(captureID).enabled, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM playlist_capture_items WHERE capture_id = ?").get(captureID).count, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM capture_jobs WHERE capture_id = ? AND status IN ('queued', 'running')").get(captureID).count, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'capture.site_removed' AND subject_id = ?").get(captureID).count, 1);

    const repeatedRemoval = await handleAdminRequest(await request(`/admin/api/captures/${captureID}`, {
      method: "DELETE",
    }), env);
    assert.equal(repeatedRemoval.status, 200);
    assert.deepEqual(await repeatedRemoval.json(), { capture_id: captureID, removed: false });
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'capture.site_removed' AND subject_id = ?").get(captureID).count, 1);

    const overview = await handleAdminRequest(await request("/admin/api/overview"), env);
    assert.deepEqual((await overview.json()).capture_targets, []);
    const run = await handleAdminRequest(await request(`/admin/api/captures/${captureID}/run`, {
      method: "POST", body: {},
    }), env);
    assert.equal(run.status, 404);
  } finally {
    sqlite.close();
  }
});

test("registering a removed capture site restores it with its existing schedule", async () => {
  const sqlite = await freshDatabase();
  try {
    const { env } = environment(sqlite);
    const created = await registerCaptureSite(env, "https://example.com/removed", 3600);
    const captureID = created.body.capture_id;
    await handleAdminRequest(await request(`/admin/api/captures/${captureID}`, { method: "DELETE" }), env);

    const restored = await handleAdminRequest(await request("/admin/api/capture-sites", {
      method: "POST",
      body: { url: "https://example.com/removed", viewport: { width: 1280, height: 720 } },
    }), env);

    assert.equal(restored.status, 200, await restored.clone().text());
    assert.equal((await restored.json()).capture_id, captureID);
    assert.equal(sqlite.prepare("SELECT enabled, capture_interval_seconds FROM capture_targets WHERE capture_id = ?").get(captureID).enabled, 1);
    assert.equal(sqlite.prepare("SELECT capture_interval_seconds FROM capture_targets WHERE capture_id = ?").get(captureID).capture_interval_seconds, 3600);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'capture.site_restored' AND subject_id = ?").get(captureID).count, 1);
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
    const delivery = () => ({
      body: { job_id: jobID },
      acked: false,
      ack() { this.acked = true; },
      retry() { throw new Error("application retries are scheduled through D1"); },
    });

    messages.length = 0;
    let now = Date.now();
    for (let attempt = 1; attempt <= 3; attempt++) {
      const current = delivery();
      await handleCaptureQueue({ messages: [current] }, env, now);
      assert.equal(current.acked, true);
      if (attempt < 3) {
        const retryAt = sqlite.prepare("SELECT retry_after_at FROM capture_jobs WHERE job_id = ?").get(jobID).retry_after_at;
        assert.equal(retryAt, now + (attempt === 1 ? 60_000 : 180_000));
        now = retryAt;
        await scheduledHandler({ scheduledTime: now }, env);
        assert.deepEqual(messages, [{ job_id: jobID }], "the scheduled dispatcher republishes a durable retry");
        messages.length = 0;
      }
    }
    assert.equal(calls, 3);
    assert.equal(sqlite.prepare("SELECT status FROM capture_jobs WHERE job_id = ?").get(jobID).status, "failed");
    assert.equal(sqlite.prepare("SELECT current_sha256 FROM capture_targets WHERE capture_id = ?").get(captureID).current_sha256, null);
    assert.equal(sqlite.prepare("SELECT browser_ms FROM capture_usage WHERE singleton = 1").get().browser_ms, 3 * 60_000,
      "requests without a usage header consume the configured safety reserve");
    assert.deepEqual({ ...sqlite.prepare("SELECT browser_ms_total, browser_ms_response_header, browser_ms_reserve FROM capture_jobs WHERE job_id = ?").get(jobID) }, {
      browser_ms_total: 3 * 60_000, browser_ms_response_header: 0, browser_ms_reserve: 3 * 60_000,
    }, "the per-job audit includes every retry, not only the last attempt");
    const failedSamples = sqlite.prepare(
      "SELECT attempt, browser_ms, browser_ms_source, outcome, readiness_mode, readiness_selector FROM capture_duration_samples WHERE job_id = ? ORDER BY attempt",
    ).all(jobID);
    assert.deepEqual(failedSamples.map(({ attempt, browser_ms, browser_ms_source, outcome, readiness_mode, readiness_selector }) =>
      ({ attempt, browser_ms, browser_ms_source, outcome, readiness_mode, readiness_selector })), [
      { attempt: 1, browser_ms: 60_000, browser_ms_source: "reserve", outcome: "failed", readiness_mode: "domcontentloaded", readiness_selector: null },
      { attempt: 2, browser_ms: 60_000, browser_ms_source: "reserve", outcome: "failed", readiness_mode: "domcontentloaded", readiness_selector: null },
      { attempt: 3, browser_ms: 60_000, browser_ms_source: "reserve", outcome: "failed", readiness_mode: "domcontentloaded", readiness_selector: null },
    ]);
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
      ack() { this.acked = true; },
      retry() { throw new Error("unexpected queue retry"); },
    };

    await queueHandler({ messages: [message] }, env);

    assert.equal(message.acked, true);
    assert.equal(calls, 1);
    assert.equal(sqlite.prepare("SELECT status FROM capture_jobs WHERE job_id = ?").get(jobID).status, "failed");
    assert.deepEqual({ ...sqlite.prepare("SELECT browser_ms_total, browser_ms_response_header, browser_ms_reserve FROM capture_jobs WHERE job_id = ?").get(jobID) }, {
      browser_ms_total: 60_000, browser_ms_response_header: 0, browser_ms_reserve: 60_000,
    });
    assert.equal(sqlite.prepare("SELECT browser_ms FROM capture_usage WHERE singleton = 1").get().browser_ms, 60_000);
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

test('background screenshot assessment records a bounded shadow decision once per due time without changing the schedule', async () => {
  const { assessUpcomingCaptures } = await import('./capture-intelligence.ts');
  const sqlite = await freshDatabase();
  try {
    sqlite.exec(await readFile(new URL('../migrations/0010_capture_decisions.sql', import.meta.url), 'utf8'));
    const { env, messages } = environment(sqlite);
    const created = await createCapturePlaylist(env);
    const id = created.body.captures[0].capture_id;
    sqlite.prepare("UPDATE capture_jobs SET status = 'succeeded' WHERE job_id = ?").run(messages.shift().job_id);
    const now = Date.now();
    const due = now + 60_000;
    sqlite.prepare("UPDATE capture_targets SET current_sha256 = ?, current_size = 1, last_success_at = ?, next_due_at = ? WHERE capture_id = ?")
      .run('a'.repeat(64), now, due, id);
    await env.ASSETS.put(`assets/${'a'.repeat(64)}`, new Uint8Array([1]));
    for (let index = 0; index < 25; index++) {
      const sampleJobID = crypto.randomUUID();
      const sampledAt = now - index * 1000;
      sqlite.prepare("INSERT INTO capture_jobs (job_id, capture_id, status, attempts, created_at) VALUES (?, ?, 'succeeded', 1, ?)")
        .run(sampleJobID, id, sampledAt);
      sqlite.prepare(
        "INSERT INTO capture_duration_samples (sample_id, capture_id, job_id, attempt, sampled_at, browser_ms, browser_ms_source, reserve_ms, browser_run_elapsed_ms, capture_elapsed_ms, outcome, readiness_mode) " +
        "VALUES (?, ?, ?, 1, ?, ?, ?, 60000, 20000, 22000, 'succeeded', 'domcontentloaded')",
      ).run(crypto.randomUUID(), id, sampleJobID, sampledAt, index < 20 ? 10_000 + index * 500 : 60_000,
        index < 20 ? 'response_header' : 'reserve');
    }
    sqlite.prepare("INSERT INTO active_playlist (singleton, playlist_id, revision) VALUES (1, 'operations', ?)").run(created.body.revision);
    let calls = 0;
    let assessedState;
    let assessedQuestions;
    const decide = async (_env, input) => {
      calls++;
      assessedState = JSON.parse(input.state);
      assessedQuestions = input.questions;
      return { model: 'test-model', answers: {
        duration_review: { choice: 'review_overestimate', confidence: 0.95 },
        recommendation: { choice: 'capture_now' }, risk: { score: 1 },
      } };
    };
    await assessUpcomingCaptures(env, now, decide);
    await assessUpcomingCaptures(env, now, decide);
    assert.equal(calls, 1);
    assert.equal(sqlite.prepare('SELECT action FROM capture_decisions').get().action, 'capture');
    const storedState = sqlite.prepare('SELECT state_json FROM capture_decisions').get().state_json;
    assert.equal(typeof storedState, 'string');
    const parsedState = JSON.parse(storedState);
    assert.equal(typeof parsedState, 'object');
    assert.equal(parsedState.screenshot_age_seconds, 0);
    assert.equal(parsedState.seconds_until_due, 60);
    assert.equal(assessedState.capture_duration.total_samples, 25);
    assert.equal(assessedState.capture_duration.measured_sample_count, 20);
    assert.equal(assessedState.capture_duration.measured_p90_ms, 18_500);
    assert.equal(assessedState.capture_duration.configured_reserve_ms, 60_000);
    assert.equal(assessedState.capture_duration.reserve_review, 'possible_overestimate');
    assert.deepEqual(Object.keys(assessedQuestions), ['duration_review', 'recommendation', 'risk']);

    const response = await handleAdminRequest(await request('/admin/api/capture-decisions'), env);
    assert.equal(response.status, 200);
    const decisions = await response.json();
    assert.equal(decisions[0].capture_id, id);
    assert.equal(decisions[0].action, 'capture');
    assert.equal(decisions[0].duration_review, 'review_overestimate');
    assert.equal(decisions[0].model, undefined);
    assert.equal(decisions[0].state_json, undefined);
    const overviewResponse = await handleAdminRequest(await request('/admin/api/overview'), env);
    const jevMetrics = (await overviewResponse.json()).capture_efficiency.last_30_days;
    assert.equal(jevMetrics.jev_shadow_assessments, 1);
    assert.equal(jevMetrics.jev_candidate_deferrals, 0);
    assert.equal(sqlite.prepare('SELECT next_due_at FROM capture_targets WHERE capture_id = ?').get(id).next_due_at, due);
  } finally { sqlite.close(); }
});

test('shadow deferral suggestions are evaluated against the scheduled screenshot outcome', async () => {
  const { assessUpcomingCaptures } = await import('./capture-intelligence.ts');
  const sqlite = await freshDatabase();
  try {
    const { env, messages } = environment(sqlite, {
      async quickAction() {
        return new Response(screenshot, { headers: { "Content-Type": "image/png", "X-Browser-Ms-Used": "2500" } });
      },
    });
    const created = await createCapturePlaylist(env);
    const id = created.body.captures[0].capture_id;
    const initialJob = messages.shift();
    sqlite.prepare("UPDATE capture_jobs SET status = 'succeeded' WHERE job_id = ?").run(initialJob.job_id);
    const now = Date.now();
    const dueAt = now + 1_000;
    const interval = sqlite.prepare("SELECT capture_interval_seconds FROM capture_targets WHERE capture_id = ?").get(id).capture_interval_seconds;
    const previousHash = "a".repeat(64);
    sqlite.prepare("UPDATE capture_targets SET current_sha256 = ?, current_size = 1, last_success_at = ?, next_due_at = ? WHERE capture_id = ?")
      .run(previousHash, now - 1_000, dueAt, id);
    await env.ASSETS.put(`assets/${previousHash}`, new Uint8Array([1]));
    for (let index = 0; index < 3; index++) {
      const jobID = crypto.randomUUID();
      sqlite.prepare("INSERT INTO capture_jobs (job_id, capture_id, status, attempts, created_at) VALUES (?, ?, 'succeeded', 0, ?)")
        .run(jobID, id, now - index - 1);
      sqlite.prepare("INSERT INTO capture_history (capture_id, job_id, sha256, size, captured_at, browser_ms, browser_ms_source) VALUES (?, ?, ?, 1, ?, 100, 'response_header')")
        .run(id, jobID, previousHash, now - index - 1);
    }
    sqlite.prepare("INSERT INTO active_playlist (singleton, playlist_id, revision) VALUES (1, 'operations', ?)")
      .run(created.body.revision);

    await assessUpcomingCaptures(env, now, async () => ({
      answers: {
        recommendation: { choice: 'skip_once', confidence: 0.95 },
        risk: { score: 0, confidence: 0.95 },
      },
    }));
    assert.equal(sqlite.prepare("SELECT action FROM capture_decisions WHERE capture_id = ? AND due_at = ?").get(id, dueAt).action, "defer_once");

    assert.equal((await dispatchDueCaptures(env, dueAt)).enqueued, 1);
    const scheduledJobID = messages[0].job_id;
    assert.equal(sqlite.prepare("SELECT scheduled_due_at FROM capture_jobs WHERE job_id = ?").get(scheduledJobID).scheduled_due_at, dueAt);
    assert.equal(sqlite.prepare("SELECT next_due_at FROM capture_targets WHERE capture_id = ?").get(id).next_due_at, dueAt + interval * 1000,
      "shadow decisions leave the next capture at the existing interval");
    await handleCaptureQueue({ messages: [{ body: messages[0], ack() {}, retry() { throw new Error("unexpected retry"); } }] }, env, dueAt + 5);

    const decision = sqlite.prepare("SELECT observed_result, observed_at, observed_delay_ms FROM capture_decisions WHERE capture_id = ? AND due_at = ?")
      .get(id, dueAt);
    assert.equal(decision.observed_result, "changed", "the candidate deferral is recorded as risky when the screenshot changed");
    assert.ok(decision.observed_at >= dueAt);
    assert.ok(decision.observed_delay_ms >= 0);
    const decisionResponse = await handleAdminRequest(await request("/admin/api/capture-decisions"), env);
    const [latestDecision] = await decisionResponse.json();
    assert.equal(latestDecision.observed_result, "changed");
    assert.equal(latestDecision.observed_delay_ms, decision.observed_delay_ms);
    const overview = await handleAdminRequest(await request("/admin/api/overview"), env);
    const metrics = (await overview.json()).capture_efficiency.last_30_days;
    assert.equal(metrics.jev_candidate_changed, 1);

    const otherOutcomes = ["unchanged", "validator_unchanged", "failed", "budget_deferred", null];
    for (const [index, outcome] of otherOutcomes.entries()) {
      sqlite.prepare(
        "INSERT INTO capture_decisions (capture_id, due_at, assessed_at, action, reason, observed_result) VALUES (?, ?, ?, 'defer_once', 'test outcome', ?)",
      ).run(id, dueAt + index + 1, dueAt, outcome);
    }
    const detailedOverview = await handleAdminRequest(await request("/admin/api/overview"), env);
    const detailedMetrics = (await detailedOverview.json()).capture_efficiency.last_30_days;
    assert.equal(detailedMetrics.jev_candidate_deferrals, 6);
    assert.equal(detailedMetrics.jev_candidate_changed, 1);
    assert.equal(detailedMetrics.jev_candidate_unchanged, 1);
    assert.equal(detailedMetrics.jev_candidate_validator_unchanged, 1);
    assert.equal(detailedMetrics.jev_candidate_failed, 1);
    assert.equal(detailedMetrics.jev_candidate_budget_deferred, 1);
    assert.equal(detailedMetrics.jev_candidate_unobserved, 1);
    assert.equal(detailedMetrics.jev_candidate_unverified, 4);
  } finally { sqlite.close(); }
});

test('background assessment failures record a fallback and preserve the scheduled capture', async () => {
  const { assessUpcomingCaptures } = await import('./capture-intelligence.ts');
  const sqlite = await freshDatabase();
  try {
    const { env, messages } = environment(sqlite);
    const created = await createCapturePlaylist(env);
    const id = created.body.captures[0].capture_id;
    sqlite.prepare("UPDATE capture_jobs SET status = 'succeeded' WHERE job_id = ?").run(messages.shift().job_id);
    const now = Date.now(); const due = now + 60_000;
    sqlite.prepare('UPDATE capture_targets SET next_due_at = ? WHERE capture_id = ?').run(due, id);
    sqlite.prepare("INSERT INTO active_playlist (singleton, playlist_id, revision) VALUES (1, 'operations', ?)").run(created.body.revision);
    await assessUpcomingCaptures(env, now, async () => { throw new Error('provider unavailable'); });
    assert.equal(sqlite.prepare('SELECT action FROM capture_decisions').get().action, 'error');
    await dispatchDueCaptures(env, due);
    assert.equal(messages.length, 1);
  } finally { sqlite.close(); }
});


test('abandoned background assessment can be retried without changing the schedule', async () => {
  const { assessUpcomingCaptures } = await import('./capture-intelligence.ts');
  const sqlite = await freshDatabase();
  try {
    const { env, messages } = environment(sqlite);
    const created = await createCapturePlaylist(env);
    const id = created.body.captures[0].capture_id;
    sqlite.prepare("UPDATE capture_jobs SET status = 'succeeded' WHERE job_id = ?").run(messages.shift().job_id);
    const now = Date.now(); const due = now + 60_000;
    sqlite.prepare('UPDATE capture_targets SET next_due_at = ? WHERE capture_id = ?').run(due, id);
    sqlite.prepare("INSERT INTO active_playlist (singleton, playlist_id, revision) VALUES (1, 'operations', ?)").run(created.body.revision);
    sqlite.prepare("INSERT INTO capture_decisions (capture_id, due_at, assessed_at, action, reason) VALUES (?, ?, ?, 'pending', 'pending')").run(id, due, now - 121_000);
    await assessUpcomingCaptures(env, now, async () => ({ answers: { recommendation: { choice: 'capture_now' }, risk: { score: 1 } } }));
    assert.equal(sqlite.prepare('SELECT action FROM capture_decisions').get().action, 'capture');
  } finally { sqlite.close(); }
});

test("capture site names can be updated, cleared, and appear in the overview", async () => {
  const sqlite = await freshDatabase();
  try {
    const { env } = environment(sqlite);
    const site = await registerCaptureSite(env, "https://example.com/named");
    const path = `/admin/api/captures/${site.body.capture_id}/name`;
    const update = async (name) => handleAdminRequest(await request(path, { method: "PATCH", body: { name } }), env);
    let response = await update("  fbo QA status  ");
    assert.equal(response.status, 200);
    assert.equal((await response.json()).name, "fbo QA status");
    response = await handleAdminRequest(await request("/admin/api/overview"), env);
    assert.equal((await response.json()).capture_targets[0].name, "fbo QA status");
    assert.equal((await update("x".repeat(121))).status, 400);
    assert.equal((await update(12)).status, 400);
    assert.equal((await update("")).status, 200);
    assert.equal(sqlite.prepare("SELECT name FROM capture_targets WHERE capture_id = ?").get(site.body.capture_id).name, null);
  } finally { sqlite.close(); }
});
