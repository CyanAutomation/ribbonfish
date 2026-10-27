import { isValidPositiveDuration } from "./duration.js";
import { handleAdminRequest } from "./admin.js";

const MAX_ENROLLMENT_BYTES = 4 << 10;
const MAX_ASSET_BYTES = 32 << 20;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

class HTTPError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export default {
  fetch(request, env, ctx) {
    return fetchHandler(request, env, ctx);
  },
};

export async function fetchHandler(request, env, ctx) {
  const url = new URL(request.url);
  try {
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) {
      return await handleAdminRequest(request, env, ctx);
    }

    if (url.pathname === "/healthz") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return await healthCheck(env);
    }

    if (url.pathname === "/v1/enroll") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      return await enroll(request, env);
    }

    if (url.pathname === "/v2/playlist") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      const deviceID = request.headers.get("X-Ribbonfish-Device-ID") ?? "";
      await authenticate(request, env, deviceID);
      await updateLastSeen(env, deviceID, ctx);
      const { playlist, etag } = await readActivePlaylist(env);
      if (matchesETag(request.headers.get("If-None-Match"), etag)) {
        return new Response(null, { status: 304, headers: privateHeaders({ ETag: etag }) });
      }
      return jsonResponse(playlist, 200, { ETag: etag });
    }

    const assetMatch = url.pathname.match(/^\/v2\/assets\/([a-f0-9]{64})$/);
    if (assetMatch) {
      if (request.method !== "GET") return methodNotAllowed("GET");
      const digest = assetMatch[1];
      const deviceID = request.headers.get("X-Ribbonfish-Device-ID") ?? "";
      await authenticate(request, env, deviceID);
      const assigned = await env.DB.prepare(
        `SELECT pa.size FROM playlist_assets pa
         JOIN active_playlist ap ON ap.playlist_id = pa.playlist_id AND ap.revision = pa.revision
         WHERE pa.sha256 = ? AND ap.singleton = 1 LIMIT 1`,
      ).bind(digest).first();
      if (!assigned) throw new HTTPError(403, "asset is not assigned to the active playlist");
      const object = await env.ASSETS.get(`assets/${digest}`);
      if (!object) throw new HTTPError(404, "asset not found");
      if (object.size !== assigned.size || object.size > MAX_ASSET_BYTES) {
        throw new HTTPError(502, "stored asset metadata does not match the playlist");
      }
      const headers = privateHeaders({
        "Content-Type": "application/octet-stream",
        "Content-Length": String(object.size),
        "X-Content-Type-Options": "nosniff",
      });
      if (object.httpEtag) headers.set("ETag", object.httpEtag);
      return new Response(object.body, { status: 200, headers });
    }

    return new Response("not found", { status: 404, headers: privateHeaders() });
  } catch (error) {
    if (error instanceof HTTPError) {
      return jsonResponse({ error: error.message }, error.status);
    }
    return jsonResponse({ error: "internal error" }, 500);
  }
}

function updateLastSeen(env, deviceID, ctx) {
  const update = Promise.resolve()
    .then(() => env.DB.prepare("UPDATE devices SET last_seen_at = ? WHERE device_id = ? AND enabled = 1")
      .bind(Date.now(), deviceID).run())
    .catch(() => {});
  if (ctx?.waitUntil) {
    ctx.waitUntil(update);
    return;
  }
  return update;
}

async function healthCheck(env) {
  try {
    const { playlist } = await readActivePlaylist(env);
    for (const asset of playlist.assets) {
      const object = await env.ASSETS.head(`assets/${asset.sha256}`);
      if (!object || object.size !== asset.size) {
        return jsonResponse({ status: "degraded" }, 503);
      }
    }
    return jsonResponse({ status: "ok" });
  } catch {
    return jsonResponse({ status: "degraded" }, 503);
  }
}

async function enroll(request, env) {
  const data = await readJSON(request, MAX_ENROLLMENT_BYTES);
  if (!hasExactKeys(data, ["device_id", "enrollment_code"]) ||
      !ID_PATTERN.test(data.device_id ?? "") || typeof data.enrollment_code !== "string" ||
      data.enrollment_code.length < 8 || data.enrollment_code.length > 512) {
    throw new HTTPError(400, "invalid enrollment request");
  }

  const now = Date.now();
  const codeHash = await sha256Hex(data.enrollment_code);
  const enrollment = await env.DB.prepare(
    "SELECT code_hash, expires_at, consumed_at FROM enrollments WHERE code_hash = ?",
  ).bind(codeHash).first();
  if (!enrollment || enrollment.consumed_at !== null || enrollment.expires_at <= now) {
    throw new HTTPError(401, "enrollment code is invalid or expired");
  }
  const existing = await env.DB.prepare(
    "SELECT device_id FROM devices WHERE device_id = ?",
  ).bind(data.device_id).first();
  if (existing) throw new HTTPError(409, "device is already enrolled");

  const token = randomToken();
  const claimID = randomToken();
  const tokenHash = await sha256Hex(token);
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE enrollments SET consumed_at = ?, claim_id = ?
       WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?
         AND NOT EXISTS (SELECT 1 FROM devices WHERE device_id = ?)`,
    ).bind(now, claimID, codeHash, now, data.device_id),
    env.DB.prepare(
      `INSERT INTO devices (device_id, token_hash, enabled, created_at)
       SELECT ?, ?, 1, ?
       WHERE EXISTS (
         SELECT 1 FROM enrollments WHERE code_hash = ? AND consumed_at = ? AND claim_id = ?
       ) AND NOT EXISTS (SELECT 1 FROM devices WHERE device_id = ?)`,
    ).bind(data.device_id, tokenHash, now, codeHash, now, claimID, data.device_id),
  ]);
  if (results[0]?.meta?.changes !== 1 || results[1]?.meta?.changes !== 1) {
    const existingAfterClaim = await env.DB.prepare(
      "SELECT device_id FROM devices WHERE device_id = ?",
    ).bind(data.device_id).first();
    if (existingAfterClaim) throw new HTTPError(409, "device is already enrolled");
    throw new HTTPError(401, "enrollment code is invalid or expired");
  }
  return jsonResponse({ device_token: token }, 201);
}

async function authenticate(request, env, deviceID) {
  if (!ID_PATTERN.test(deviceID)) throw new HTTPError(401, "device authentication failed");
  const authorization = request.headers.get("Authorization") ?? "";
  const match = authorization.match(/^Bearer ([A-Za-z0-9_-]{32,256})$/);
  if (!match) throw new HTTPError(401, "device authentication failed");
  const device = await env.DB.prepare(
    "SELECT device_id, token_hash, enabled FROM devices WHERE device_id = ?",
  ).bind(deviceID).first();
  if (!device || device.enabled !== 1) {
    throw new HTTPError(401, "device authentication failed");
  }
  const presentedHash = await sha256Hex(match[1]);
  if (!constantTimeEqual(presentedHash, device.token_hash)) {
    throw new HTTPError(401, "device authentication failed");
  }
  return device;
}

async function readActivePlaylist(env) {
  const active = await env.DB.prepare(
    "SELECT playlist_id, revision FROM active_playlist WHERE singleton = 1",
  ).first();
  if (!active || !ID_PATTERN.test(active.playlist_id ?? "") || !ID_PATTERN.test(active.revision ?? "")) {
    throw new HTTPError(503, "no active playlist is configured");
  }
  const playlistRow = await env.DB.prepare(
    "SELECT playlist_id, revision, rotation_interval FROM playlists WHERE playlist_id = ? AND revision = ?",
  ).bind(active.playlist_id, active.revision).first();
  if (!playlistRow) throw new HTTPError(502, "active playlist is missing");
  const assetResult = await env.DB.prepare(
    "SELECT sha256, size FROM playlist_assets WHERE playlist_id = ? AND revision = ? ORDER BY position",
  ).bind(active.playlist_id, active.revision).all();
  const playlist = {
    version: 2,
    revision: active.revision,
    id: playlistRow.playlist_id,
    rotation_interval: playlistRow.rotation_interval,
    assets: assetResult.results,
  };
  try {
    validatePlaylist(playlist);
  } catch {
    throw new HTTPError(502, "stored active playlist is invalid");
  }
  return { playlist, etag: `"${playlist.revision}"` };
}

function validatePlaylist(playlist) {
  if (!hasExactKeys(playlist, ["version", "revision", "id", "rotation_interval", "assets"]) ||
      playlist.version !== 2 || !ID_PATTERN.test(playlist.revision ?? "") ||
      !ID_PATTERN.test(playlist.id ?? "") || !isValidPositiveDuration(playlist.rotation_interval) ||
      !Array.isArray(playlist.assets) || playlist.assets.length < 1 || playlist.assets.length > 256) {
    throw new Error("invalid playlist envelope");
  }
  for (const asset of playlist.assets) {
    if (!hasExactKeys(asset, ["sha256", "size"]) || !DIGEST_PATTERN.test(asset.sha256 ?? "") ||
        !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > MAX_ASSET_BYTES) {
      throw new Error("invalid asset reference");
    }
  }
}

async function readJSON(request, maxBytes) {
  const reader = request.body?.getReader();
  if (!reader) throw new HTTPError(400, "request body is required");
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new HTTPError(413, "request body exceeds size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HTTPError(400, "request body must be valid JSON");
  }
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left, right) {
  if (typeof right !== "string" || left.length !== right.length) return false;
  let result = 0;
  for (let i = 0; i < left.length; i++) result |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return result === 0;
}

function matchesETag(header, etag) {
  return (header ?? "").split(",").map((value) => value.trim()).some((value) => value === "*" || value === etag);
}

function hasExactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function methodNotAllowed(allowed) {
  return new Response("method not allowed", { status: 405, headers: privateHeaders({ Allow: allowed }) });
}

function jsonResponse(value, status, extraHeaders = {}) {
  const headers = privateHeaders({ "Content-Type": "application/json; charset=utf-8", ...extraHeaders });
  return new Response(JSON.stringify(value), { status, headers });
}

function privateHeaders(values = {}) {
  const headers = new Headers(values);
  headers.set("Cache-Control", "private, no-store, no-transform");
  headers.set("X-Content-Type-Options", "nosniff");
  return headers;
}
