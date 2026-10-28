import { isValidPositiveDuration } from "./duration.js";
import { handleAdminRequest } from "./admin.js";
import { cleanupExpiredCaptures, dispatchDueCaptures, handleCaptureQueue } from "./capture-workflow.js";

const MAX_ENROLLMENT_BYTES = 4 << 10;
const MAX_ASSET_BYTES = 32 << 20;
const ENROLLMENT_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
const SIGNATURE_CLOCK_SKEW_MS = 5 * 60 * 1000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

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
  queue(batch, env) {
    return queueHandler(batch, env);
  },
  scheduled(controller, env) {
    return scheduledHandler(controller, env);
  },
};

export async function queueHandler(batch, env) {
  return handleCaptureQueue(batch, env);
}

export async function scheduledHandler(controller, env) {
  const now = Number.isSafeInteger(controller?.scheduledTime) ? controller.scheduledTime : Date.now();
  const [dispatch, cleanup] = await Promise.all([
    dispatchDueCaptures(env, now),
    cleanupExpiredCaptures(env, now),
  ]);
  return { ...dispatch, cleaned_targets: cleanup };
}

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

    if (url.pathname === "/v1/enrollment-requests") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      return await requestDeviceEnrollment(request, env);
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
      const captureAssigned = assigned ? null : await env.DB.prepare(
        "SELECT CASE WHEN t.current_sha256 = ? AND t.last_success_at >= ? THEN t.current_size ELSE t.placeholder_size END AS size " +
        "FROM playlist_capture_items p " +
        "JOIN active_playlist ap ON ap.playlist_id = p.playlist_id AND ap.revision = p.revision " +
        "JOIN capture_targets t ON t.capture_id = p.capture_id " +
        "WHERE ap.singleton = 1 AND (" +
        "(t.current_sha256 = ? AND t.last_success_at >= ?) OR " +
        "(t.placeholder_sha256 = ? AND (t.current_sha256 IS NULL OR t.last_success_at < ?))) LIMIT 1",
      ).bind(digest, Date.now() - 30 * 24 * 60 * 60 * 1000, digest,
        Date.now() - 30 * 24 * 60 * 60 * 1000, digest, Date.now() - 30 * 24 * 60 * 60 * 1000).first();
      if (!assigned && !captureAssigned) throw new HTTPError(403, "asset is not assigned to the active playlist");
      const object = await env.ASSETS.get(`assets/${digest}`);
      if (!object) throw new HTTPError(404, "asset not found");
      if (object.size !== (assigned?.size ?? captureAssigned.size) || object.size > MAX_ASSET_BYTES) {
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

async function requestDeviceEnrollment(request, env) {
  const rateLimiter = env.ENROLLMENT_RATE_LIMITER;
  if (rateLimiter) {
    const ipAddress = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const { success } = await rateLimiter.limit({ key: ipAddress });
    if (!success) throw new HTTPError(429, "too many enrollment requests; retry later");
  }

  const { data, bodyBytes } = await readJSONBody(request, MAX_ENROLLMENT_BYTES);
  if (!hasExactKeys(data, ["device_id", "public_key"]) ||
      !ID_PATTERN.test(data.device_id ?? "") || !PUBLIC_KEY_PATTERN.test(data.public_key ?? "")) {
    throw new HTTPError(400, "invalid enrollment request");
  }
  const publicKeyBytes = decodeBase64Url(data.public_key);
  if (publicKeyBytes.byteLength !== 32 || encodeBase64Url(publicKeyBytes) !== data.public_key) {
    throw new HTTPError(400, "invalid enrollment public key");
  }
  if (!await verifyDeviceSignature(request, data.device_id, data.public_key, bodyBytes)) {
    throw new HTTPError(401, "device enrollment proof failed");
  }

  const requestID = await sha256HexBytes(publicKeyBytes);
  const fingerprint = formatFingerprint(requestID);
  const now = Date.now();
  const existingDevice = await env.DB.prepare(
    "SELECT device_id, public_key, enabled FROM devices WHERE device_id = ?",
  ).bind(data.device_id).first();
  if (existingDevice?.public_key === data.public_key) {
    return jsonResponse({
      status: existingDevice.enabled === 1 ? "approved" : "disabled",
      fingerprint,
      request_id: requestID,
      expires_at: null,
      replaces_existing: false,
    });
  }

  await env.DB.prepare("DELETE FROM enrollment_requests WHERE expires_at <= ?").bind(now).run();
  const existingRequest = await env.DB.prepare(
    "SELECT request_id, device_id, public_key, fingerprint, created_at, last_seen_at, expires_at, status " +
    "FROM enrollment_requests WHERE request_id = ?",
  ).bind(requestID).first();
  if (existingRequest && (existingRequest.device_id !== data.device_id || existingRequest.public_key !== data.public_key)) {
    throw new HTTPError(409, "enrollment request identity conflict");
  }

  await env.DB.prepare(
    `INSERT INTO enrollment_requests
       (request_id, device_id, public_key, fingerprint, created_at, last_seen_at, expires_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
     ON CONFLICT(request_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
     WHERE enrollment_requests.status = 'pending'
       AND enrollment_requests.device_id = excluded.device_id
       AND enrollment_requests.public_key = excluded.public_key`,
  ).bind(requestID, data.device_id, data.public_key, fingerprint, now, now, now + ENROLLMENT_REQUEST_TTL_MS).run();

  const current = await env.DB.prepare(
    "SELECT request_id, device_id, public_key, fingerprint, created_at, last_seen_at, expires_at, status " +
    "FROM enrollment_requests WHERE request_id = ?",
  ).bind(requestID).first();
  if (!current || current.device_id !== data.device_id || current.public_key !== data.public_key) {
    throw new HTTPError(409, "enrollment request is no longer active");
  }
  if (current.status === "approved") {
    throw new HTTPError(409, "enrollment request was superseded by another device credential");
  }
  return jsonResponse({
    status: current.status,
    fingerprint,
    request_id: requestID,
    expires_at: current.expires_at,
    replaces_existing: Boolean(existingDevice),
  });
}

async function authenticate(request, env, deviceID) {
  if (!ID_PATTERN.test(deviceID)) throw new HTTPError(401, "device authentication failed");
  const device = await env.DB.prepare(
    "SELECT device_id, token_hash, public_key, enabled FROM devices WHERE device_id = ?",
  ).bind(deviceID).first();
  if (!device || device.enabled !== 1) {
    throw new HTTPError(401, "device authentication failed");
  }

  if (typeof device.public_key === "string" && device.public_key) {
    if (!await verifyDeviceSignature(request, deviceID, device.public_key, new Uint8Array())) {
      throw new HTTPError(401, "device authentication failed");
    }
    return device;
  }

  const authorization = request.headers.get("Authorization") ?? "";
  const match = authorization.match(/^Bearer ([A-Za-z0-9_-]{32,256})$/);
  if (!match) throw new HTTPError(401, "device authentication failed");
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
  const [assetResult, captureResult] = await Promise.all([
    env.DB.prepare(
      "SELECT position, sha256, size FROM playlist_assets WHERE playlist_id = ? AND revision = ? ORDER BY position",
    ).bind(active.playlist_id, active.revision).all(),
    env.DB.prepare(
      "SELECT p.position, " +
      "CASE WHEN t.current_sha256 IS NOT NULL AND t.last_success_at >= ? THEN t.current_sha256 ELSE t.placeholder_sha256 END AS sha256, " +
      "CASE WHEN t.current_size IS NOT NULL AND t.last_success_at >= ? THEN t.current_size ELSE t.placeholder_size END AS size " +
      "FROM playlist_capture_items p JOIN capture_targets t ON t.capture_id = p.capture_id " +
      "WHERE p.playlist_id = ? AND p.revision = ? ORDER BY p.position",
    ).bind(Date.now() - 30 * 24 * 60 * 60 * 1000, Date.now() - 30 * 24 * 60 * 60 * 1000,
      active.playlist_id, active.revision).all(),
  ]);
  const orderedAssets = [
    ...(assetResult.results ?? []).map((asset, index) => ({ position: Number.isSafeInteger(asset.position) ? asset.position : index, sha256: asset.sha256, size: asset.size })),
    ...(captureResult.results ?? []).map((asset) => ({ position: asset.position, sha256: asset.sha256, size: asset.size })),
  ].sort((left, right) => left.position - right.position);
  const hasCaptures = (captureResult.results ?? []).length > 0;
  const resolvedRevision = hasCaptures
    ? (await sha256Hex(`${playlistRow.revision}\n${orderedAssets.map(({ sha256, size }) => `${sha256}:${size}`).join("\n")}`)).slice(0, 64)
    : playlistRow.revision;
  const playlist = {
    version: 2,
    revision: resolvedRevision,
    id: playlistRow.playlist_id,
    rotation_interval: playlistRow.rotation_interval,
    assets: orderedAssets.map(({ sha256, size }) => ({ sha256, size })),
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
  return (await readJSONBody(request, maxBytes)).data;
}

async function readJSONBody(request, maxBytes) {
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
    return { data: JSON.parse(new TextDecoder().decode(bytes)), bodyBytes: bytes };
  } catch {
    throw new HTTPError(400, "request body must be valid JSON");
  }
}

async function verifyDeviceSignature(request, deviceID, publicKey, bodyBytes) {
  const timestamp = request.headers.get("X-Ribbonfish-Timestamp") ?? "";
  if (!/^\d{13}$/.test(timestamp)) return false;
  const timestampValue = Number(timestamp);
  if (!Number.isSafeInteger(timestampValue) || Math.abs(Date.now() - timestampValue) > SIGNATURE_CLOCK_SKEW_MS) return false;

  const signatureText = request.headers.get("X-Ribbonfish-Signature") ?? "";
  if (!/^[A-Za-z0-9_-]{86}$/.test(signatureText)) return false;
  const signature = decodeBase64Url(signatureText);
  const publicKeyBytes = decodeBase64Url(publicKey);
  if (signature.byteLength !== 64 || publicKeyBytes.byteLength !== 32) return false;

  try {
    const key = await crypto.subtle.importKey("raw", publicKeyBytes, { name: "Ed25519" }, false, ["verify"]);
    const url = new URL(request.url);
    const target = url.pathname + url.search;
    const bodyHash = await sha256HexBytes(bodyBytes);
    const payload = [
      "ribbonfish-device-v1",
      request.method,
      target,
      deviceID,
      timestamp,
      request.headers.get("If-None-Match") ?? "",
      bodyHash,
    ].join("\n");
    return await crypto.subtle.verify("Ed25519", key, signature, new TextEncoder().encode(payload));
  } catch {
    return false;
  }
}

function decodeBase64Url(value) {
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return new Uint8Array();
  }
}

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function formatFingerprint(requestID) {
  return requestID.slice(0, 32).match(/.{4}/g).join("-");
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  return sha256HexBytes(bytes);
}

async function sha256HexBytes(bytes) {
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
