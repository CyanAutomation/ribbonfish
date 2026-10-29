import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fetchHandler, sha256Hex } from "./index.js";
import { handleAdminRequest } from "./admin.js";
import { persistDeviceHealth, refreshDeviceHealthStatuses } from "./device-health.js";

const deviceID = "pi-office";
const token = "a-secure-device-token-with-at-least-32-characters";
const report = {
  schema_version: 1, instance_id: "boot-0123456789abcdef", agent_version: "sha-0123456789ab",
  state: "degraded", agent_uptime_seconds: 120, startup_error_code: null,
  sync: { status: "ok", applied_playlist_id: "operations", applied_revision: "r-1", last_success_age_seconds: 15, error_code: null },
  outputs: [{ display_id: "main", connector: "HDMI-A-1", status: "failed", last_frame_age_seconds: null, error_code: "connector_disconnected" }],
  host: { uptime_seconds: 3600, load_1m: 0.1, memory_available_bytes: 200_000_000, state_disk_free_bytes: 20_000_000_000, temperature_millicelsius: 39_166 },
};

async function environment() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
  sqlite.prepare("INSERT INTO devices (device_id, token_hash, public_key, enabled, created_at) VALUES (?, ?, NULL, 1, ?)")
    .run(deviceID, await sha256Hex(token), Date.now());
  const DB = {
    prepare(sql) {
      let values = [];
      const statement = {
        sql,
        bind(...boundValues) { values = boundValues; return statement; },
        async first() { return sqlite.prepare(sql).get(...values) ?? null; },
        async all() { return { results: sqlite.prepare(sql).all(...values) }; },
        async run() { return sqlite.prepare(sql).run(...values); },
        get values() { return values; },
      };
      return statement;
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const result = statements.map((item) => {
          const applied = sqlite.prepare(item.sql).run(...item.values);
          return { meta: { changes: Number(applied.changes) } };
        });
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { sqlite, DB, ADMIN_ENABLED: "true", ADMIN_ACCESS_REQUIRED: "false", ASSETS: {} };
}

function postReport(body, bearer = token) {
  return new Request("https://worker.test/v1/telemetry", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}`, "X-Ribbonfish-Device-ID": deviceID },
    body: JSON.stringify(body),
  });
}

test("authenticated reports update latest state, five-minute samples, and transitions", async () => {
  const env = await environment();
  try {
    const response = await fetchHandler(postReport(report), env);
    assert.equal(response.status, 200);
    assert.equal(Number.isSafeInteger((await response.json()).received_at), true);
    const latest = env.sqlite.prepare("SELECT * FROM device_health_latest WHERE device_id = ?").get(deviceID);
    assert.equal(latest.reported_state, "degraded");
    assert.deepEqual(JSON.parse(latest.report_json), report);
    assert.equal(env.sqlite.prepare("SELECT COUNT(*) AS count FROM device_health_samples").get().count, 1);
    assert.equal(env.sqlite.prepare("SELECT COUNT(*) AS count FROM device_health_events").get().count, 1);
    await fetchHandler(postReport(report), env);
    assert.equal(env.sqlite.prepare("SELECT COUNT(*) AS count FROM device_health_events").get().count, 1);
  } finally { env.sqlite.close(); }
});

test("missed reports create stale and offline history, and recovery closes the outage", async () => {
  const env = await environment();
  try {
    const firstReceivedAt = Date.now() - 10 * 60 * 1000;
    const healthy = {
      ...report,
      state: "ready",
      sync: { status: "ok", applied_playlist_id: "operations", applied_revision: "r-1", last_success_age_seconds: 10, error_code: null },
      outputs: [{ display_id: "main", connector: "HDMI-A-1", status: "ready", last_frame_age_seconds: 0, error_code: null }],
    };
    await persistDeviceHealth(env.DB, deviceID, healthy, firstReceivedAt);
    assert.equal(env.sqlite.prepare("SELECT health_status FROM device_health_latest WHERE device_id = ?").get(deviceID).health_status, "healthy");

    assert.equal(await refreshDeviceHealthStatuses(env.DB, firstReceivedAt + 4 * 60 * 1000), 1);
    assert.equal(env.sqlite.prepare("SELECT health_status FROM device_health_latest WHERE device_id = ?").get(deviceID).health_status, "stale");
    assert.equal(await refreshDeviceHealthStatuses(env.DB, firstReceivedAt + 6 * 60 * 1000), 1);
    assert.equal(env.sqlite.prepare("SELECT health_status FROM device_health_latest WHERE device_id = ?").get(deviceID).health_status, "offline");

    await persistDeviceHealth(env.DB, deviceID, healthy, firstReceivedAt + 6 * 60 * 1000 + 1);
    const events = env.sqlite.prepare("SELECT metadata_json FROM device_health_events ORDER BY received_at").all().map((event) => JSON.parse(event.metadata_json));
    assert.equal(events.length, 4);
    assert.deepEqual(events[1], { previous_health_status: "healthy", health_status: "stale", state: "ready", error_code: null });
    assert.deepEqual(events[2], { previous_health_status: "stale", health_status: "offline", state: "ready", error_code: null });
    assert.equal(events[3].health_status, "healthy");
  } finally { env.sqlite.close(); }
});

test("telemetry requires enrolled-device auth and validates its bounded schema", async () => {
  const env = await environment();
  try {
    assert.equal((await fetchHandler(postReport(report, "wrong-token"), env)).status, 401);
    assert.equal((await fetchHandler(postReport({ ...report, extra: "value" }), env)).status, 400);
    assert.equal((await fetchHandler(postReport({ ...report, outputs: Array(9).fill(report.outputs[0]) }), env)).status, 400);
    const oversized = new Request("https://worker.test/v1/telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-Ribbonfish-Device-ID": deviceID },
      body: " ".repeat(8193),
    });
    assert.equal((await fetchHandler(oversized, env)).status, 413);
  } finally { env.sqlite.close(); }
});

test("telemetry authenticates before parsing JSON reports", async () => {
  const env = await environment();
  try {
    const malformedBody = "{";
    const unauthenticated = new Request("https://worker.test/v1/telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Ribbonfish-Device-ID": deviceID },
      body: malformedBody,
    });
    assert.equal((await fetchHandler(unauthenticated, env)).status, 401);

    const authenticated = new Request("https://worker.test/v1/telemetry", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "X-Ribbonfish-Device-ID": deviceID,
      },
      body: malformedBody,
    });
    assert.equal((await fetchHandler(authenticated, env)).status, 400);
  } finally { env.sqlite.close(); }
});

test("key-authenticated telemetry signs the exact request body", async () => {
  const env = await environment();
  try {
    const pair = generateKeyPairSync("ed25519");
    const publicKey = pair.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
    env.sqlite.prepare("UPDATE devices SET token_hash = NULL, public_key = ? WHERE device_id = ?").run(publicKey, deviceID);
    const body = JSON.stringify(report);
    const timestamp = String(Date.now());
    const hash = createHash("sha256").update(body).digest("hex");
    const canonical = ["ribbonfish-device-v1", "POST", "/v1/telemetry", deviceID, timestamp, "", hash].join("\n");
    const signature = sign(null, Buffer.from(canonical), pair.privateKey).toString("base64url");
    const makeRequest = (requestBody) => new Request("https://worker.test/v1/telemetry", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Ribbonfish-Device-ID": deviceID,
        "X-Ribbonfish-Timestamp": timestamp,
        "X-Ribbonfish-Signature": signature,
      },
      body: requestBody,
    });
    assert.equal((await fetchHandler(makeRequest(body), env)).status, 200);
    assert.equal((await fetchHandler(makeRequest(JSON.stringify({ ...report, agent_uptime_seconds: 121 })), env)).status, 401);
    assert.equal((await fetchHandler(makeRequest("{"), env)).status, 401);
  } finally { env.sqlite.close(); }
});

test("management health and history APIs expose the latest report without credentials", async () => {
  const env = await environment();
  try {
    await fetchHandler(postReport(report), env);
    const healthResponse = await handleAdminRequest(new Request(`https://worker.test/admin/api/devices/${deviceID}/health`), env);
    assert.equal(healthResponse.status, 200);
    const health = await healthResponse.json();
    assert.equal(health.health_status, "degraded");
    assert.equal(health.latest.outputs[0].error_code, "connector_disconnected");
    assert.equal(JSON.stringify(health).includes(token), false);
    const overview = await (await handleAdminRequest(new Request("https://worker.test/admin/api/overview"), env)).json();
    assert.equal(overview.devices[0].health.status, "degraded");
    assert.equal(overview.devices[0].health.outputs[0].error_code, "connector_disconnected");
    const historyResponse = await handleAdminRequest(new Request(`https://worker.test/admin/api/devices/${deviceID}/health-history?limit=10`), env);
    assert.equal(historyResponse.status, 200);
    const history = await historyResponse.json();
    assert.equal(history.samples.length, 1);
    assert.equal(history.events.length, 1);
  } finally { env.sqlite.close(); }
});

test("health history clamps old timestamps to retention and rejects future timestamps", async () => {
  const env = await environment();
  try {
    const beforeRequest = Date.now();
    const oldTimestamp = await handleAdminRequest(new Request(
      `https://worker.test/admin/api/devices/${deviceID}/health-history?since=0&limit=10`,
    ), env);
    assert.equal(oldTimestamp.status, 200);
    const history = await oldTimestamp.json();
    assert.ok(history.since >= beforeRequest - 30 * 24 * 60 * 60 * 1000);
    assert.ok(history.since <= Date.now());

    const futureTimestamp = Date.now() + 60_000;
    const future = await handleAdminRequest(new Request(
      `https://worker.test/admin/api/devices/${deviceID}/health-history?since=${futureTimestamp}&limit=10`,
    ), env);
    assert.equal(future.status, 400);
  } finally { env.sqlite.close(); }
});
