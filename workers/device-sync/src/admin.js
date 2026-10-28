import { isValidPositiveDuration } from "./duration.js";

const MAX_JSON_BYTES = 64 << 10;
const MAX_ASSET_BYTES = 32 << 20;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const ADMIN_FILES = new Map([
  ["/admin/index.html", { key: "admin/index.html", contentType: "text/html; charset=utf-8" }],
  ["/admin/app.js", { key: "admin/app.js", contentType: "text/javascript; charset=utf-8" }],
  ["/admin/styles.css", { key: "admin/styles.css", contentType: "text/css; charset=utf-8" }],
]);

class HTTPError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Production management deployments require Cloudflare Access identity in addition
// to the edge Access policy, so the admin API fails closed if that policy is missing.
export async function handleAdminRequest(request, env, ctx) {
  if (env.ADMIN_ENABLED !== "true") return new Response("not found", { status: 404 });

  let actorID = "anonymous";
  if (env.ADMIN_ACCESS_REQUIRED === "true") {
    try {
      const identity = await ctx?.access?.getIdentity();
      if (typeof identity?.email !== "string" || !identity.email.trim()) {
        return new Response("access required", { status: 401 });
      }
      actorID = identity.email;
    } catch {
      return new Response("access required", { status: 401 });
    }
  }

  const url = new URL(request.url);
  try {
    if (url.pathname === "/admin" || url.pathname === "/admin/") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return await fetchAdminAsset(env, "/admin/index.html");
    }

    if (!url.pathname.startsWith("/admin/api/")) {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return await fetchAdminAsset(env, url.pathname);
    }

    if (url.pathname === "/admin/api/overview") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return jsonResponse(await readOverview(env));
    }

    if (url.pathname === "/admin/api/enrollment-codes") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      return await createEnrollmentCode(request, env, actorID);
    }

    if (url.pathname === "/admin/api/assets") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      return await uploadAsset(request, env, actorID);
    }

    const assetMatch = url.pathname.match(/^\/admin\/api\/assets\/([a-f0-9]{64})$/);
    if (assetMatch) {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return await readPlaylistAsset(assetMatch[1], env);
    }

    if (url.pathname === "/admin/api/playlists") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      return await createPlaylist(request, env, actorID);
    }

    const revisionMatch = url.pathname.match(/^\/admin\/api\/playlists\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/);
    if (revisionMatch) {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return await readPlaylistRevision(decodeURIComponent(revisionMatch[1]), decodeURIComponent(revisionMatch[2]), env);
    }

    const playlistMatch = url.pathname.match(/^\/admin\/api\/playlists\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/);
    if (playlistMatch) {
      if (request.method !== "DELETE") return methodNotAllowed("DELETE");
      return await deletePlaylist(decodeURIComponent(playlistMatch[1]), env, actorID);
    }

    if (url.pathname === "/admin/api/active-playlist") {
      if (request.method !== "PUT") return methodNotAllowed("PUT");
      return await activatePlaylist(request, env, actorID);
    }

    const rotateMatch = url.pathname.match(/^\/admin\/api\/devices\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/rotate$/);
    if (rotateMatch) {
      if (request.method !== "POST") return methodNotAllowed("POST");
      return await rotateDeviceCredential(request, decodeURIComponent(rotateMatch[1]), env, actorID);
    }

    const deviceMatch = url.pathname.match(/^\/admin\/api\/devices\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/);
    if (deviceMatch) {
      if (request.method !== "PATCH") return methodNotAllowed("PATCH");
      return await setDeviceEnabled(request, decodeURIComponent(deviceMatch[1]), env, actorID);
    }

    return jsonResponse({ error: "not found" }, 404);
  } catch (error) {
    if (error instanceof HTTPError) return jsonResponse({ error: error.message }, error.status);
    return jsonResponse({ error: "internal error" }, 500);
  }
}

async function fetchAdminAsset(env, pathname) {
  const file = ADMIN_FILES.get(pathname);
  if (!file) return new Response("not found", { status: 404 });
  const object = await env.ASSETS.get(file.key);
  if (!object) return new Response("management asset not found", { status: 404 });
  const headers = new Headers();
  headers.set("Content-Type", file.contentType);
  headers.set("Content-Length", String(object.size));
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  return new Response(object.body, { status: 200, headers });
}

async function readOverview(env) {
  const [devices, playlists, active, audit] = await Promise.all([
    env.DB.prepare(
      "SELECT device_id, enabled, created_at, last_seen_at FROM devices ORDER BY device_id",
    ).all(),
    env.DB.prepare(
      "SELECT p.playlist_id, p.revision, p.rotation_interval, p.created_at, " +
      "COUNT(pa.position) AS asset_count, " +
      "COUNT(*) OVER (PARTITION BY p.playlist_id) AS revision_count, " +
      "CASE WHEN ap.playlist_id = p.playlist_id AND ap.revision = p.revision THEN 1 ELSE 0 END AS active " +
      "FROM playlists p LEFT JOIN playlist_assets pa ON pa.playlist_id = p.playlist_id AND pa.revision = p.revision " +
      "LEFT JOIN active_playlist ap ON ap.singleton = 1 " +
      "GROUP BY p.playlist_id, p.revision " +
      "ORDER BY CASE WHEN ap.playlist_id = p.playlist_id AND ap.revision = p.revision THEN 0 ELSE 1 END, " +
      "p.created_at DESC LIMIT 100",
    ).all(),
    env.DB.prepare("SELECT playlist_id, revision FROM active_playlist WHERE singleton = 1").first(),
    env.DB.prepare(
      "SELECT event_id, actor_id, event_type, subject_type, subject_id, occurred_at, metadata_json " +
      "FROM audit_events ORDER BY occurred_at DESC LIMIT ?",
    ).bind(20).all(),
  ]);

  let missing = [];
  if (active) {
    const assets = await env.DB.prepare(
      "SELECT sha256, size FROM playlist_assets WHERE playlist_id = ? AND revision = ? ORDER BY position",
    ).bind(active.playlist_id, active.revision).all();
    missing = await Promise.all((assets.results ?? []).map(async (asset) => {
      const object = await env.ASSETS.head("assets/" + asset.sha256);
      if (object && object.size === asset.size) return null;
      return { sha256: asset.sha256, expected_size: asset.size, actual_size: object?.size ?? null };
    }));
    missing = missing.filter(Boolean);
  }

  return {
    environment: env.ADMIN_ACCESS_REQUIRED === "true" ? "production" : "development",
    devices: devices.results ?? [],
    playlists: playlists.results ?? [],
    active_playlist: active,
    asset_health: { missing },
    audit: (audit.results ?? []).map((event) => ({
      event_id: event.event_id,
      actor_id: event.actor_id,
      event_type: event.event_type,
      subject_type: event.subject_type,
      subject_id: event.subject_id,
      occurred_at: event.occurred_at,
      metadata: parseMetadata(event.metadata_json),
    })),
  };
}

async function createEnrollmentCode(request, env, actorID) {
  const data = await readJSON(request);
  if (!hasExactKeys(data, ["expires_in_minutes"]) || !Number.isSafeInteger(data.expires_in_minutes) ||
      data.expires_in_minutes < 1 || data.expires_in_minutes > 1440) {
    throw new HTTPError(400, "expires_in_minutes must be an integer from 1 to 1440");
  }
  const code = randomToken();
  const expiresAt = Date.now() + data.expires_in_minutes * 60_000;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO enrollments (code_hash, expires_at) VALUES (?, ?)")
      .bind(await sha256Hex(code), expiresAt),
    auditStatement(env, actorID, "enrollment_code.created", "enrollment", "new", { expires_at: expiresAt }),
  ]);
  return jsonResponse({ code, expires_at: expiresAt }, 201);
}

async function uploadAsset(request, env, actorID) {
  if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "image/png") {
    throw new HTTPError(415, "Please choose a PNG image.");
  }
  const bytes = await readBytes(request, MAX_ASSET_BYTES);
  if (!isPNG(bytes)) throw new HTTPError(400, "That file does not look like a valid PNG image.");

  const sha256 = await sha256BytesHex(bytes);
  const key = "assets/" + sha256;
  const existing = await env.ASSETS.head(key);
  if (!existing || existing.size !== bytes.byteLength) {
    await env.ASSETS.put(key, bytes, { httpMetadata: { contentType: "image/png" } });
    await env.DB.batch([
      auditStatement(env, actorID, "asset.uploaded", "asset", sha256, { size: bytes.byteLength }),
    ]);
    return jsonResponse({ sha256, size: bytes.byteLength }, 201);
  }
  return jsonResponse({ sha256, size: bytes.byteLength }, 200);
}

async function readPlaylistAsset(sha256, env) {
  const reference = await env.DB.prepare(
    "SELECT 1 AS present FROM playlist_assets WHERE sha256 = ? LIMIT 1",
  ).bind(sha256).first();
  if (!reference) throw new HTTPError(404, "playlist image not found");
  const object = await env.ASSETS.get("assets/" + sha256);
  if (!object) throw new HTTPError(404, "playlist image not found");
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "Content-Length": String(object.size),
    "Content-Type": "image/png",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
  });
  return new Response(object.body, { status: 200, headers });
}

async function createPlaylist(request, env, actorID) {
  const data = await readJSON(request);
  if (!hasExactKeys(data, ["id", "rotation_interval", "assets"]) || !ID_PATTERN.test(data.id ?? "") ||
      !isValidPositiveDuration(data.rotation_interval) || !Array.isArray(data.assets) ||
      data.assets.length < 1 || data.assets.length > 256) {
    throw new HTTPError(400, "Add a playlist ID, a valid rotation interval and at least one image (up to 256).");
  }

  for (const asset of data.assets) {
    if (!hasExactKeys(asset, ["sha256", "size"]) || !DIGEST_PATTERN.test(asset.sha256 ?? "") ||
        !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > MAX_ASSET_BYTES) {
      throw new HTTPError(400, "One of the images in this playlist is not valid. Please review the selection.");
    }
    const object = await env.ASSETS.head("assets/" + asset.sha256);
    if (!object || object.size !== asset.size) {
      throw new HTTPError(409, "One of these images is no longer available. Upload it again before saving the playlist.");
    }
  }

  const revision = "r-" + crypto.randomUUID().replaceAll("-", "");
  const statements = [env.DB.prepare(
    "INSERT INTO playlists (playlist_id, revision, rotation_interval, created_at) VALUES (?, ?, ?, ?)",
  ).bind(data.id, revision, data.rotation_interval, Date.now())];
  for (const [position, asset] of data.assets.entries()) {
    statements.push(env.DB.prepare(
      "INSERT INTO playlist_assets (playlist_id, revision, position, sha256, size) VALUES (?, ?, ?, ?, ?)",
    ).bind(data.id, revision, position, asset.sha256, asset.size));
  }
  statements.push(auditStatement(env, actorID, "playlist.revision_created", "playlist", data.id, {
    revision,
    asset_count: data.assets.length,
  }));
  await env.DB.batch(statements);
  return jsonResponse({ id: data.id, revision, rotation_interval: data.rotation_interval, asset_count: data.assets.length }, 201);
}

async function readPlaylistRevision(playlistID, revision, env) {
  const playlist = await env.DB.prepare(
    "SELECT playlist_id, revision, rotation_interval FROM playlists WHERE playlist_id = ? AND revision = ?",
  ).bind(playlistID, revision).first();
  if (!playlist) throw new HTTPError(404, "That playlist revision could not be found.");
  const assets = await env.DB.prepare(
    "SELECT sha256, size FROM playlist_assets WHERE playlist_id = ? AND revision = ? ORDER BY position",
  ).bind(playlistID, revision).all();
  return jsonResponse({ ...playlist, assets: assets.results ?? [] });
}

async function activatePlaylist(request, env, actorID) {
  const data = await readJSON(request);
  if (!hasExactKeys(data, ["playlist_id", "revision"]) || !ID_PATTERN.test(data.playlist_id ?? "") ||
      !ID_PATTERN.test(data.revision ?? "")) {
    throw new HTTPError(400, "playlist_id and revision are required");
  }
  const playlist = await env.DB.prepare(
    "SELECT playlist_id, revision FROM playlists WHERE playlist_id = ? AND revision = ?",
  ).bind(data.playlist_id, data.revision).first();
  if (!playlist) throw new HTTPError(404, "playlist revision not found");

  const previous = await env.DB.prepare(
    "SELECT playlist_id, revision FROM active_playlist WHERE singleton = 1",
  ).first();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO active_playlist (singleton, playlist_id, revision) VALUES (1, ?, ?) " +
      "ON CONFLICT(singleton) DO UPDATE SET playlist_id = excluded.playlist_id, revision = excluded.revision",
    ).bind(data.playlist_id, data.revision),
    auditStatement(env, actorID, "playlist.activated", "playlist", data.playlist_id, {
      revision: data.revision,
      previous,
    }),
  ]);
  return jsonResponse({ active_playlist: { playlist_id: data.playlist_id, revision: data.revision } });
}

async function deletePlaylist(playlistID, env, actorID) {
  const revisions = await env.DB.prepare(
    "SELECT revision FROM playlists WHERE playlist_id = ?",
  ).bind(playlistID).all();
  if (!revisions.results?.length) throw new HTTPError(404, "That playlist could not be found.");

  const active = await env.DB.prepare(
    "SELECT playlist_id, revision FROM active_playlist WHERE singleton = 1",
  ).first();
  if (active?.playlist_id === playlistID) {
    throw new HTTPError(409, "Please activate another playlist before deleting this one.");
  }

  const activeGuard = "NOT EXISTS (SELECT 1 FROM active_playlist WHERE singleton = 1 AND playlist_id = ?)";
  const results = await env.DB.batch([
    env.DB.prepare(`DELETE FROM playlist_assets WHERE playlist_id = ? AND ${activeGuard}`)
      .bind(playlistID, playlistID),
    env.DB.prepare(`DELETE FROM playlists WHERE playlist_id = ? AND ${activeGuard}`)
      .bind(playlistID, playlistID),
    auditStatement(env, actorID, "playlist.deleted", "playlist", playlistID, {
      revision_count: revisions.results.length,
    }, { onlyWhenPreviousChanged: true }),
  ]);
  const deletedRevisions = results?.[1]?.meta?.changes ?? 0;
  if (!deletedRevisions) {
    const current = await env.DB.prepare(
      "SELECT playlist_id, revision FROM active_playlist WHERE singleton = 1",
    ).first();
    if (current?.playlist_id === playlistID) {
      throw new HTTPError(409, "Please activate another playlist before deleting this one.");
    }
    throw new HTTPError(404, "That playlist could not be found.");
  }

  return jsonResponse({ playlist_id: playlistID, deleted_revisions: deletedRevisions });
}

async function setDeviceEnabled(request, deviceID, env, actorID) {
  const data = await readJSON(request);
  if (!hasExactKeys(data, ["enabled"]) || typeof data.enabled !== "boolean") {
    throw new HTTPError(400, "enabled must be a boolean");
  }
  const device = await env.DB.prepare("SELECT device_id FROM devices WHERE device_id = ?").bind(deviceID).first();
  if (!device) throw new HTTPError(404, "device not found");
  await env.DB.batch([
    env.DB.prepare("UPDATE devices SET enabled = ? WHERE device_id = ?").bind(data.enabled ? 1 : 0, deviceID),
    auditStatement(env, actorID, data.enabled ? "device.enabled" : "device.disabled", "device", deviceID, {}),
  ]);
  return jsonResponse({ device_id: deviceID, enabled: data.enabled });
}

async function rotateDeviceCredential(request, deviceID, env, actorID) {
  const data = await readJSON(request);
  if (!hasExactKeys(data, [])) throw new HTTPError(400, "request body must be an empty JSON object");
  const device = await env.DB.prepare("SELECT device_id FROM devices WHERE device_id = ?").bind(deviceID).first();
  if (!device) throw new HTTPError(404, "device not found");
  const deviceToken = randomToken();
  await env.DB.batch([
    env.DB.prepare("UPDATE devices SET token_hash = ? WHERE device_id = ?")
      .bind(await sha256Hex(deviceToken), deviceID),
    auditStatement(env, actorID, "device.credential_rotated", "device", deviceID, {}),
  ]);
  return jsonResponse({ device_token: deviceToken });
}

function auditStatement(env, actorID, eventType, subjectType, subjectID, metadata, { onlyWhenPreviousChanged = false } = {}) {
  const insert = onlyWhenPreviousChanged
    ? "SELECT ?, ?, ?, ?, ?, ?, ? WHERE changes() > 0"
    : "VALUES (?, ?, ?, ?, ?, ?, ?)";
  return env.DB.prepare(
    "INSERT INTO audit_events (event_id, actor_id, event_type, subject_type, subject_id, occurred_at, metadata_json) " +
    insert,
  ).bind(crypto.randomUUID(), actorID, eventType, subjectType, subjectID, Date.now(), JSON.stringify(metadata));
}

async function readJSON(request) {
  if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new HTTPError(415, "Content-Type must be application/json");
  }
  const bytes = await readBytes(request, MAX_JSON_BYTES);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HTTPError(400, "request body must be valid JSON");
  }
}

async function readBytes(request, maximum) {
  const reader = request.body?.getReader();
  if (!reader) throw new HTTPError(400, "request body is required");
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new HTTPError(413, "request body exceeds size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function isPNG(bytes) {
  if (bytes.byteLength < 45 || !PNG_SIGNATURE.every((value, index) => bytes[index] === value) ||
      String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR") return false;
  const width = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(16);
  const height = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(20);
  return width > 0 && height > 0 && String.fromCharCode(...bytes.slice(-8, -4)) === "IEND";
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value) {
  return sha256BytesHex(new TextEncoder().encode(value));
}

async function sha256BytesHex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function hasExactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function parseMetadata(value) {
  try { return JSON.parse(value); } catch { return {}; }
}

function methodNotAllowed(allowed) {
  return new Response("method not allowed", { status: 405, headers: { Allow: allowed } });
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Cache-Control": "private, no-store, no-transform",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
