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
          return row ? {
            playlist_id: row.playlist_id,
            revision: row.revision,
            rotation_interval: row.rotation_interval,
          } : null;
        }
        if (sql.includes("FROM playlist_assets")) {
          const referenced = [...database.playlists.values()]
            .some((row) => row.assets.some((asset) => asset.sha256 === values[0]));
          return referenced ? { present: 1 } : null;
        }
        if (sql.includes("FROM devices WHERE device_id")) return database.devices.get(values[0]) ?? null;
        return null;
      },
      async all() {
        if (sql.includes("FROM playlists WHERE playlist_id")) {
          return { results: [...database.playlists.values()]
            .filter((row) => row.playlist_id === values[0])
            .map(({ revision }) => ({ revision })) };
        }
        if (sql.includes("FROM devices")) {
          return { results: [...database.devices.values()].map(({ device_id, enabled, created_at, last_seen_at, public_key }) =>
            ({ device_id, enabled, created_at, last_seen_at, auth_type: public_key ? "key" : "token" })) };
        }
        if (sql.includes("FROM playlists p")) {
          const counts = new Map();
          for (const row of database.playlists.values()) {
            counts.set(row.playlist_id, (counts.get(row.playlist_id) ?? 0) + 1);
          }
          const rows = [...database.playlists.values()].map((row) => ({
            playlist_id: row.playlist_id,
            revision: row.revision,
            rotation_interval: row.rotation_interval,
            created_at: row.created_at,
            asset_count: row.assets.length,
            revision_count: counts.get(row.playlist_id),
            active: row.playlist_id === database.activePlaylist?.playlist_id && row.revision === database.activePlaylist?.revision,
          }));
          rows.sort((left, right) => Number(right.active) - Number(left.active) || right.created_at - left.created_at);
          return { results: rows.slice(0, 100) };
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
    let previousChanges = 1;
    const results = [];
    for (const statement of statements) {
      previousChanges = await this.apply(statement.sql, statement.values, previousChanges);
      results.push({ meta: { changes: previousChanges } });
    }
    return results;
  }

  async apply(sql, values, previousChanges = 1) {
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
      if (sql.includes("WHERE changes() > 0") && previousChanges === 0) return 0;
      const [event_id, actor_id, event_type, subject_type, subject_id, occurred_at, metadata_json] = values;
      this.auditEvents.push({ event_id, actor_id, event_type, subject_type, subject_id, occurred_at, metadata_json });
    } else if (sql.startsWith("DELETE FROM playlist_assets")) {
      const [playlist_id, guarded_playlist_id] = values;
      if (this.activePlaylist?.playlist_id === guarded_playlist_id) return 0;
      let deleted = 0;
      for (const playlist of this.playlists.values()) {
        if (playlist.playlist_id !== playlist_id) continue;
        deleted += playlist.assets.length;
        playlist.assets = [];
      }
      return deleted;
    } else if (sql.startsWith("DELETE FROM playlists")) {
      const [playlist_id, guarded_playlist_id] = values;
      if (this.activePlaylist?.playlist_id === guarded_playlist_id) return 0;
      const keys = [...this.playlists.keys()].filter((key) => key.startsWith(playlist_id + ":"));
      keys.forEach((key) => this.playlists.delete(key));
      return keys.length;
    }
    return 1;
  }
}

function testEnvironment({ enabled = true, accessRequired = false } = {}) {
  const DB = new FakeDatabase();
  const objects = new Map();
  const writes = [];
  return {
    DB,
    objects,
    writes,
    ADMIN_ENABLED: enabled ? "true" : "false",
    ADMIN_ACCESS_REQUIRED: accessRequired ? "true" : "false",
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

test("Access-protected management routes reject requests without an identity", async () => {
  const env = testEnvironment({ accessRequired: true });
  const response = await handleAdminRequest(request("/admin/api/overview"), env);
  assert.equal(response.status, 401);
  assert.equal(await response.text(), "access required");
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

test("static management assets only accept GET requests", async () => {
  const env = testEnvironment();
  const response = await handleAdminRequest(request("/admin/app.js", { method: "DELETE" }), env);
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET");
});

test("R2 failures while serving management assets become an admin error response", async () => {
  const env = testEnvironment();
  env.ASSETS.get = async () => { throw new Error("R2 unavailable"); };
  const response = await handleAdminRequest(request("/admin/app.js"), env);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "internal error" });
});

test("overview omits device token hashes and reports missing active assets", async () => {
  const env = testEnvironment();
  const response = await handleAdminRequest(request("/admin/api/overview"), env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(JSON.stringify(body).includes("do-not-return-this"), false);
  assert.equal(body.devices[0].device_id, "pi-office");
  assert.equal(body.devices[0].auth_type, "token");
  assert.equal(body.environment, "development");
  assert.deepEqual(body.asset_health.missing, [{ sha256: digest, expected_size: 4, actual_size: null }]);
});

test("overview identifies an Access-protected management deployment", async () => {
  const env = testEnvironment({ accessRequired: true });
  const response = await handleAdminRequest(request("/admin/api/overview"), env, {
    access: { async getIdentity() { return { email: "admin@example.com" }; } },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).environment, "production");
});

test("overview labels key-based devices without exposing their public keys", async () => {
  const env = testEnvironment();
  const publicKey = Buffer.alloc(32, 9).toString("base64url");
  env.DB.devices.get("pi-office").public_key = publicKey;
  env.DB.devices.get("pi-office").token_hash = null;
  const response = await handleAdminRequest(request("/admin/api/overview"), env);
  const overview = await response.json();
  assert.equal(overview.devices[0].auth_type, "key");
  assert.equal(JSON.stringify(overview).includes(publicKey), false);
});

test("overview keeps an older active playlist visible in the revision list", async () => {
  const env = testEnvironment();
  for (let index = 0; index < 100; index += 1) {
    const playlistID = `staged-${index}`;
    env.DB.playlists.set(`${playlistID}:r-new`, {
      playlist_id: playlistID,
      revision: "r-new",
      rotation_interval: rotation,
      created_at: 1000 + index,
      assets: [],
    });
  }

  const response = await handleAdminRequest(request("/admin/api/overview"), env);
  const overview = await response.json();

  assert.equal(overview.playlists.length, 100);
  assert.deepEqual(overview.playlists[0], {
    playlist_id: "welcome",
    revision: "revision-1",
    rotation_interval: rotation,
    created_at: 100,
    asset_count: 1,
    revision_count: 1,
    active: true,
  });
});

test("overview reports the full playlist revision count when the list is capped", async () => {
  const env = testEnvironment();
  for (let index = 0; index < 101; index += 1) {
    const revision = `r-${index}`;
    env.DB.playlists.set(`operations:${revision}`, {
      playlist_id: "operations",
      revision,
      rotation_interval: rotation,
      created_at: 1000 + index,
      assets: [],
    });
  }

  const response = await handleAdminRequest(request("/admin/api/overview"), env);
  const overview = await response.json();
  const operations = overview.playlists.find((playlist) => playlist.playlist_id === "operations");

  assert.ok(operations);
  assert.equal(operations.revision_count, 101);
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

test("playlist image previews require an existing playlist reference", async () => {
  const env = testEnvironment();
  const imageBytes = new Uint8Array([137, 80, 78, 71]);
  env.objects.set("assets/" + digest, imageBytes);

  const preview = await handleAdminRequest(request(`/admin/api/assets/${digest}`), env);
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("Content-Type"), "image/png");
  assert.equal(preview.headers.get("Cache-Control"), "private, no-store");
  assert.deepEqual(new Uint8Array(await preview.arrayBuffer()), imageBytes);

  const unreferenced = await handleAdminRequest(request(`/admin/api/assets/${"c".repeat(64)}`), env);
  assert.equal(unreferenced.status, 404);
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

test("playlist revision details return ordered asset references for editing", async () => {
  const env = testEnvironment();
  env.DB.playlists.set("operations:r-edit", {
    playlist_id: "operations",
    revision: "r-edit",
    rotation_interval: "45s",
    created_at: 200,
    assets: [
      { sha256: digest, size: 4 },
      { sha256: "b".repeat(64), size: 8 },
    ],
  });

  const response = await handleAdminRequest(request("/admin/api/playlists/operations/r-edit"), env);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    playlist_id: "operations",
    revision: "r-edit",
    rotation_interval: "45s",
    assets: [
      { sha256: digest, size: 4 },
      { sha256: "b".repeat(64), size: 8 },
    ],
  });
});

test("playlist editing can remove an image, add an upload and stage a new revision", async () => {
  const env = testEnvironment();
  env.objects.set("assets/" + digest, new Uint8Array([1, 2, 3, 4]));
  const secondDigest = "b".repeat(64);
  env.objects.set("assets/" + secondDigest, new Uint8Array([5, 6, 7, 8]));
  const upload = await handleAdminRequest(new Request("https://worker.test/admin/api/assets", {
    method: "POST",
    headers: { "Content-Type": "image/png" },
    body: new Uint8Array(await readFile(new URL("../../../agent/defaults/assets/service-health.png", import.meta.url))),
  }), env);
  assert.equal(upload.status, 201);
  const uploadedAsset = await upload.json();
  env.DB.playlists.set("operations:r-edit", {
    playlist_id: "operations",
    revision: "r-edit",
    rotation_interval: "45s",
    created_at: 200,
    assets: [
      { sha256: digest, size: 4 },
      { sha256: secondDigest, size: 4 },
    ],
  });

  const edited = await handleAdminRequest(request("/admin/api/playlists", {
    method: "POST",
    body: {
      id: "operations",
      rotation_interval: "60s",
      assets: [
        { sha256: secondDigest, size: 4 },
        uploadedAsset,
      ],
    },
  }), env);

  assert.equal(edited.status, 201);
  const result = await edited.json();
  assert.equal(result.id, "operations");
  assert.equal(result.rotation_interval, "60s");
  assert.equal(result.asset_count, 2);
  assert.deepEqual(env.DB.playlists.get(`operations:${result.revision}`).assets, [
    { sha256: secondDigest, size: 4 },
    uploadedAsset,
  ]);
  assert.deepEqual(env.DB.playlists.get("operations:r-edit").assets, [
    { sha256: digest, size: 4 },
    { sha256: secondDigest, size: 4 },
  ]);
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

test("inactive playlists and their revisions can be deleted without changing the active playlist", async () => {
  const env = testEnvironment();
  env.DB.playlists.set("operations:revision-2", {
    playlist_id: "operations",
    revision: "revision-2",
    rotation_interval: "45s",
    created_at: 200,
    assets: [{ sha256: digest, size: 4 }],
  });
  env.DB.playlists.set("operations:revision-1", {
    playlist_id: "operations",
    revision: "revision-1",
    rotation_interval: "30s",
    created_at: 100,
    assets: [{ sha256: digest, size: 4 }],
  });

  const response = await handleAdminRequest(request("/admin/api/playlists/operations", {
    method: "DELETE",
  }), env);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { playlist_id: "operations", deleted_revisions: 2 });
  assert.deepEqual([...env.DB.playlists.keys()], ["welcome:revision-1"]);
  assert.deepEqual(env.DB.activePlaylist, { playlist_id: "welcome", revision: "revision-1" });
  assert.equal(env.DB.auditEvents.at(-1).event_type, "playlist.deleted");
  assert.deepEqual(JSON.parse(env.DB.auditEvents.at(-1).metadata_json), { revision_count: 2 });
});

test("the active playlist cannot be deleted", async () => {
  const env = testEnvironment();

  const response = await handleAdminRequest(request("/admin/api/playlists/welcome", {
    method: "DELETE",
  }), env);

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "Please activate another playlist before deleting this one." });
  assert.equal(env.DB.playlists.has("welcome:revision-1"), true);
  assert.deepEqual(env.DB.activePlaylist, { playlist_id: "welcome", revision: "revision-1" });
  assert.equal(env.DB.auditEvents.length, 0);
});

test("deleting an unknown playlist returns not found", async () => {
  const env = testEnvironment();
  const response = await handleAdminRequest(request("/admin/api/playlists/missing", {
    method: "DELETE",
  }), env);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "That playlist could not be found." });
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

test("device key authentication cannot be converted back to a bearer token", async () => {
  const env = testEnvironment();
  const device = env.DB.devices.get("pi-office");
  device.token_hash = null;
  device.public_key = Buffer.alloc(32, 9).toString("base64url");
  const response = await handleAdminRequest(request("/admin/api/devices/pi-office/rotate", {
    method: "POST", body: {},
  }), env);
  assert.equal(response.status, 409);
  assert.equal(device.token_hash, null);
  assert.equal(env.DB.auditEvents.some((event) => event.event_type === "device.credential_rotated"), false);
});
