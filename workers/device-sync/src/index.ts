import { jsonResponse, privateHeaders } from "./http-response.ts";
import { validatePlaylist } from "./playlist-validation.ts";
import { verifyDeviceSignature, equalSha256Digests } from "./device-signature.ts";
import { matchesETag } from "./http-cache.ts";
import { readRequestBody, parseJSONBody } from "./request-body.ts";
import { sha256Hex } from "./crypto-primitives.ts";
export { sha256Hex } from "./crypto-primitives.ts";
import { HTTPError } from "./http-error.ts";
import { DEVICE_ID_PATTERN } from "./device-id.ts";
import { readPlaylistContent } from "./playlist-revision.ts";
import { enroll, requestDeviceEnrollment } from "./enrollment.ts";
import { isString } from "./validation.ts";
import { assessUpcomingCaptures } from "./capture-intelligence.ts";
import { handleAdminRequest } from "./admin.ts";
import { CAPTURE_DEAD_LETTER_QUEUE_NAME, cleanupExpiredCaptures, dispatchCaptureOutbox, dispatchDueCaptures,
  handleCaptureDeadLetterQueue, handleCaptureQueue, recoverStaleCaptureJobs } from "./capture-workflow.ts";
import { reconcileAssets } from "./asset-maintenance.ts";
import { cleanupDeviceHealth, persistDeviceHealth, refreshDeviceHealthStatuses, validateDeviceHealthReport } from "./device-health.ts";
import type {
  ActivePlaylistRow,
  AssignedAssetRow,
  CaptureQueueBatch,
  DeviceCredentialRow,
  WorkerEnvironment,
  WorkerExecutionContext,
  WorkerScheduledController,
} from "./worker-contracts.ts";

type ActivePlaylistAsset = {
  sha256: string;
  size: number;
  captured_at?: number;
};
type ActivePlaylist = {
  version: 2 | 3;
  revision: string;
  id: string;
  rotation_interval: number;
  assets: ActivePlaylistAsset[];
};
type PlaylistReadResult =
  | { playlist: ActivePlaylist; etag: string; notModified: false }
  | { playlist?: undefined; etag: string; notModified: true };

const MAX_TELEMETRY_BYTES = 8 << 10;
const MAX_ASSET_BYTES = 32 << 20;

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
  const outbox = await dispatchCaptureOutbox(env, now);
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
    dispatched_capture_jobs: outbox.enqueued, cleaned_targets: cleanup, asset_reconciliation: assets,
    ...(healthTransitions ? { device_health_transitions: healthTransitions } : {}),
    ...(cleanHealth ? { device_health_records_cleaned: healthRecordsCleaned } : {}) };
}

type FetchRouteHandler = (request: Request, env: WorkerEnvironment, ctx?: WorkerExecutionContext) => Promise<Response>;
type FetchRoute = { method: string; handle: FetchRouteHandler };

const fetchRoutes = new Map<string, FetchRoute>([
  ["/healthz", { method: "GET", handle: (_request, env) => healthCheck(env) }],
  ["/v1/enroll", { method: "POST", handle: (request, env) => enroll(request, env) }],
  ["/v1/enrollment-requests", { method: "POST", handle: (request, env) => requestDeviceEnrollment(request, env) }],
  ["/v1/telemetry", { method: "POST", handle: (request, env) => receiveDeviceTelemetry(request, env) }],
  ["/v2/playlist", { method: "GET", handle: (request, env) => readPlaylist(request, env, 2) }],
  ["/v3/playlist", { method: "GET", handle: (request, env) => readPlaylist(request, env, 3) }],
]);

export async function fetchHandler(request: Request, env: WorkerEnvironment, ctx?: WorkerExecutionContext) {
  try {
    return await dispatchFetchRoute(request, env, ctx);
  } catch (error) {
    if (error instanceof HTTPError) return jsonResponse({ error: error.message }, error.status);
    return jsonResponse({ error: "internal error" }, 500);
  }
}

async function dispatchFetchRoute(request: Request, env: WorkerEnvironment, ctx?: WorkerExecutionContext): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return handleAdminRequest(request, env, ctx);
  const route = matchFetchRoute(pathname);
  if (!route) return new Response("not found", { status: 404, headers: privateHeaders() });
  if (request.method !== route.method) return methodNotAllowed(route.method);
  return route.handle(request, env, ctx);
}

function matchFetchRoute(pathname: string): FetchRoute | null {
  const assetMatch = pathname.match(/^\/v2\/assets\/([a-f0-9]{64})$/);
  if (assetMatch) return { method: "GET", handle: (request, env) => readAssignedAsset(request, env, assetMatch[1]) };
  return fetchRoutes.get(pathname) ?? null;
}

async function receiveDeviceTelemetry(request: Request, env: WorkerEnvironment): Promise<Response> {
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
  const report = validateDeviceHealthReport(parseJSONBody(bodyBytes));
  if (!report) throw new HTTPError(400, "invalid device health report");
  return jsonResponse(await persistDeviceHealth(env.DB, deviceID, report, Date.now()));
}

async function readPlaylist(request: Request, env: WorkerEnvironment, version: 2 | 3): Promise<Response> {
  const deviceID = request.headers.get("X-Ribbonfish-Device-ID") ?? "";
  await authenticate(request, env, deviceID);
  const { playlist, etag, notModified } = await readActivePlaylist(env, request.headers.get("If-None-Match"), version);
  if (notModified) return new Response(null, { status: 304, headers: privateHeaders({ ETag: etag }) });
  if (!playlist) throw new HTTPError(502, "active playlist was not available");
  if (matchesETag(request.headers.get("If-None-Match"), etag)) {
    return new Response(null, { status: 304, headers: privateHeaders({ ETag: etag }) });
  }
  return jsonResponse(playlist, 200, { ETag: etag });
}

async function readAssignedAsset(request: Request, env: WorkerEnvironment, digest: string): Promise<Response> {
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

async function authenticate(request: Request, env: WorkerEnvironment, deviceID: string, bodyBytes = new Uint8Array()) {
  const device = await getEnabledDevice(env, deviceID);
  return authenticateDevice(request, deviceID, device, bodyBytes);
}

async function getEnabledDevice(env: WorkerEnvironment, deviceID: string): Promise<DeviceCredentialRow> {
  if (!DEVICE_ID_PATTERN.test(deviceID)) throw new HTTPError(401, "device authentication failed");
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
async function readActivePlaylist(env: WorkerEnvironment, ifNoneMatch: string | null, version?: 2 | 3): Promise<PlaylistReadResult>;
async function readActivePlaylist(env: WorkerEnvironment, ifNoneMatch: string | null = null, version: 2 | 3 = 2): Promise<PlaylistReadResult> {
  const active = await env.DB.prepare(
    "SELECT ap.playlist_id, ap.revision, p.rotation_interval, " +
    "EXISTS (SELECT 1 FROM playlist_capture_items pci WHERE pci.playlist_id = ap.playlist_id AND pci.revision = ap.revision) AS has_captures " +
    "FROM active_playlist ap JOIN playlists p ON p.playlist_id = ap.playlist_id AND p.revision = ap.revision " +
    "WHERE ap.singleton = 1",
  ).first<ActivePlaylistRow>();
  if (!active || !DEVICE_ID_PATTERN.test(active.playlist_id ?? "") || !DEVICE_ID_PATTERN.test(active.revision ?? "")) {
    throw new HTTPError(503, "no active playlist is configured");
  }
  const playlistRow = active;
  const staticETag = `"${playlistRow.revision}"`;
  if (!Number(active.has_captures) && matchesETag(ifNoneMatch, staticETag)) {
    return { etag: staticETag, notModified: true };
  }
  const content = await readPlaylistContent(env, active.playlist_id, active.revision);
  const includeCaptureTimes = version === 3;
  const playlist = {
    version,
    revision: content.effective_revision,
    id: playlistRow.playlist_id,
    rotation_interval: playlistRow.rotation_interval,
    assets: content.assets.map(({ sha256, size, captured_at }) => ({ sha256, size,
      ...(includeCaptureTimes && Number.isSafeInteger(captured_at) && Number(captured_at) > 0
        ? { captured_at: Number(captured_at) } : {}) })),
  };
  try {
    validatePlaylist(playlist);
  } catch {
    throw new HTTPError(502, "stored active playlist is invalid");
  }
  return { playlist, etag: `"${playlist.revision}"`, notModified: false };
}

function methodNotAllowed(allowed: string) {
  return new Response("method not allowed", { status: 405, headers: privateHeaders({ Allow: allowed }) });
}
