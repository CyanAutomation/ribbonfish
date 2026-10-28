import test from "node:test";
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { handleAdminRequest } from "./admin.js";
import { fetchHandler } from "./index.js";

const requestID = "a".repeat(64);
const publicKey = Buffer.alloc(32, 7).toString("base64url");

class EnrollmentAdminDatabase {
  constructor() {
    this.requests = new Map([[requestID, {
      request_id: requestID,
      device_id: "pi-office",
      public_key: publicKey,
      fingerprint: "aaaa-aaaa-aaaa-aaaa-aaaa-aaaa-aaaa-aaaa",
      created_at: 100,
      last_seen_at: 200,
      expires_at: Date.now() + 60_000,
      status: "pending",
    }]]);
    this.devices = new Map([[
      "pi-office",
      { device_id: "pi-office", token_hash: "legacy-hash", public_key: null, enabled: 1, created_at: 50, last_seen_at: 90 },
    ]]);
    this.audit = [];
  }

  prepare(sql) {
    const database = this;
    let values = [];
    const statement = {
      sql,
      get values() { return values; },
      bind(...boundValues) { values = boundValues; return statement; },
      async first() {
        if (sql.includes("FROM enrollment_requests") && sql.includes("WHERE request_id")) return database.requests.get(values[0]) ?? null;
        if (sql.includes("FROM devices WHERE public_key")) {
          return [...database.devices.values()].find((device) => device.public_key === values[0] && device.device_id !== values[1]) ?? null;
        }
        if (sql.includes("FROM devices WHERE device_id")) return database.devices.get(values[0]) ?? null;
        return null;
      },
      async all() {
        if (sql.includes("FROM enrollment_requests")) {
          return { results: [...database.requests.values()]
            .filter((row) => row.status === "pending" && row.expires_at > values[0])
            .map((row) => ({
              request_id: row.request_id,
              device_id: row.device_id,
              fingerprint: row.fingerprint,
              created_at: row.created_at,
              last_seen_at: row.last_seen_at,
              expires_at: row.expires_at,
              replaces_existing: database.devices.has(row.device_id) ? 1 : 0,
            })) };
        }
        return { results: [] };
      },
    };
    return statement;
  }

  async batch(statements) {
    const results = [];
    for (const statement of statements) {
      const { sql, values } = statement;
      let changes = 0;
      if (sql.startsWith("UPDATE enrollment_requests SET status")) {
        const approved = sql.includes("'approved'");
        const [decidedAt, actorID, decisionID, id, now] = approved
          ? values
          : [values[0], values[1], null, values[2], values[3]];
        const row = this.requests.get(id);
        if (row?.status === "pending" && row.expires_at > now) {
          Object.assign(row, {
            status: approved ? "approved" : "rejected",
            decided_at: decidedAt,
            actor_id: actorID,
            ...(decisionID ? { decision_id: decisionID } : {}),
          });
          changes = 1;
        }
      } else if (sql.startsWith("INSERT INTO devices")) {
        const [createdAt, id, decisionID] = values;
        const enrollment = this.requests.get(id);
        if (enrollment?.status === "approved" && enrollment.decision_id === decisionID) {
          const deviceID = enrollment.device_id;
          const key = enrollment.public_key;
          const current = this.devices.get(deviceID);
          this.devices.set(deviceID, {
            device_id: deviceID,
            token_hash: null,
            public_key: key,
            enabled: current?.enabled ?? 1,
            created_at: current?.created_at ?? createdAt,
            last_seen_at: null,
          });
          changes = 1;
        }
      } else if (sql.startsWith("INSERT INTO audit_events")) {
        const [event_id, actor_id, event_type, subject_type, subject_id, occurred_at, metadata_json] = values;
        this.audit.push({ event_id, actor_id, event_type, subject_type, subject_id, occurred_at, metadata_json });
        changes = 1;
      }
      results.push({ meta: { changes } });
    }
    return results;
  }
}

function environment(DB = new EnrollmentAdminDatabase()) {
  return { DB, ADMIN_ENABLED: "true", ADMIN_ACCESS_REQUIRED: "false", ASSETS: { async head() { return null; } } };
}

test("console lists pending requests with their identity fingerprint and replacement status", async () => {
  const env = environment();
  const response = await handleAdminRequest(new Request("https://worker.test/admin/api/enrollment-requests"), env);
  assert.equal(response.status, 200);
  const requests = await response.json();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].device_id, "pi-office");
  assert.equal(requests[0].fingerprint, "aaaa-aaaa-aaaa-aaaa-aaaa-aaaa-aaaa-aaaa");
  assert.equal(requests[0].replaces_existing, true);
  assert.equal("public_key" in requests[0], false, "console responses should expose only the fingerprint");
});

test("approving a pending replacement installs the approved public key and invalidates the legacy token", async () => {
  const env = environment();
  const response = await handleAdminRequest(new Request(
    `https://worker.test/admin/api/enrollment-requests/${requestID}/approve`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
  ), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { device_id: "pi-office", status: "approved" });
  assert.equal(env.DB.devices.get("pi-office").public_key, publicKey);
  assert.equal(env.DB.devices.get("pi-office").token_hash, null);
  assert.equal(env.DB.audit[0].event_type, "device.enrollment_approved");
});

test("rejecting a pending request leaves the device table unchanged", async () => {
  const env = environment();
  const response = await handleAdminRequest(new Request(
    `https://worker.test/admin/api/enrollment-requests/${requestID}/reject`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
  ), env);
  assert.equal(response.status, 200);
  assert.equal(env.DB.requests.get(requestID).status, "rejected");
  assert.equal(env.DB.devices.get("pi-office").public_key, null);
  assert.equal(env.DB.audit[0].event_type, "device.enrollment_rejected");
});

test("console refuses to approve an expired request or a public key already assigned elsewhere", async () => {
  const expiredEnv = environment();
  expiredEnv.DB.requests.get(requestID).expires_at = Date.now() - 1;
  const expiredResponse = await handleAdminRequest(new Request(
    `https://worker.test/admin/api/enrollment-requests/${requestID}/approve`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
  ), expiredEnv);
  assert.equal(expiredResponse.status, 409);
  assert.equal(expiredEnv.DB.devices.get("pi-office").public_key, null);

  const duplicateEnv = environment();
  duplicateEnv.DB.devices.set("pi-spare", {
    device_id: "pi-spare", token_hash: null, public_key: publicKey, enabled: 1, created_at: 75, last_seen_at: null,
  });
  const duplicateResponse = await handleAdminRequest(new Request(
    `https://worker.test/admin/api/enrollment-requests/${requestID}/approve`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
  ), duplicateEnv);
  assert.equal(duplicateResponse.status, 409);
  assert.equal(duplicateEnv.DB.requests.get(requestID).status, "pending");
  assert.equal(duplicateEnv.DB.audit.length, 0);
});

test("approval SQL transaction replaces a legacy token with a key and records its audit event", async () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec(await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
    sqlite.prepare(
      "INSERT INTO devices (device_id, token_hash, public_key, enabled, created_at, last_seen_at) VALUES (?, ?, NULL, 1, 50, 90)",
    ).run("pi-office", "legacy-hash");
    sqlite.prepare(
      "INSERT INTO enrollment_requests (request_id, device_id, public_key, fingerprint, created_at, last_seen_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')",
    ).run(requestID, "pi-office", publicKey, "aaaa-aaaa-aaaa-aaaa-aaaa-aaaa-aaaa-aaaa", 100, 200, Date.now() + 60_000);

    const DB = sqliteD1(sqlite);
    const response = await handleAdminRequest(new Request(
      `https://worker.test/admin/api/enrollment-requests/${requestID}/approve`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    ), environment(DB));
    assert.equal(response.status, 200, await response.clone().text());
    const device = sqlite.prepare("SELECT * FROM devices WHERE device_id = 'pi-office'").get();
    assert.equal(device.public_key, publicKey);
    assert.equal(device.token_hash, null);
    assert.equal(device.created_at, 50);
    assert.equal(device.last_seen_at, null);
    assert.equal(sqlite.prepare("SELECT event_type FROM audit_events").get().event_type, "device.enrollment_approved");
  } finally {
    sqlite.close();
  }
});

test("approved physical identity can immediately read the active playlist with its key", async () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec(await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
    const DB = sqliteD1(sqlite);
    const pair = await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const publicKeyBytes = new Uint8Array(await webcrypto.subtle.exportKey("raw", pair.publicKey));
    const publicKeyText = Buffer.from(publicKeyBytes).toString("base64url");
    const requestID = createHash("sha256").update(publicKeyBytes).digest("hex");
    const fingerprint = requestID.slice(0, 32).match(/.{4}/g).join("-");
    const digest = "b".repeat(64);
    sqlite.prepare(
      "INSERT INTO devices (device_id, token_hash, public_key, enabled, created_at, last_seen_at) VALUES (?, ?, NULL, 1, 50, 90)",
    ).run("pi-office", "old-token-hash");
    sqlite.prepare(
      "INSERT INTO enrollment_requests (request_id, device_id, public_key, fingerprint, created_at, last_seen_at, expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')",
    ).run(requestID, "pi-office", publicKeyText, fingerprint, 100, 200, Date.now() + 60_000);
    sqlite.prepare("INSERT INTO playlists VALUES (?, ?, ?, ?)").run("welcome", "r-welcome", "15s", 10);
    sqlite.prepare("INSERT INTO playlist_assets VALUES (?, ?, ?, ?, ?)").run("welcome", "r-welcome", 0, digest, 4);
    sqlite.prepare("INSERT INTO active_playlist VALUES (1, ?, ?)").run("welcome", "r-welcome");

    const approved = await handleAdminRequest(new Request(
      `https://worker.test/admin/api/enrollment-requests/${requestID}/approve`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    ), environment(DB));
    assert.equal(approved.status, 200);

    const timestamp = String(Date.now());
    const bodyHash = createHash("sha256").update("").digest("hex");
    const payload = ["ribbonfish-device-v1", "GET", "/v2/playlist", "pi-office", timestamp, "", bodyHash].join("\n");
    const signature = await webcrypto.subtle.sign("Ed25519", pair.privateKey, new TextEncoder().encode(payload));
    const playlist = await fetchHandler(new Request("https://worker.test/v2/playlist", {
      headers: {
        "X-Ribbonfish-Device-ID": "pi-office",
        "X-Ribbonfish-Timestamp": timestamp,
        "X-Ribbonfish-Signature": Buffer.from(signature).toString("base64url"),
      },
    }), {
      DB,
      ADMIN_ENABLED: "false",
      ENROLLMENT_RATE_LIMITER: { async limit() { return { success: true }; } },
      ASSETS: { async get() { return null; }, async head() { return null; } },
    });
    assert.equal(playlist.status, 200, await playlist.clone().text());
    assert.equal((await playlist.json()).id, "welcome");
    assert.equal(sqlite.prepare("SELECT token_hash FROM devices WHERE device_id = 'pi-office'").get().token_hash, null);
  } finally {
    sqlite.close();
  }
});

function sqliteD1(sqlite) {
  return {
    prepare(sql) {
      let values = [];
      const statement = {
        sql,
        get values() { return values; },
        bind(...boundValues) { values = boundValues; return statement; },
        async first() { return sqlite.prepare(sql).get(...values) ?? null; },
        async all() { return { results: sqlite.prepare(sql).all(...values) }; },
        async run() {
          const result = sqlite.prepare(sql).run(...values);
          return { meta: { changes: Number(result.changes) } };
        },
      };
      return statement;
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) {
          const result = sqlite.prepare(statement.sql).run(...statement.values);
          results.push({ meta: { changes: Number(result.changes) } });
        }
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
