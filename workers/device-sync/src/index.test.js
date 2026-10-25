import test from "node:test";
import assert from "node:assert/strict";
import { fetchHandler, sha256Hex } from "./index.js";

const token = "a-secure-device-token-with-at-least-32-characters";
const digest = "a".repeat(64);
const manifest = {
  version: 1,
  revision: "revision-1",
  playlists: [{ id: "welcome", assets: [{ sha256: digest, size: 4 }] }],
  displays: [{ id: "screen-main", playlist_id: "welcome", rotation_interval: "30s" }],
};

class FakeDatabase {
  constructor() {
    this.device = {
      device_id: "pi-office",
      token_hash: "",
      manifest_key: "devices/pi-office/manifest.json",
      enabled: 1,
    };
    this.enrollment = { code_hash: "", expires_at: Date.now() + 60_000, consumed_at: null };
    this.insertedDevice = null;
  }

  prepare(sql) {
    const database = this;
    return {
      bind(...values) {
        return {
          async first() {
            if (sql.startsWith("SELECT device_id FROM devices")) return database.insertedDevice;
            if (sql.includes("FROM devices")) return database.device;
            if (sql.includes("FROM enrollments")) return database.enrollment;
            return null;
          },
          async run() {
            if (sql.startsWith("UPDATE enrollments")) {
              if (!database.enrollment || database.enrollment.consumed_at !== null || database.enrollment.expires_at <= values[2]) {
                return { meta: { changes: 0 } };
              }
              database.enrollment.consumed_at = values[0];
              return { meta: { changes: 1 } };
            }
            if (sql.startsWith("INSERT INTO devices")) {
              database.insertedDevice = {
                device_id: values[0],
                token_hash: values[1],
                manifest_key: values[2],
                enabled: 1,
              };
              database.device = database.insertedDevice;
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 1 } };
          },
        };
      },
    };
  }
}

function testEnvironment({ manifestValue = manifest, tokenValue = token, assetBytes = new Uint8Array([1, 2, 3, 4]) } = {}) {
  const db = new FakeDatabase();
  db.device.token_hash = tokenValue ? "" : "";
  const r2Gets = [];
  const env = {
    DB: db,
    ASSETS: {
      async get(key) {
        r2Gets.push(key);
        if (key === "devices/pi-office/manifest.json") {
          if (!manifestValue) return null;
          const body = JSON.stringify(manifestValue);
          return { size: new TextEncoder().encode(body).byteLength, async text() { return body; } };
        }
        if (key === `assets/${digest}`) {
          return { size: assetBytes.byteLength, body: new Response(assetBytes).body };
        }
        return null;
      },
    },
  };
  return { env, db, r2Gets };
}

async function authorize(db, presented = token) {
  db.device.token_hash = await sha256Hex(presented);
}

test("manifest endpoint authenticates the device and returns a revision ETag", async () => {
  const { env, db } = testEnvironment();
  await authorize(db);
  const response = await fetchHandler(new Request("https://worker.test/v1/devices/pi-office/manifest", {
    headers: { Authorization: `Bearer ${token}` },
  }), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("etag"), '"revision-1"');
  assert.deepEqual(await response.json(), manifest);

  const unchanged = await fetchHandler(new Request("https://worker.test/v1/devices/pi-office/manifest", {
    headers: { Authorization: `Bearer ${token}`, "If-None-Match": '"revision-1"' },
  }), env);
  assert.equal(unchanged.status, 304);
});

test("unauthorized device cannot read its manifest or cause an R2 read", async () => {
  const { env, r2Gets } = testEnvironment();
  const response = await fetchHandler(new Request("https://worker.test/v1/devices/pi-office/manifest"), env);
  assert.equal(response.status, 401);
  assert.deepEqual(r2Gets, []);
});

test("asset endpoint only serves a hash assigned by that device manifest", async () => {
  const { env, db, r2Gets } = testEnvironment();
  await authorize(db);
  const request = (hash) => new Request(`https://worker.test/v1/assets/${hash}`, {
    headers: { Authorization: `Bearer ${token}`, "X-Ribbonfish-Device-ID": "pi-office" },
  });
  const denied = await fetchHandler(request("b".repeat(64)), env);
  assert.equal(denied.status, 403);
  assert.deepEqual(r2Gets, ["devices/pi-office/manifest.json"]);

  const allowed = await fetchHandler(request(digest), env);
  assert.equal(allowed.status, 200);
  assert.deepEqual(new Uint8Array(await allowed.arrayBuffer()), new Uint8Array([1, 2, 3, 4]));
  assert.deepEqual(r2Gets.slice(-2), ["devices/pi-office/manifest.json", `assets/${digest}`]);
});

test("enrollment consumes a one-time code and stores only the device token hash", async () => {
  const { env, db } = testEnvironment();
  db.enrollment.code_hash = await sha256Hex("one-time-code");
  const response = await fetchHandler(new Request("https://worker.test/v1/enroll", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_id: "pi-office", enrollment_code: "one-time-code" }),
  }), env);
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(typeof result.device_token, "string");
  assert.equal(result.device_token.length, 64);
  assert.equal(db.insertedDevice.device_id, "pi-office");
  assert.equal(db.insertedDevice.token_hash, await sha256Hex(result.device_token));
  assert.notEqual(db.insertedDevice.token_hash, result.device_token);
  assert.equal(db.enrollment.consumed_at !== null, true);
});

test("manifest validation rejects arbitrary asset URLs and invalid digests", async () => {
  const { env, db } = testEnvironment({ manifestValue: {
    ...manifest,
    playlists: [{ id: "welcome", assets: [{ sha256: "not-a-hash", size: 4, url: "https://attacker.test/x" }] }],
  } });
  await authorize(db);
  const response = await fetchHandler(new Request("https://worker.test/v1/devices/pi-office/manifest", {
    headers: { Authorization: `Bearer ${token}` },
  }), env);
  assert.equal(response.status, 502);
});
