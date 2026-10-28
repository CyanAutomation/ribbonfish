import test from "node:test";
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { fetchHandler } from "./index.js";

const encoder = new TextEncoder();

class EnrollmentDatabase {
  constructor() {
    this.devices = new Map();
    this.requests = new Map();
    this.lastActivePlaylist = { playlist_id: "welcome", revision: "revision-1" };
  }

  prepare(sql) {
    const database = this;
    let values = [];
    const statement = {
      bind(...boundValues) { values = boundValues; return statement; },
      async first() {
        if (sql.includes("FROM devices WHERE device_id")) return database.devices.get(values[0]) ?? null;
        if (sql.includes("FROM enrollment_requests WHERE request_id")) return database.requests.get(values[0]) ?? null;
        if (sql.includes("FROM active_playlist ap")) {
          return { ...database.lastActivePlaylist, rotation_interval: "15s", has_captures: 0 };
        }
        if (sql.includes("FROM active_playlist")) return database.lastActivePlaylist;
        if (sql.includes("FROM playlists WHERE playlist_id")) {
          return { playlist_id: values[0], revision: values[1], rotation_interval: "15s" };
        }
        return null;
      },
      async all() {
        if (sql.includes("FROM playlist_assets")) return { results: [{ sha256: "a".repeat(64), size: 4 }] };
        return { results: [] };
      },
      async run() {
        if (sql.startsWith("DELETE FROM enrollment_requests")) {
          const [now] = values;
          for (const [requestID, row] of database.requests) {
            if (row.expires_at <= now) database.requests.delete(requestID);
          }
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith("INSERT INTO enrollment_requests")) {
          const [request_id, device_id, public_key, fingerprint, created_at, last_seen_at, expires_at] = values;
          const existing = database.requests.get(request_id);
          if (!existing) {
            database.requests.set(request_id, {
              request_id, device_id, public_key, fingerprint, created_at, last_seen_at,
              expires_at, status: "pending",
            });
          } else if (existing.status === "pending" && existing.device_id === device_id && existing.public_key === public_key) {
            existing.last_seen_at = last_seen_at;
          }
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith("UPDATE enrollment_requests SET last_seen_at")) {
          const [last_seen_at, request_id] = values;
          const existing = database.requests.get(request_id);
          if (existing) existing.last_seen_at = last_seen_at;
          return { meta: { changes: existing ? 1 : 0 } };
        }
        return { meta: { changes: 0 } };
      },
    };
    return statement;
  }
}

async function createSignedRequest({
  method = "POST",
  path = "/v1/enrollment-requests",
  deviceID = "pi-office",
  publicKey,
  privateKey,
  body = "",
  timestamp = String(Date.now()),
  etag = "",
} = {}) {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const payload = ["ribbonfish-device-v1", method, path, deviceID, timestamp, etag, bodyHash].join("\n");
  const signature = await webcrypto.subtle.sign("Ed25519", privateKey, encoder.encode(payload));
  return new Request("https://worker.test" + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Ribbonfish-Device-ID": deviceID,
      "X-Ribbonfish-Timestamp": timestamp,
      "X-Ribbonfish-Signature": Buffer.from(signature).toString("base64url"),
      ...(publicKey ? { "X-Ribbonfish-Public-Key": Buffer.from(publicKey).toString("base64url") } : {}),
      ...(etag ? { "If-None-Match": etag } : {}),
    },
    ...(method === "GET" ? {} : { body }),
  });
}

async function makeKeyPair() {
  const pair = await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  return {
    privateKey: pair.privateKey,
    publicKey: new Uint8Array(await webcrypto.subtle.exportKey("raw", pair.publicKey)),
    publicKeyText: Buffer.from(await webcrypto.subtle.exportKey("raw", pair.publicKey)).toString("base64url"),
  };
}

function testEnvironment(DB = new EnrollmentDatabase()) {
  const env = {
    DB,
    ADMIN_ENABLED: "true",
    ADMIN_ACCESS_REQUIRED: "false",
    ENROLLMENT_RATE_LIMITER: { async limit() { return { success: true }; } },
    ASSETS: { async get() { return null; }, async head() { return null; } },
  };
  return { DB, env };
}

test("device registration creates a pending request without granting playlist access", async () => {
  const { DB, env } = testEnvironment();
  const keyPair = await makeKeyPair();
  const body = JSON.stringify({ device_id: "pi-office", public_key: keyPair.publicKeyText });
  const request = await createSignedRequest({ ...keyPair, body });

  const response = await fetchHandler(request, env);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.status, "pending");
  assert.match(result.fingerprint, /^[a-f0-9]{4}(?:-[a-f0-9]{4}){7}$/);
  assert.equal(DB.requests.size, 1);
  assert.equal(DB.devices.has("pi-office"), false, "a pending request must not create an enabled device");

  const playlistRequest = await createSignedRequest({
    ...keyPair,
    method: "GET",
    path: "/v2/playlist",
  });
  const playlist = await fetchHandler(playlistRequest, env);
  assert.equal(playlist.status, 401, "a pending key must not authenticate for playlist content");
});

test("device registration rejects stale and invalid signatures without creating requests", async () => {
  const { DB, env } = testEnvironment();
  const keyPair = await makeKeyPair();
  const body = JSON.stringify({ device_id: "pi-office", public_key: keyPair.publicKeyText });

  const stale = await createSignedRequest({ ...keyPair, body, timestamp: String(Date.now() - 10 * 60_000) });
  assert.equal((await fetchHandler(stale, env)).status, 401);

  const valid = await createSignedRequest({ ...keyPair, body });
  valid.headers.set("X-Ribbonfish-Signature", Buffer.alloc(64).toString("base64url"));
  assert.equal((await fetchHandler(valid, env)).status, 401);
  assert.equal(DB.requests.size, 0);
});

test("an approved device key signs playlist requests without a bearer token", async () => {
  const { DB, env } = testEnvironment();
  const keyPair = await makeKeyPair();
  DB.devices.set("pi-office", {
    device_id: "pi-office",
    token_hash: null,
    public_key: keyPair.publicKeyText,
    enabled: 1,
  });
  const request = await createSignedRequest({
    ...keyPair,
    method: "GET",
    path: "/v2/playlist",
  });
  request.headers.delete("Authorization");

  const response = await fetchHandler(request, env);
  assert.equal(response.status, 200);
  const playlist = await response.json();
  assert.equal(playlist.id, "welcome");
});

test("the public enrollment rate limiter rejects excess requests before database writes", async () => {
  const { DB, env } = testEnvironment();
  env.ENROLLMENT_RATE_LIMITER.limit = async () => ({ success: false });
  const keyPair = await makeKeyPair();
  const body = JSON.stringify({ device_id: "pi-office", public_key: keyPair.publicKeyText });
  const request = await createSignedRequest({ ...keyPair, body });

  const response = await fetchHandler(request, env);
  assert.equal(response.status, 429);
  assert.equal(DB.requests.size, 0);
});

test("signed enrollment requests persist and poll correctly against the migrated SQLite schema", async () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec(await readFile(new URL("../schema.sql", import.meta.url), "utf8"));
    const DB = sqliteD1(sqlite);
    const env = testEnvironment(DB).env;
    const keyPair = await makeKeyPair();
    const body = JSON.stringify({ device_id: "pi-office", public_key: keyPair.publicKeyText });

    const first = await fetchHandler(await createSignedRequest({ ...keyPair, body }), env);
    assert.equal(first.status, 200, await first.clone().text());
    const firstResult = await first.json();
    assert.equal(firstResult.status, "pending");
    assert.equal(firstResult.request_id.length, 64);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM enrollment_requests").get().count, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM devices").get().count, 0);

    const second = await fetchHandler(await createSignedRequest({ ...keyPair, body }), env);
    assert.equal(second.status, 200);
    assert.equal((await second.json()).status, "pending");
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM enrollment_requests").get().count, 1);
  } finally {
    sqlite.close();
  }
});

function sqliteD1(sqlite) {
  return {
    prepare(sql) {
      let values = [];
      const statement = {
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
  };
}
