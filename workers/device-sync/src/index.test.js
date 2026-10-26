import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fetchHandler, sha256Hex } from "./index.js";

const token = "a-secure-device-token-with-at-least-32-characters";
const digest = "a".repeat(64);
const playlist = {
  version: 2,
  revision: "revision-1",
  id: "welcome",
  rotation_interval: "30s",
  assets: [{ sha256: digest, size: 4 }],
};

class FakeDatabase {
  constructor() {
    this.device = {
      device_id: "pi-office",
      token_hash: "",
      enabled: 1,
    };
    this.enrollment = { code_hash: "", expires_at: Date.now() + 60_000, consumed_at: null };
    this.insertedDevice = null;
    this.enrollments = [this.enrollment];
    this.devices = new Map();
    this.playlists = new Map([[`${playlist.id}:${playlist.revision}`, playlist]]);
    this.activePlaylist = { playlist_id: playlist.id, revision: playlist.revision };
  }

  prepare(sql) {
    const database = this;
    let values = [];
    const statement = {
      bind(...boundValues) { values = boundValues; return statement; },
      async first() {
        if (sql.startsWith("SELECT device_id FROM devices")) {
          if (database.enrollmentReadBarrier) {
            const barrier = database.enrollmentReadBarrier;
            barrier.reads++;
            if (barrier.reads === 2) barrier.release();
            await barrier.promise;
          }
          return database.devices.get(values[0]) ?? null;
        }
        if (sql.includes("FROM active_playlist")) return database.activePlaylist;
        if (sql.includes("FROM playlists WHERE playlist_id")) {
          const value = database.playlists.get(`${values[0]}:${values[1]}`);
          return value ? { playlist_id: value.id, revision: value.revision, rotation_interval: value.rotation_interval } : null;
        }
        if (sql.includes("FROM playlist_assets WHERE sha256")) {
          for (const value of database.playlists.values()) {
            const asset = value.assets.find((item) => item.sha256 === values[0]);
            if (asset) return { size: asset.size };
          }
          return null;
        }
        if (sql.includes("FROM devices")) {
          return values[0] === "pi-office" ? database.device : database.devices.get(values[0]) ?? null;
        }
        if (sql.includes("FROM enrollments")) return database.enrollments.find((item) => item.code_hash === values[0]) ?? null;
        return null;
      },
      async all() {
        const value = database.playlists.get(`${values[0]}:${values[1]}`);
        return { results: value?.assets ?? [] };
      },
      get values() { return values; },
    };
    return statement;
  }

  async batch(statements) {
    const [claim, insert] = statements;
    const [now, claimID, codeHash, expiresAt, deviceID] = claim.values;
    const enrollment = this.enrollments.find((item) => item.code_hash === codeHash);
    if (enrollment && enrollment.consumed_at === null && enrollment.expires_at > expiresAt && !this.devices.has(deviceID)) {
      enrollment.consumed_at = now;
      enrollment.claim_id = claimID;
    }

    const [insertDeviceID, tokenHash, createdAt, insertCodeHash, consumedAt, insertClaimID, insertDeviceIDAgain] = insert.values;
    const claimedEnrollment = this.enrollments.find((item) => item.code_hash === insertCodeHash);
    let insertChanges = 0;
    if (claimedEnrollment?.consumed_at === consumedAt && claimedEnrollment.claim_id === insertClaimID &&
        insertDeviceID === insertDeviceIDAgain && !this.devices.has(insertDeviceID)) {
      const device = { device_id: insertDeviceID, token_hash: tokenHash, enabled: 1, created_at: createdAt };
      this.devices.set(insertDeviceID, device);
      this.insertedDevice = device;
      this.device = device;
      insertChanges = 1;
    }
    return [
      { meta: { changes: enrollment?.claim_id === claimID ? 1 : 0 } },
      { meta: { changes: insertChanges } },
    ];
  }
}

function testEnvironment({ playlistValue = playlist, assetBytes = new Uint8Array([1, 2, 3, 4]) } = {}) {
  const db = new FakeDatabase();
  db.playlists = new Map(playlistValue ? [[`${playlistValue.id}:${playlistValue.revision}`, playlistValue]] : []);
  db.activePlaylist = playlistValue ? { playlist_id: playlistValue.id, revision: playlistValue.revision } : null;
  const r2Gets = [];
  const env = {
    DB: db,
    ASSETS: {
      async get(key) {
        r2Gets.push(key);
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

test("version 2 playlist endpoint authenticates the device and returns a revision ETag", async () => {
  const { env, db } = testEnvironment();
  await authorize(db);
  const request = (headers = {}) => new Request("https://worker.test/v2/playlist", {
    headers: { Authorization: `Bearer ${token}`, "X-Ribbonfish-Device-ID": "pi-office", ...headers },
  });
  const response = await fetchHandler(request(), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("etag"), '"revision-1"');
  assert.equal(response.headers.get("cache-control"), "private, no-store, no-transform");
  assert.deepEqual(await response.json(), playlist);

  const unchanged = await fetchHandler(request({ "If-None-Match": '"revision-1"' }), env);
  assert.equal(unchanged.status, 304);
});

test("all enrolled devices receive the same active playlist", async () => {
  const { env, db } = testEnvironment();
  const secondToken = "another-secure-device-token-with-at-least-32-characters";
  db.devices.set("pi-second", { device_id: "pi-second", token_hash: await sha256Hex(secondToken), enabled: 1 });
  await authorize(db);
  const fetchPlaylist = (deviceID, bearer) => fetchHandler(new Request("https://worker.test/v2/playlist", {
    headers: { Authorization: `Bearer ${bearer}`, "X-Ribbonfish-Device-ID": deviceID },
  }), env);
  const first = await fetchPlaylist("pi-office", token);
  const second = await fetchPlaylist("pi-second", secondToken);
  assert.deepEqual(await first.json(), await second.json());
});

test("changing the active playlist changes the global response revision", async () => {
  const { env, db } = testEnvironment();
  await authorize(db);
  db.playlists.set("platform:revision-2", { ...playlist, id: "platform", revision: "revision-2" });
  db.activePlaylist = { playlist_id: "platform", revision: "revision-2" };
  const response = await fetchHandler(new Request("https://worker.test/v2/playlist", {
    headers: { Authorization: `Bearer ${token}`, "X-Ribbonfish-Device-ID": "pi-office", "If-None-Match": '"revision-1"' },
  }), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("etag"), '"revision-2"');
  assert.equal((await response.json()).id, "platform");
});

test("unauthorized device cannot read its playlist or cause an R2 read", async () => {
  const { env, r2Gets } = testEnvironment();
  const response = await fetchHandler(new Request("https://worker.test/v2/playlist", {
    headers: { "X-Ribbonfish-Device-ID": "pi-office" },
  }), env);
  assert.equal(response.status, 401);
  assert.deepEqual(r2Gets, []);
});

test("asset endpoint only serves hashes in the managed playlist catalog", async () => {
  const { env, db, r2Gets } = testEnvironment();
  await authorize(db);
  const request = (hash) => new Request(`https://worker.test/v2/assets/${hash}`, {
    headers: { Authorization: `Bearer ${token}`, "X-Ribbonfish-Device-ID": "pi-office" },
  });
  const denied = await fetchHandler(request("b".repeat(64)), env);
  assert.equal(denied.status, 403);
  assert.deepEqual(r2Gets, []);

  const allowed = await fetchHandler(request(digest), env);
  assert.equal(allowed.status, 200);
  assert.deepEqual(new Uint8Array(await allowed.arrayBuffer()), new Uint8Array([1, 2, 3, 4]));
  assert.deepEqual(r2Gets, [`assets/${digest}`]);
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

test("concurrent enrollment for the same device consumes only the winning code", async () => {
  const { env, db } = testEnvironment();
  const codes = ["first-one-time-code", "second-one-time-code"];
  let releaseChecks;
  db.enrollmentReadBarrier = { reads: 0, promise: new Promise((resolve) => { releaseChecks = resolve; }), release: () => releaseChecks() };
  db.enrollment.code_hash = await sha256Hex(codes[0]);
  db.enrollments.push({ code_hash: await sha256Hex(codes[1]), expires_at: Date.now() + 60_000, consumed_at: null });
  const enroll = (enrollment_code) => fetchHandler(new Request("https://worker.test/v1/enroll", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_id: "pi-office", enrollment_code }),
  }), env);

  const responses = await Promise.all(codes.map(enroll));
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
  assert.equal(db.devices.size, 1);
  assert.equal(db.enrollments.filter((item) => item.consumed_at !== null).length, 1);
});

test("playlist validation rejects invalid stored asset digests", async () => {
  const { env, db } = testEnvironment({ playlistValue: {
    ...playlist,
    assets: [{ sha256: "not-a-hash", size: 4 }],
  } });
  await authorize(db);
  const response = await fetchHandler(new Request("https://worker.test/v2/playlist", {
    headers: { Authorization: `Bearer ${token}`, "X-Ribbonfish-Device-ID": "pi-office" },
  }), env);
  assert.equal(response.status, 502);
});

test("playlist validation rejects durations the Go agent cannot parse", async () => {
  for (const rotation_interval of ["0.1ns", "999999999999999999999h"]) {
    const { env, db } = testEnvironment({ playlistValue: { ...playlist, rotation_interval } });
    await authorize(db);
    const response = await fetchHandler(new Request("https://worker.test/v2/playlist", {
      headers: { Authorization: `Bearer ${token}`, "X-Ribbonfish-Device-ID": "pi-office" },
    }), env);
    assert.equal(response.status, 502, rotation_interval);
  }
});

test("default Worker playlist assets match the bundled images", async () => {
  const defaultPlaylist = JSON.parse(await readFile(new URL("../defaults/default-playlist.json", import.meta.url), "utf8"));
  const profile = JSON.parse(await readFile(new URL("../../../agent/defaults/pi3a-plus.json", import.meta.url), "utf8"));
  assert.equal(defaultPlaylist.id, "default");
  assert.equal(defaultPlaylist.rotation_interval, "15s");
  assert.equal(profile.playlist.id, defaultPlaylist.id);
  assert.equal(profile.playlist.rotation_interval, defaultPlaylist.rotation_interval);
  assert.equal(profile.playlist.assets.length, defaultPlaylist.assets.length);
  for (const asset of defaultPlaylist.assets) {
    const assetPath = new URL(asset.path, new URL("../defaults/default-playlist.json", import.meta.url));
    const bytes = await readFile(assetPath);
    assert.deepEqual(
      { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.byteLength },
      { sha256: asset.sha256, size: asset.size },
    );
  }
  assert.deepEqual(
    profile.playlist.assets.map(({ sha256 }) => sha256),
    defaultPlaylist.assets.map(({ sha256 }) => sha256),
  );
});
