import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { handleAdminRequest, sha256Hex } from "./admin.js";

const digest = "a".repeat(64);
const rotation = "30s";

class FakeDatabase {
  constructor() {
    this.devices = new Map([["pi-office", {
      device_id: "pi-office",
      token_hash: "do-not-return-this",
      enabled: 1,
      created_at: 100,
      last_seen_at: 200,
    }]]);
    this.enrollments = [];
    this.playlists = new Map([["welcome:revision-1", {
      playlist_id: "welcome",
      revision: "revision-1",
      rotation_interval: rotation,
      created_at: 100,
      assets: [{ sha256: digest, size: 4 }],
    }]]);
    this.activePlaylist = { playlist_id: "welcome", revision: "revision-1" };
    this.auditEvents = [];
  }

  prepare(sql) {
    const database = this;
    let values = [];
    return {
      sql,
      bind(...boundValues) { values = boundValues; return this; },
      get values() { return values; },
      async first() {
        if (sql.includes("FROM active_playlist")) return database.activePlaylist;
        if (sql.includes("FROM playlists WHERE playlist_id")) {
          const row = database.playlists.get(values[0] + ":" + values[1]);
          return row ? { playlist_id: row.playlist_id, revision: row.revision } : null;
        }
        if (sql.includes("FROM devices WHERE device_id")) return database.devices.get(values[0]) ?? null;
        return null;
      },
      async all() {
        if (sql.includes("FROM devices")) {
          return { results: [...database.devices.values()].map(({ device_id, enabled, created_at, last_seen_at }) =>
            ({ device_id, enabled, created_at, last_seen_at })) };
        }
        if (sql.includes("FROM playlists p")) {
          return { results: [...database.playlists.values()].map((row) => ({
            playlist_id: row.playlist_id,
            revision: row.revision,
            rotation_interval: row.rotation_interval,
            created_at: row.created_at,
            asset_count: row.assets.length,
            active: row.playlist_id === database.activePlaylist?.playlist_id && row.revision === database.activePlaylist?.revision,
          })) };
        }
        if (sql.includes("FROM playlist_assets")) {
          const row = database.playlists.get(values[0] + ":" + values[1]);
          return { results: row?.assets ?? [] };
        }
        if (sql.includes("FROM audit_events")) return { results: database.auditEvents.slice(-values[0]).reverse() };
        return { results: [] };
      },
      async run() {
        await database.apply(sql, values);
        return { meta: { changes: 1 } };
      },
    };
  }

  async batch(statements) {
    for (const statement of statements) await this.apply(statement.sql, statement.values);
    return statements.map(() => ({ meta: { changes: 1 } }));
  }

  async apply(sql, values) {
    if (sql.startsWith("INSERT INTO playlists")) {
      const [playlist_id, revision, rotation_interval, created_at] = values;
      this.playlists.set(playlist_id + ":" + revision, {
        playlist_id, revision, rotation_interval, created_at, assets: [],
      });
    } else if (sql.startsWith("INSERT INTO playlist_assets")) {
      const [playlist_id, revision, position, sha256, size] = values;
      const row = this.playlists.get(playlist_id + ":" + revision);
      row.assets[position] = { sha256, size };
    } else if (sql.startsWith("INSERT INTO active_playlist")) {
      this.activePlaylist = { playlist_id: values[0], revision: values[1] };
    } else if (sql.startsWith("UPDATE devices SET enabled")) {
      const [enabled, device_id] = values;
      const row = this.devices.get(device_id);
      if (row) row.enabled = enabled;
    } else if (sql.startsWith("UPDATE devices SET token_hash")) {
      const [token_hash, device_id] = values;
      const row = this.devices.get(device_id);
      if (row) row.token_hash = token_hash;
    } else if (sql.startsWith("INSERT INTO enrollments")) {
      const [code_hash, expires_at] = values;
      this.enrollments.push({ code_hash, expires_at, consumed_at: null });
    } else if (sql.startsWith("INSERT INTO audit_events")) {
      const [event_id, actor_id, event_type, subject_type, subject_id, occurred_at, metadata_json] = values;
      this.auditEvents.push({ event_id, actor_id, event_type, subject_type, subject_id, occurred_at, metadata_json });
    }
  }
}

function testEnvironment({ enabled = true } = {}) {
  const DB = new FakeDatabase();
  const objects = new Map();
  const writes = [];
  return {
    DB,
    objects,
    writes,
    ADMIN_ENABLED: enabled ? "true" : "false",
    ASSETS: {
      async get(key) {
        const bytes = objects.get(key);
        if (!bytes) return null;
        return { size: bytes.byteLength, body: new Response(bytes).body };
      },
      async head(key) {
        const bytes = objects.get(key);
        return bytes ? { size: bytes.byteLength } : null;
      },
      async put(key, bytes) {
        const copy = new Uint8Array(bytes);
        objects.set(key, copy);
        writes.push(key);
        return { key };
      },
    },
  };
}

function request(path, { method = "GET", body, headers = {} } = {}) {
  return new Request("https://worker.test" + path, {
    method,
    headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("management routes fail closed when the environment flag is disabled", async () => {
  const env = testEnvironment({ enabled: false });
  const response = await handleAdminRequest(request("/admin/api/overview"), env);
  assert.equal(response.status, 404);
  assert.equal(env.DB.auditEvents.length, 0);
});

test("management page is served from the private R2 bucket", async () => {
  const env = testEnvironment();
  env.objects.set("admin/index.html", new TextEncoder().encode("<main>Ribbonfish</main>"));
  const response = await handleAdminRequest(request("/admin/"), env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "<main>Ribbonfish</main>");
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
});

test("overview omits device token hashes and reports missing active assets", async () => {
  const env = testEnvironment();
  const response = await handleAdminRequest(request("/admin/api/overview"), env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(JSON.stringify(body).includes("do-not-return-this"), false);
  assert.equal(body.devices[0].device_id, "pi-office");
  assert.deepEqual(body.asset_health.missing, [{ sha256: digest, expected_size: 4, actual_size: null }]);
});

test("enrollment codes are stored only as hashes and are audited", async () => {
  const env = testEnvironment();
  const response = await handleAdminRequest(request("/admin/api/enrollment-codes", {
    method: "POST", body: { expires_in_minutes: 30 },
  }), env);
  assert.equal(response.status, 201);
  const { code, expires_at } = await response.json();
  assert.equal(typeof code, "string");
  assert.equal(code.length > 20, true);
  assert.equal(env.DB.enrollments[0].code_hash, await sha256Hex(code));
  assert.equal(env.DB.enrollments[0].expires_at, expires_at);
  assert.equal(JSON.stringify(env.DB.auditEvents).includes(code), false);
});

test("PNG upload is content-addressed and rejects non-PNG bytes", async () => {
  const env = testEnvironment();
  const png = new Uint8Array(await readFile(new URL("../../../agent/defaults/assets/service-health.png", import.meta.url)));
  const response = await handleAdminRequest(new Request("https://worker.test/admin/api/assets", {
    method: "POST", headers: { "Content-Type": "image/png" }, body: png,
  }), env);
  assert.equal(response.status, 201);
  const asset = await response.json();
  assert.equal(asset.sha256.length, 64);
  assert.equal(asset.size, png.byteLength);
  assert.deepEqual(env.writes, ["assets/" + asset.sha256]);

  const invalid = await handleAdminRequest(new Request("https://worker.test/admin/api/assets", {
    method: "POST", headers: { "Content-Type": "image/png" }, body: new Uint8Array([1, 2, 3]),
  }), env);
  assert.equal(invalid.status, 400);
});

test("playlist revisions are staged, then explicitly activated", async () => {
  const env = testEnvironment();
  env.objects.set("assets/" + digest, new Uint8Array([1, 2, 3, 4]));
  const staged = await handleAdminRequest(request("/admin/api/playlists", {
    method: "POST",
    body: { id: "operations", rotation_interval: "45s", assets: [{ sha256: digest, size: 4 }] },
  }), env);
  assert.equal(staged.status, 201);
  const revision = (await staged.json()).revision;
  assert.match(revision, /^r-[a-f0-9]{32}$/);
  assert.deepEqual(env.DB.activePlaylist, { playlist_id: "welcome", revision: "revision-1" });

  const activated = await handleAdminRequest(request("/admin/api/active-playlist", {
    method: "PUT", body: { playlist_id: "operations", revision },
  }), env);
  assert.equal(activated.status, 200);
  assert.deepEqual(env.DB.activePlaylist, { playlist_id: "operations", revision });
  assert.equal(env.DB.auditEvents.some((event) => event.event_type === "playlist.activated"), true);
});

test("playlist staging rejects an asset that is missing from R2", async () => {
  const env = testEnvironment();
  const response = await handleAdminRequest(request("/admin/api/playlists", {
    method: "POST",
    body: { id: "broken", rotation_interval: "30s", assets: [{ sha256: digest, size: 4 }] },
  }), env);
  assert.equal(response.status, 409);
  assert.equal(env.DB.playlists.has("broken:revision-1"), false);
  assert.deepEqual(env.DB.activePlaylist, { playlist_id: "welcome", revision: "revision-1" });
});

test("device status changes are recorded and token rotation returns the token once", async () => {
  const env = testEnvironment();
  const disabled = await handleAdminRequest(request("/admin/api/devices/pi-office", {
    method: "PATCH", body: { enabled: false },
  }), env);
  assert.equal(disabled.status, 200);
  assert.equal(env.DB.devices.get("pi-office").enabled, 0);

  const rejectedRotation = await handleAdminRequest(request("/admin/api/devices/pi-office/rotate", {
    method: "POST", body: "device_id=pi-office", headers: { "Content-Type": "application/x-www-form-urlencoded" },
  }), env);
  assert.equal(rejectedRotation.status, 415);

  const rotated = await handleAdminRequest(request("/admin/api/devices/pi-office/rotate", {
    method: "POST", body: {},
  }), env);
  assert.equal(rotated.status, 200);
  const { device_token } = await rotated.json();
  assert.equal(device_token.length, 64);
  assert.equal(env.DB.devices.get("pi-office").token_hash, await sha256Hex(device_token));
  assert.equal(JSON.stringify(env.DB.auditEvents).includes(device_token), false);
  assert.equal(env.DB.auditEvents.some((event) => event.event_type === "device.credential_rotated"), true);
  assert.equal(env.DB.auditEvents.at(-1).actor_id, "anonymous");
});
