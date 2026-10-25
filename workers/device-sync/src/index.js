const MAX_MANIFEST_BYTES = 1 << 20;
const MAX_ENROLLMENT_BYTES = 4 << 10;
const MAX_ASSET_BYTES = 32 << 20;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const DURATION_PATTERN = /^(?:[0-9]+(?:\.[0-9]+)?(?:ns|us|µs|ms|s|m|h))+$/;

class HTTPError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export default {
  fetch(request, env) {
    return fetchHandler(request, env);
  },
};

export async function fetchHandler(request, env) {
  const url = new URL(request.url);
  try {
    if (url.pathname === "/v1/enroll") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      return await enroll(request, env);
    }

    const manifestMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/manifest$/);
    if (manifestMatch) {
      if (request.method !== "GET") return methodNotAllowed("GET");
      const deviceID = decodeURIComponent(manifestMatch[1]);
      const device = await authenticate(request, env, deviceID);
      const { manifest, etag } = await readAssignedManifest(env, device);
      if (matchesETag(request.headers.get("If-None-Match"), etag)) {
        return new Response(null, { status: 304, headers: privateHeaders({ ETag: etag }) });
      }
      return jsonResponse(manifest, 200, { ETag: etag });
    }

    const assetMatch = url.pathname.match(/^\/v1\/assets\/([a-f0-9]{64})$/);
    if (assetMatch) {
      if (request.method !== "GET") return methodNotAllowed("GET");
      const digest = assetMatch[1];
      const deviceID = request.headers.get("X-Ribbonfish-Device-ID") ?? "";
      const device = await authenticate(request, env, deviceID);
      const { manifest } = await readAssignedManifest(env, device);
      const assigned = manifest.playlists.flatMap((playlist) => playlist.assets)
        .find((asset) => asset.sha256 === digest);
      if (!assigned) throw new HTTPError(403, "asset is not assigned to this device");
      const object = await env.ASSETS.get(`assets/${digest}`);
      if (!object) throw new HTTPError(404, "asset not found");
      if (object.size !== assigned.size || object.size > MAX_ASSET_BYTES) {
        throw new HTTPError(502, "stored asset metadata does not match the manifest");
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
      `INSERT INTO devices (device_id, token_hash, manifest_key, enabled, created_at)
       SELECT ?, ?, ?, 1, ?
       WHERE EXISTS (
         SELECT 1 FROM enrollments WHERE code_hash = ? AND consumed_at = ? AND claim_id = ?
       ) AND NOT EXISTS (SELECT 1 FROM devices WHERE device_id = ?)`,
    ).bind(data.device_id, tokenHash, manifestKey(data.device_id), now, codeHash, now, claimID, data.device_id),
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
    "SELECT device_id, token_hash, manifest_key, enabled FROM devices WHERE device_id = ?",
  ).bind(deviceID).first();
  if (!device || device.enabled !== 1 || device.manifest_key !== manifestKey(deviceID)) {
    throw new HTTPError(401, "device authentication failed");
  }
  const presentedHash = await sha256Hex(match[1]);
  if (!constantTimeEqual(presentedHash, device.token_hash)) {
    throw new HTTPError(401, "device authentication failed");
  }
  return device;
}

async function readAssignedManifest(env, device) {
  const object = await env.ASSETS.get(device.manifest_key);
  if (!object) throw new HTTPError(404, "manifest not found");
  if (object.size > MAX_MANIFEST_BYTES) throw new HTTPError(502, "manifest exceeds size limit");
  let manifest;
  try {
    manifest = JSON.parse(await object.text());
    validateManifest(manifest);
  } catch {
    throw new HTTPError(502, "stored manifest is invalid");
  }
  return { manifest, etag: `"${manifest.revision}"` };
}

function validateManifest(manifest) {
  if (!hasExactKeys(manifest, ["version", "revision", "playlists", "displays"]) ||
      manifest.version !== 1 || !ID_PATTERN.test(manifest.revision ?? "") ||
      !Array.isArray(manifest.playlists) || manifest.playlists.length < 1 || manifest.playlists.length > 64 ||
      !Array.isArray(manifest.displays) || manifest.displays.length < 1 || manifest.displays.length > 16) {
    throw new Error("invalid manifest envelope");
  }
  const playlistIDs = new Set();
  for (const playlist of manifest.playlists) {
    if (!hasExactKeys(playlist, ["id", "assets"]) || !ID_PATTERN.test(playlist.id ?? "") ||
        playlistIDs.has(playlist.id) || !Array.isArray(playlist.assets) ||
        playlist.assets.length < 1 || playlist.assets.length > 256) {
      throw new Error("invalid playlist");
    }
    playlistIDs.add(playlist.id);
    for (const asset of playlist.assets) {
      if (!hasExactKeys(asset, ["sha256", "size"]) || !DIGEST_PATTERN.test(asset.sha256 ?? "") ||
          !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > MAX_ASSET_BYTES) {
        throw new Error("invalid asset reference");
      }
    }
  }
  const displayIDs = new Set();
  for (const display of manifest.displays) {
    if (!hasExactKeys(display, ["id", "playlist_id", "rotation_interval"]) ||
        !ID_PATTERN.test(display.id ?? "") || displayIDs.has(display.id) ||
        !playlistIDs.has(display.playlist_id) || typeof display.rotation_interval !== "string" ||
        !DURATION_PATTERN.test(display.rotation_interval) || !/[1-9]/.test(display.rotation_interval)) {
      throw new Error("invalid display assignment");
    }
    displayIDs.add(display.id);
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

function manifestKey(deviceID) {
  return `devices/${deviceID}/manifest.json`;
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
