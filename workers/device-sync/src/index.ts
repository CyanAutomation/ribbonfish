import { jsonResponse, privateHeaders } from "./http-response.ts";
import { validatePlaylist } from "./playlist-validation.ts";
import { verifyDeviceSignature, decodeBase64Url, encodeBase64Url, equalSha256Digests } from "./device-signature.ts";
import { matchesETag } from "./http-cache.ts";
import { readRequestBody, parseJSONBody } from "./request-body.ts";
import { randomToken, sha256Hex, sha256HexBytes } from "./crypto-primitives.ts";
export { sha256Hex } from "./crypto-primitives.ts";
import { HTTPError } from "./http-error.ts";
import { hasExactKeys, isString } from "./validation.ts";
import { assessUpcomingCaptures } from "./capture-intelligence.ts";
import { handleAdminRequest } from "./admin.ts";
import { CAPTURE_DEAD_LETTER_QUEUE_NAME, cleanupExpiredCaptures, dispatchCaptureRetries, dispatchDueCaptures,
  handleCaptureDeadLetterQueue, handleCaptureQueue, recoverStaleCaptureJobs } from "./capture-workflow.ts";
import { reconcileAssets } from "./asset-maintenance.ts";
import { cleanupDeviceHealth, persistDeviceHealth, refreshDeviceHealthStatuses, validateDeviceHealthReport } from "./device-health.ts";
import type {
  ActivePlaylistRow,
  AssignedAssetRow,
  CaptureQueueBatch,
  DeviceCredentialRow,
  EnrollmentRequestRow,
  EnrollmentRow,
  PlaylistAssetRow,
  WorkerEnvironment,
  WorkerExecutionContext,
  WorkerScheduledController,
} from "./worker-contracts.ts";

type ActivePlaylist = {
  version: 2;
  revision: string;
  id: string;
  rotation_interval: number;
  assets: Array<Pick<PlaylistAssetRow, "sha256" | "size">>;
};
type PlaylistReadResult =
  | { playlist: ActivePlaylist; etag: string; notModified: false }
  | { playlist?: undefined; etag: string; notModified: true };

const MAX_ENROLLMENT_BYTES = 4 << 10;
const MAX_TELEMETRY_BYTES = 8 << 10;
const MAX_ASSET_BYTES = 32 << 20;
const ENROLLMENT_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
const LAST_SEEN_WRITE_INTERVAL_MS = 5 * 60 * 1000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const worker = {
  fetch(request, env, ctx) {
    return fetchHandler(request, env, ctx);
  },
  queue(batch, env) {
    return queueHandler(batch, env);
  },
  async scheduled(controller, env) {
    await scheduledHandler(controller, env);
  },
} satisfies ExportedHandler<WorkerEnvironment, { job_id?: unknown }>;

export default worker;

export async function queueHandler(batch: CaptureQueueBatch, env: WorkerEnvironment) {
  if (batch.queue === CAPTURE_DEAD_LETTER_QUEUE_NAME) return handleCaptureDeadLetterQueue(batch, env);
  return handleCaptureQueue(batch, env);
}

export async function scheduledHandler(controller: WorkerScheduledController, env: WorkerEnvironment) {
  const now = Number.isSafeInteger(controller?.scheduledTime) ? controller.scheduledTime : Date.now();
  const cleanHealth = new Date(now).getUTCMinutes() === 0;
  const recovery = await recoverStaleCaptureJobs(env, now);
  const retries = await dispatchCaptureRetries(env, now);
  const [dispatch, assets, healthTransitions, healthRecordsCleaned] = await Promise.all([
    dispatchDueCaptures(env, now),
    reconcileAssets(env, now),
    refreshDeviceHealthStatuses(env.DB, now),
    cleanHealth ? cleanupDeviceHealth(env.DB, now) : Promise.resolve(0),
    env.CAPTURE_ANALYSIS_MODE === "shadow"
      ? assessUpcomingCaptures(env, now).catch((error) => {
        console.error(JSON.stringify({ event: "capture_analysis_failed", message: String(error?.message ?? error).slice(0, 200) }));
      }) : Promise.resolve(),
  ]);
  const cleanup = assets.cycle_completed ? await cleanupExpiredCaptures(env, now) : 0;
  return { ...dispatch, recovered_capture_jobs: recovery.recovered, exhausted_capture_recoveries: recovery.failed,
    retried_capture_jobs: retries.enqueued, cleaned_targets: cleanup, asset_reconciliation: assets,
    ...(healthTransitions ? { device_health_transitions: healthTransitions } : {}),
    ...(cleanHealth ? { device_health_records_cleaned: healthRecordsCleaned } : {}) };
}

export async function fetchHandler(request: Request, env: WorkerEnvironment, ctx?: WorkerExecutionContext) {
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

    if (url.pathname === "/v1/telemetry") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      const deviceID = request.headers.get("X-Ribbonfish-Device-ID") ?? "";
      const device = await getEnabledDevice(env, deviceID);
      let bodyBytes;
      if (typeof device.public_key === "string" && device.public_key) {
        bodyBytes = await readRequestBody(request, MAX_TELEMETRY_BYTES);
        await authenticateDevice(request, deviceID, device, new Uint8Array(bodyBytes));
      } else {
        await authenticateDevice(request, deviceID, device);
        bodyBytes = await readRequestBody(request, MAX_TELEMETRY_BYTES);
      }
      const data = parseJSONBody(bodyBytes);
      const report = validateDeviceHealthReport(data);
      if (!report) throw new HTTPError(400, "invalid device health report");
      return jsonResponse(await persistDeviceHealth(env.DB, deviceID, report, Date.now()));
    }

    if (url.pathname === "/v2/playlist") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      const deviceID = request.headers.get("X-Ribbonfish-Device-ID") ?? "";
      await authenticate(request, env, deviceID);
      await updateLastSeen(env, deviceID, ctx);
      const { playlist, etag, notModified } = await readActivePlaylist(env, request.headers.get("If-None-Match"));
      if (notModified) return new Response(null, { status: 304, headers: privateHeaders({ ETag: etag }) });
      if (!playlist) throw new HTTPError(502, "active playlist was not available");
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
      ).bind(digest).first<AssignedAssetRow>();
      const captureAssigned = assigned ? null : await env.DB.prepare(
        "SELECT CASE WHEN t.current_sha256 = ? AND t.last_success_at >= ? THEN t.current_size ELSE t.placeholder_size END AS size " +
        "FROM playlist_capture_items p " +
        "JOIN active_playlist ap ON ap.playlist_id = p.playlist_id AND ap.revision = p.revision " +
        "JOIN capture_targets t ON t.capture_id = p.capture_id " +
        "WHERE ap.singleton = 1 AND (" +
        "(t.current_sha256 = ? AND t.last_success_at >= ?) OR " +
        "(t.placeholder_sha256 = ? AND (t.current_sha256 IS NULL OR t.last_success_at < ?))) LIMIT 1",
      ).bind(digest, Date.now() - 30 * 24 * 60 * 60 * 1000, digest,
        Date.now() - 30 * 24 * 60 * 60 * 1000, digest, Date.now() - 30 * 24 * 60 * 60 * 1000).first<AssignedAssetRow>();
      if (!assigned && !captureAssigned) throw new HTTPError(403, "asset is not assigned to the active playlist");
      const object = await env.ASSETS.get(`assets/${digest}`);
      if (!object) throw new HTTPError(404, "asset not found");
      if (object.size !== (assigned?.size ?? captureAssigned?.size) || object.size > MAX_ASSET_BYTES) {
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

function updateLastSeen(env: WorkerEnvironment, deviceID: string, ctx?: WorkerExecutionContext) {
  const now = Date.now();
  const update = Promise.resolve()
    .then(() => env.DB.prepare(
      "UPDATE devices SET last_seen_at = ? WHERE device_id = ? AND enabled = 1 AND (last_seen_at IS NULL OR last_seen_at <= ?)",
    ).bind(now, deviceID, now - LAST_SEEN_WRITE_INTERVAL_MS).run())
    .catch(() => {});
  if (ctx?.waitUntil) {
    ctx.waitUntil(update);
    return;
  }
  return update;
}

async function healthCheck(env: WorkerEnvironment) {
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

async function enroll(request: Request, env: WorkerEnvironment) {
  const data = await readJSON(request, MAX_ENROLLMENT_BYTES);
  if (!hasExactKeys(data, ["device_id", "enrollment_code"]) ||
      !isString(data.device_id) || !ID_PATTERN.test(data.device_id) || !isString(data.enrollment_code) ||
      data.enrollment_code.length < 8 || data.enrollment_code.length > 512) {
    throw new HTTPError(400, "invalid enrollment request");
  }

  const now = Date.now();
  const codeHash = await sha256Hex(data.enrollment_code);
  const enrollment = await env.DB.prepare(
    "SELECT code_hash, expires_at, consumed_at FROM enrollments WHERE code_hash = ?",
  ).bind(codeHash).first<EnrollmentRow>();
  if (!enrollment || enrollment.consumed_at !== null || enrollment.expires_at <= now) {
    throw new HTTPError(401, "enrollment code is invalid or expired");
  }
  const existing = await env.DB.prepare(
    "SELECT device_id FROM devices WHERE device_id = ?",
  ).bind(data.device_id).first<{ device_id: string }>();
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
    ).bind(data.device_id).first<{ device_id: string }>();
    if (existingAfterClaim) throw new HTTPError(409, "device is already enrolled");
    throw new HTTPError(401, "enrollment code is invalid or expired");
  }
  return jsonResponse({ device_token: token }, 201);
}

async function requestDeviceEnrollment(request: Request, env: WorkerEnvironment) {
  const rateLimiter = env.ENROLLMENT_RATE_LIMITER;
  if (rateLimiter) {
    const ipAddress = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const { success } = await rateLimiter.limit({ key: ipAddress });
    if (!success) throw new HTTPError(429, "too many enrollment requests; retry later");
  }

  const { data, bodyBytes } = await readJSONBody(request, MAX_ENROLLMENT_BYTES);
  if (!hasExactKeys(data, ["device_id", "public_key"]) ||
      !isString(data.device_id) || !ID_PATTERN.test(data.device_id) ||
      !isString(data.public_key) || !PUBLIC_KEY_PATTERN.test(data.public_key)) {
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
  ).bind(data.device_id).first<Pick<DeviceCredentialRow, "device_id" | "public_key" | "enabled">>();
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
  ).bind(requestID).first<EnrollmentRequestRow>();
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
  ).bind(requestID).first<EnrollmentRequestRow>();
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

async function authenticate(request: Request, env: WorkerEnvironment, deviceID: string, bodyBytes = new Uint8Array()) {
  const device = await getEnabledDevice(env, deviceID);
  return authenticateDevice(request, deviceID, device, bodyBytes);
}

async function getEnabledDevice(env: WorkerEnvironment, deviceID: string): Promise<DeviceCredentialRow> {
  if (!ID_PATTERN.test(deviceID)) throw new HTTPError(401, "device authentication failed");
  const device = await env.DB.prepare(
    "SELECT device_id, token_hash, public_key, enabled FROM devices WHERE device_id = ?",
  ).bind(deviceID).first<DeviceCredentialRow>();
  if (!device || device.enabled !== 1) {
    throw new HTTPError(401, "device authentication failed");
  }
  return device;
}

async function authenticateDevice(
  request: Request,
  deviceID: string,
  device: DeviceCredentialRow,
  bodyBytes = new Uint8Array(),
): Promise<DeviceCredentialRow> {
  if (typeof device.public_key === "string" && device.public_key) {
    if (!await verifyDeviceSignature(request, deviceID, device.public_key, bodyBytes)) {
      throw new HTTPError(401, "device authentication failed");
    }
    return device;
  }

  if (!device.token_hash) throw new HTTPError(401, "device authentication failed");
  const authorization = request.headers.get("Authorization") ?? "";
  const match = authorization.match(/^Bearer ([A-Za-z0-9_-]{32,256})$/);
  if (!match) throw new HTTPError(401, "device authentication failed");
  const presentedHash = await sha256Hex(match[1]);
  if (!equalSha256Digests(presentedHash, device.token_hash)) {
    throw new HTTPError(401, "device authentication failed");
  }
  return device;
}

async function readActivePlaylist(env: WorkerEnvironment): Promise<Extract<PlaylistReadResult, { notModified: false }>>;
async function readActivePlaylist(env: WorkerEnvironment, ifNoneMatch: string | null): Promise<PlaylistReadResult>;
async function readActivePlaylist(env: WorkerEnvironment, ifNoneMatch: string | null = null): Promise<PlaylistReadResult> {
  const active = await env.DB.prepare(
    "SELECT ap.playlist_id, ap.revision, p.rotation_interval, " +
    "EXISTS (SELECT 1 FROM playlist_capture_items pci WHERE pci.playlist_id = ap.playlist_id AND pci.revision = ap.revision) AS has_captures " +
    "FROM active_playlist ap JOIN playlists p ON p.playlist_id = ap.playlist_id AND p.revision = ap.revision " +
    "WHERE ap.singleton = 1",
  ).first<ActivePlaylistRow>();
  if (!active || !ID_PATTERN.test(active.playlist_id ?? "") || !ID_PATTERN.test(active.revision ?? "")) {
    throw new HTTPError(503, "no active playlist is configured");
  }
  const playlistRow = active;
  const staticETag = `"${playlistRow.revision}"`;
  if (!Number(active.has_captures) && matchesETag(ifNoneMatch, staticETag)) {
    return { etag: staticETag, notModified: true };
  }
  const [assetResult, captureResult] = await Promise.all([
    env.DB.prepare(
      "SELECT position, sha256, size FROM playlist_assets WHERE playlist_id = ? AND revision = ? ORDER BY position",
    ).bind(active.playlist_id, active.revision).all<PlaylistAssetRow>(),
    env.DB.prepare(
      "SELECT p.position, " +
      "CASE WHEN t.current_sha256 IS NOT NULL AND t.last_success_at >= ? THEN t.current_sha256 ELSE t.placeholder_sha256 END AS sha256, " +
      "CASE WHEN t.current_size IS NOT NULL AND t.last_success_at >= ? THEN t.current_size ELSE t.placeholder_size END AS size " +
      "FROM playlist_capture_items p JOIN capture_targets t ON t.capture_id = p.capture_id " +
      "WHERE p.playlist_id = ? AND p.revision = ? ORDER BY p.position",
    ).bind(Date.now() - 30 * 24 * 60 * 60 * 1000, Date.now() - 30 * 24 * 60 * 60 * 1000,
      active.playlist_id, active.revision).all<PlaylistAssetRow>(),
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
    version: 2 as const,
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
  return { playlist, etag: `"${playlist.revision}"`, notModified: false };
}

async function readJSON(request: Request, maxBytes: number): Promise<unknown> {
  return (await readJSONBody(request, maxBytes)).data;
}

async function readJSONBody(request: Request, maxBytes: number): Promise<{ data: unknown; bodyBytes: Uint8Array }> {
  const bodyBytes = await readRequestBody(request, maxBytes);
  return { data: parseJSONBody(bodyBytes), bodyBytes };
}

function formatFingerprint(requestID: string) {
  return requestID.slice(0, 32).match(/.{4}/g)!.join("-");
}

function methodNotAllowed(allowed: string) {
  return new Response("method not allowed", { status: 405, headers: privateHeaders({ Allow: allowed }) });
}
