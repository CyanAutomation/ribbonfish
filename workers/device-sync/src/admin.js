import { isValidPositiveDuration } from "./duration.js";
import { isPNG, MAX_ASSET_BYTES, storePngAsset } from "./asset-store.js";
import { validateCaptureSettings, validateCaptureTargetURL } from "./capture.js";
import { CaptureTargetNotAllowedError, enqueueCapture } from "./capture-workflow.js";
import { AssetDeletionInProgressError, markAssetLiveStatement } from "./asset-registry.js";

const MAX_JSON_BYTES = 64 << 10;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const ADMIN_FILES = new Map([
  ["/admin/index.html", { key: "admin/index.html", contentType: "text/html; charset=utf-8", maxAge: 60 }],
  ["/admin/app.js", { key: "admin/app.js", contentType: "text/javascript; charset=utf-8", maxAge: 300 }],
  ["/admin/styles.css", { key: "admin/styles.css", contentType: "text/css; charset=utf-8", maxAge: 300 }],
  ["/admin/capture-pending.png", { key: "admin/capture-pending.png", contentType: "image/png", maxAge: 3600 }],
]);

class HTTPError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Production management deployments require a Cloudflare Access identity and an
// explicit email allowlist, so the admin API fails closed if either is missing.
export async function handleAdminRequest(request, env, ctx) {
  if (env.ADMIN_ENABLED !== "true") return new Response("not found", { status: 404 });

  let actorID = "anonymous";
  if (env.ADMIN_ACCESS_REQUIRED === "true") {
    try {
      const identity = await ctx?.access?.getIdentity();
      if (typeof identity?.email !== "string" || !identity.email.trim()) {
        return new Response("access required", { status: 401 });
      }
      if (!isAllowedAdminEmail(identity.email, env.ADMIN_ALLOWED_EMAILS)) {
        return new Response("admin access required", { status: 403 });
      }
      actorID = identity.email.trim();
    } catch {
      return new Response("access required", { status: 401 });
    }
  }

  const url = new URL(request.url);
  try {
    if (url.pathname === "/admin" || url.pathname === "/admin/") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return await fetchAdminAsset(request, env, "/admin/index.html");
    }

    if (!url.pathname.startsWith("/admin/api/")) {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return await fetchAdminAsset(request, env, url.pathname);
    }

    if (url.pathname === "/admin/api/overview") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return jsonResponse(await readOverview(env));
    }

    if (url.pathname === "/admin/api/enrollment-requests") {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return jsonResponse(await readEnrollmentRequests(env));
    }

    const enrollmentDecisionMatch = url.pathname.match(/^\/admin\/api\/enrollment-requests\/([a-f0-9]{64})\/(approve|reject)$/);
    if (enrollmentDecisionMatch) {
      if (request.method !== "POST") return methodNotAllowed("POST");
      const data = await readJSON(request);
      if (!hasExactKeys(data, [])) throw new HTTPError(400, "request body must be an empty JSON object");
      return enrollmentDecisionMatch[2] === "approve"
        ? await approveEnrollmentRequest(enrollmentDecisionMatch[1], env, actorID)
        : await rejectEnrollmentRequest(enrollmentDecisionMatch[1], env, actorID);
    }

    if (url.pathname === "/admin/api/enrollment-codes") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      return await createEnrollmentCode(request, env, actorID);
    }

    if (url.pathname === "/admin/api/assets") {
      if (request.method !== "POST") return methodNotAllowed("POST");
      return await uploadAsset(request, env, actorID);
    }

    const captureRunMatch = url.pathname.match(/^\/admin\/api\/captures\/([0-9a-f-]{36})\/run$/i);
    if (captureRunMatch) {
      if (request.method !== "POST") return methodNotAllowed("POST");
      let result;
      try {
        result = await enqueueCapture(captureRunMatch[1], env);
      } catch (error) {
        if (error instanceof CaptureTargetNotAllowedError) throw new HTTPError(409, error.message);
        throw new HTTPError(503, "Capture could not be queued. Check the capture queue configuration and try again.");
      }
      if (!result) throw new HTTPError(404, "That webpage capture is no longer available.");
      return jsonResponse({ job_id: result.job_id, status: result.status }, 202);
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

function isAllowedAdminEmail(email, configuredEmails) {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail || typeof configuredEmails !== "string") return false;
  return configuredEmails.split(",").some((candidate) => candidate.trim().toLowerCase() === normalizedEmail);
}

async function fetchAdminAsset(request, env, pathname) {
  const file = ADMIN_FILES.get(pathname);
  if (!file) return new Response("not found", { status: 404 });
  const cacheControl = `private, max-age=${file.maxAge}, must-revalidate`;
  if (request.headers.has("If-None-Match")) {
    const metadata = await env.ASSETS.head(file.key);
    if (!metadata) return new Response("management asset not found", { status: 404 });
    if (metadata.httpEtag && matchesAssetETag(request.headers.get("If-None-Match"), metadata.httpEtag)) {
      return new Response(null, { status: 304, headers: adminAssetHeaders(file, cacheControl, metadata.httpEtag) });
    }
  }
  const object = await env.ASSETS.get(file.key);
  if (!object) return new Response("management asset not found", { status: 404 });
  const headers = adminAssetHeaders(file, cacheControl, object.httpEtag);
  headers.set("Content-Length", String(object.size));
  return new Response(object.body, { status: 200, headers });
}

function adminAssetHeaders(file, cacheControl, etag = null) {
  const headers = new Headers({
    "Content-Type": file.contentType,
    "Cache-Control": cacheControl,
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  if (etag) headers.set("ETag", etag);
  return headers;
}

function matchesAssetETag(header, etag) {
  return (header ?? "").split(",").map((value) => value.trim()).some((value) => value === "*" || value === etag);
}

async function readOverview(env) {
  const [devices, playlists, active, audit, captureTargets, integrityIssues] = await Promise.all([
    env.DB.prepare(
      "SELECT device_id, enabled, created_at, last_seen_at, " +
      "CASE WHEN public_key IS NULL THEN 'token' ELSE 'key' END AS auth_type " +
      "FROM devices ORDER BY device_id",
    ).all(),
    env.DB.prepare(
      "SELECT p.playlist_id, p.revision, p.rotation_interval, p.created_at, " +
      "((SELECT COUNT(*) FROM playlist_assets pa WHERE pa.playlist_id = p.playlist_id AND pa.revision = p.revision) + " +
      "(SELECT COUNT(*) FROM playlist_capture_items pc WHERE pc.playlist_id = p.playlist_id AND pc.revision = p.revision)) AS asset_count, " +
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
    env.DB.prepare(
      "SELECT t.capture_id, t.url, t.capture_interval_seconds, t.viewport_width, t.viewport_height, " +
      "CASE WHEN t.current_sha256 IS NOT NULL AND t.last_success_at >= ? THEN t.current_sha256 ELSE t.placeholder_sha256 END AS sha256, " +
      "CASE WHEN t.current_size IS NOT NULL AND t.last_success_at >= ? THEN t.current_size ELSE t.placeholder_size END AS size, " +
      "t.last_success_at, " +
      "t.last_error, t.next_due_at, " +
      "(SELECT j.status FROM capture_jobs j WHERE j.capture_id = t.capture_id AND j.status IN ('queued', 'running') " +
      "ORDER BY j.created_at DESC LIMIT 1) AS job_status FROM capture_targets t " +
      "WHERE EXISTS (SELECT 1 FROM playlist_capture_items p WHERE p.capture_id = t.capture_id) " +
      "ORDER BY t.next_due_at, t.created_at LIMIT 100",
    ).bind(Date.now() - 30 * 24 * 60 * 60 * 1000, Date.now() - 30 * 24 * 60 * 60 * 1000).all(),
    env.DB.prepare(
      "SELECT sha256, issue_type, first_seen_at, last_seen_at FROM asset_integrity_issues " +
      "WHERE resolved_at IS NULL ORDER BY last_seen_at DESC LIMIT 100",
    ).all(),
  ]);

  let missing = [];
  if (active) {
    const [assets, captures] = await Promise.all([
      env.DB.prepare(
        "SELECT sha256, size FROM playlist_assets WHERE playlist_id = ? AND revision = ? ORDER BY position",
      ).bind(active.playlist_id, active.revision).all(),
      env.DB.prepare(
        "SELECT CASE WHEN t.current_sha256 IS NOT NULL AND t.last_success_at >= ? THEN t.current_sha256 ELSE t.placeholder_sha256 END AS sha256, " +
        "CASE WHEN t.current_size IS NOT NULL AND t.last_success_at >= ? THEN t.current_size ELSE t.placeholder_size END AS size " +
        "FROM playlist_capture_items p JOIN capture_targets t ON t.capture_id = p.capture_id " +
        "WHERE p.playlist_id = ? AND p.revision = ? ORDER BY p.position",
      ).bind(Date.now() - 30 * 24 * 60 * 60 * 1000, Date.now() - 30 * 24 * 60 * 60 * 1000,
        active.playlist_id, active.revision).all(),
    ]);
    missing = await Promise.all([...(assets.results ?? []), ...(captures.results ?? [])].map(async (asset) => {
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
    capture_targets: (captureTargets.results ?? []).map((target) => {
      const source = new URL(target.url);
      return {
        capture_id: target.capture_id,
        display_url: source.origin + source.pathname,
        capture_interval_seconds: target.capture_interval_seconds,
        viewport: { width: target.viewport_width, height: target.viewport_height },
        sha256: target.sha256,
        size: target.size,
        last_success_at: target.last_success_at,
        last_error: target.last_error,
        job_status: target.job_status,
        next_due_at: target.next_due_at,
      };
    }),
    asset_health: {
      missing,
      integrity_issues: integrityIssues.results ?? [],
    },
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

async function readEnrollmentRequests(env) {
  const now = Date.now();
  const result = await env.DB.prepare(
    "SELECT r.request_id, r.device_id, r.fingerprint, r.created_at, r.last_seen_at, r.expires_at, " +
    "CASE WHEN d.device_id IS NULL THEN 0 ELSE 1 END AS replaces_existing " +
    "FROM enrollment_requests r LEFT JOIN devices d ON d.device_id = r.device_id " +
    "WHERE r.status = 'pending' AND r.expires_at > ? ORDER BY r.created_at, r.device_id",
  ).bind(now).all();
  return (result.results ?? []).map((request) => ({
    ...request,
    replaces_existing: Boolean(request.replaces_existing),
  }));
}

async function approveEnrollmentRequest(requestID, env, actorID) {
  const now = Date.now();
  const enrollment = await env.DB.prepare(
    "SELECT request_id, device_id, public_key, fingerprint, expires_at FROM enrollment_requests " +
    "WHERE request_id = ? AND status = 'pending'",
  ).bind(requestID).first();
  if (!enrollment || enrollment.expires_at <= now) throw new HTTPError(409, "enrollment request is no longer pending");

  const keyOwner = await env.DB.prepare(
    "SELECT device_id FROM devices WHERE public_key = ? AND device_id <> ?",
  ).bind(enrollment.public_key, enrollment.device_id).first();
  if (keyOwner) throw new HTTPError(409, "device key is already enrolled under another device ID");

  const decisionID = randomToken();
  const result = await env.DB.batch([
    env.DB.prepare(
      "UPDATE enrollment_requests SET status = 'approved', decided_at = ?, actor_id = ?, decision_id = ? " +
      "WHERE request_id = ? AND status = 'pending' AND expires_at > ?",
    ).bind(now, actorID, decisionID, requestID, now),
    env.DB.prepare(
      "INSERT INTO devices (device_id, token_hash, public_key, enabled, created_at, last_seen_at) " +
      "SELECT r.device_id, NULL, r.public_key, COALESCE(d.enabled, 1), COALESCE(d.created_at, ?), NULL " +
      "FROM enrollment_requests r LEFT JOIN devices d ON d.device_id = r.device_id " +
      "WHERE r.request_id = ? AND r.status = 'approved' AND r.decision_id = ? " +
      "ON CONFLICT(device_id) DO UPDATE SET token_hash = NULL, public_key = excluded.public_key, last_seen_at = NULL",
    ).bind(now, requestID, decisionID),
    auditStatement(env, actorID, "device.enrollment_approved", "device", enrollment.device_id,
      { fingerprint: enrollment.fingerprint ?? undefined }, { onlyWhenPreviousChanged: true }),
  ]);
  if (result[0]?.meta?.changes !== 1) throw new HTTPError(409, "enrollment request is no longer pending");
  return jsonResponse({ device_id: enrollment.device_id, status: "approved" });
}

async function rejectEnrollmentRequest(requestID, env, actorID) {
  const now = Date.now();
  const enrollment = await env.DB.prepare(
    "SELECT device_id, fingerprint FROM enrollment_requests WHERE request_id = ? AND status = 'pending' AND expires_at > ?",
  ).bind(requestID, now).first();
  if (!enrollment) throw new HTTPError(409, "enrollment request is no longer pending");

  const result = await env.DB.batch([
    env.DB.prepare(
      "UPDATE enrollment_requests SET status = 'rejected', decided_at = ?, actor_id = ? " +
      "WHERE request_id = ? AND status = 'pending' AND expires_at > ?",
    ).bind(now, actorID, requestID, now),
    auditStatement(env, actorID, "device.enrollment_rejected", "device", enrollment.device_id,
      { fingerprint: enrollment.fingerprint ?? undefined }, { onlyWhenPreviousChanged: true }),
  ]);
  if (result[0]?.meta?.changes !== 1) throw new HTTPError(409, "enrollment request is no longer pending");
  return jsonResponse({ device_id: enrollment.device_id, status: "rejected" });
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

  let asset;
  try {
    asset = await storePngAsset(bytes, env.ASSETS, { db: env.DB });
  } catch (error) {
    if (error instanceof AssetDeletionInProgressError) {
      throw new HTTPError(409, "This image is being cleaned up. Please upload it again shortly.");
    }
    throw error;
  }
  if (asset.created) {
    await env.DB.batch([
      auditStatement(env, actorID, "asset.uploaded", "asset", asset.sha256, { size: asset.size }),
    ]);
    return jsonResponse({ sha256: asset.sha256, size: asset.size }, 201);
  }
  return jsonResponse({ sha256: asset.sha256, size: asset.size }, 200);
}

async function readPlaylistAsset(sha256, env) {
  const reference = await env.DB.prepare(
    "SELECT 1 AS present FROM playlist_assets WHERE sha256 = ? LIMIT 1",
  ).bind(sha256).first();
  const captureReference = reference ? null : await env.DB.prepare(
    "SELECT 1 AS present FROM capture_targets WHERE placeholder_sha256 = ? OR current_sha256 = ? " +
    "UNION ALL SELECT 1 AS present FROM capture_history WHERE sha256 = ? LIMIT 1",
  ).bind(sha256, sha256, sha256).first();
  if (!reference && !captureReference) throw new HTTPError(404, "playlist image not found");
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
  const assets = data?.assets ?? [];
  const captures = data?.captures ?? [];
  if (!hasOnlyKeys(data, ["id", "rotation_interval", "assets", "captures"]) ||
      !Object.hasOwn(data, "id") || !Object.hasOwn(data, "rotation_interval") ||
      !ID_PATTERN.test(data.id ?? "") || !isValidPositiveDuration(data.rotation_interval) ||
      !Array.isArray(assets) || !Array.isArray(captures) || assets.length + captures.length < 1 ||
      assets.length + captures.length > 256) {
    throw new HTTPError(400, "Add a playlist ID, a valid rotation interval and at least one image or webpage (up to 256 items).");
  }

  for (const asset of assets) {
    if (!hasExactKeys(asset, ["sha256", "size"]) || !DIGEST_PATTERN.test(asset.sha256 ?? "") ||
        !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > MAX_ASSET_BYTES) {
      throw new HTTPError(400, "One of the images in this playlist is not valid. Please review the selection.");
    }
    const object = await env.ASSETS.head("assets/" + asset.sha256);
    if (!object || object.size !== asset.size) {
      throw new HTTPError(409, "One of these images is no longer available. Upload it again before saving the playlist.");
    }
  }

  const captureTargets = [];
  for (const capture of captures) captureTargets.push(await resolveCaptureTarget(capture, env));

  const revision = "r-" + crypto.randomUUID().replaceAll("-", "");
  const statements = [env.DB.prepare(
    "INSERT INTO playlists (playlist_id, revision, rotation_interval, created_at) VALUES (?, ?, ?, ?)",
  ).bind(data.id, revision, data.rotation_interval, Date.now())];
  for (const [position, asset] of assets.entries()) {
    statements.push(markAssetLiveStatement(env.DB, asset.sha256, asset.size, Date.now()));
    statements.push(env.DB.prepare(
      "INSERT INTO playlist_assets (playlist_id, revision, position, sha256, size) VALUES (?, ?, ?, ?, ?)",
    ).bind(data.id, revision, position, asset.sha256, asset.size));
  }
  for (const [index, target] of captureTargets.entries()) {
    statements.push(env.DB.prepare(
      "INSERT INTO playlist_capture_items (playlist_id, revision, position, capture_id) VALUES (?, ?, ?, ?)",
    ).bind(data.id, revision, assets.length + index, target.capture_id));
  }
  statements.push(auditStatement(env, actorID, "playlist.revision_created", "playlist", data.id, {
    revision,
    asset_count: assets.length,
    capture_count: captureTargets.length,
  }));
  try {
    await env.DB.batch(statements);
  } catch (error) {
    if (String(error?.message).includes("asset deletion in progress")) {
      throw new HTTPError(409, "One of these images is being cleaned up. Please upload it again shortly.");
    }
    throw error;
  }
  return jsonResponse({
    id: data.id,
    revision,
    rotation_interval: data.rotation_interval,
    asset_count: assets.length,
    capture_count: captureTargets.length,
    ...(captureTargets.length ? { captures: captureTargets } : {}),
  }, 201);
}

async function readPlaylistRevision(playlistID, revision, env) {
  const playlist = await env.DB.prepare(
    "SELECT playlist_id, revision, rotation_interval FROM playlists WHERE playlist_id = ? AND revision = ?",
  ).bind(playlistID, revision).first();
  if (!playlist) throw new HTTPError(404, "That playlist revision could not be found.");
  const assets = await env.DB.prepare(
    "SELECT sha256, size FROM playlist_assets WHERE playlist_id = ? AND revision = ? ORDER BY position",
  ).bind(playlistID, revision).all();
  const captures = await env.DB.prepare(
    "SELECT p.position, t.capture_id, t.url, t.capture_interval_seconds, t.viewport_width, t.viewport_height, " +
    "CASE WHEN t.current_sha256 IS NOT NULL AND t.last_success_at >= ? THEN t.current_sha256 ELSE t.placeholder_sha256 END AS sha256, " +
    "CASE WHEN t.current_size IS NOT NULL AND t.last_success_at >= ? THEN t.current_size ELSE t.placeholder_size END AS size, " +
    "t.last_success_at, t.last_error FROM playlist_capture_items p " +
    "JOIN capture_targets t ON t.capture_id = p.capture_id " +
    "WHERE p.playlist_id = ? AND p.revision = ? ORDER BY p.position",
  ).bind(Date.now() - 30 * 24 * 60 * 60 * 1000, Date.now() - 30 * 24 * 60 * 60 * 1000, playlistID, revision).all();
  const result = { ...playlist, assets: assets.results ?? [] };
  if (captures.results?.length) {
    result.captures = captures.results.map((capture) => ({
      capture_id: capture.capture_id,
      url: capture.url,
      capture_interval_seconds: capture.capture_interval_seconds,
      viewport: { width: capture.viewport_width, height: capture.viewport_height },
      sha256: capture.sha256,
      size: capture.size,
      last_success_at: capture.last_success_at,
      last_error: capture.last_error,
    }));
  }
  return jsonResponse(result);
}

async function resolveCaptureTarget(input, env) {
  if (hasExactKeys(input, ["capture_id"])) {
    const existing = await env.DB.prepare(
      "SELECT capture_id, url, capture_interval_seconds, viewport_width, viewport_height, placeholder_sha256, placeholder_size " +
      "FROM capture_targets WHERE capture_id = ? AND enabled = 1",
    ).bind(input.capture_id).first();
    if (!existing) throw new HTTPError(409, "One of the webpage captures is no longer available.");
    try {
      validateCaptureTargetURL(existing.url, env.CAPTURE_ALLOWED_HOSTS);
    } catch {
      throw new HTTPError(409, "One of the webpage capture hosts is not on the configured capture allowlist.");
    }
    return {
      capture_id: existing.capture_id,
      url: existing.url,
      capture_interval_seconds: existing.capture_interval_seconds,
      viewport: { width: existing.viewport_width, height: existing.viewport_height },
      placeholder_sha256: existing.placeholder_sha256,
      placeholder_size: existing.placeholder_size,
    };
  }
  if (!hasExactKeys(input, ["url", "capture_interval_seconds", "viewport"])) {
    throw new HTTPError(400, "A webpage capture needs a URL, capture interval and viewport.");
  }

  let url;
  let settings;
  try {
    url = validateCaptureTargetURL(input.url, env.CAPTURE_ALLOWED_HOSTS);
    settings = validateCaptureSettings(input);
  } catch (error) {
    throw new HTTPError(400, error.message);
  }
  const variantKey = await sha256Hex(JSON.stringify({
    url,
    viewport_width: settings.viewport_width,
    viewport_height: settings.viewport_height,
    wait_until: "domcontentloaded",
  }));
  const existing = await env.DB.prepare(
    "SELECT capture_id, url, capture_interval_seconds, viewport_width, viewport_height, placeholder_sha256, placeholder_size " +
    "FROM capture_targets WHERE variant_key = ?",
  ).bind(variantKey).first();
  if (existing) {
    const interval = Math.min(existing.capture_interval_seconds, settings.capture_interval_seconds);
    if (interval !== existing.capture_interval_seconds) {
      await env.DB.prepare("UPDATE capture_targets SET capture_interval_seconds = ? WHERE capture_id = ?")
        .bind(interval, existing.capture_id).run();
    }
    return {
      capture_id: existing.capture_id,
      url: existing.url,
      capture_interval_seconds: interval,
      viewport: { width: existing.viewport_width, height: existing.viewport_height },
      placeholder_sha256: existing.placeholder_sha256,
      placeholder_size: existing.placeholder_size,
    };
  }

  const placeholder = await env.ASSETS.get("admin/capture-pending.png");
  if (!placeholder) throw new HTTPError(503, "The built-in capture placeholder is unavailable. Publish the management assets and try again.");
  const placeholderBytes = new Uint8Array(await placeholder.arrayBuffer());
  let placeholderAsset;
  try {
    placeholderAsset = await storePngAsset(placeholderBytes, env.ASSETS, { db: env.DB });
  } catch (error) {
    if (error instanceof AssetDeletionInProgressError) {
      throw new HTTPError(409, "The holding image is being cleaned up. Please retry shortly.");
    }
    throw error;
  }
  const captureID = crypto.randomUUID();
  const now = Date.now();
  await env.DB.batch([
    markAssetLiveStatement(env.DB, placeholderAsset.sha256, placeholderAsset.size, now),
    env.DB.prepare(
      "INSERT OR IGNORE INTO capture_targets (capture_id, variant_key, url, capture_interval_seconds, viewport_width, viewport_height, " +
      "placeholder_sha256, placeholder_size, created_at, next_due_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(captureID, variantKey, url, settings.capture_interval_seconds, settings.viewport_width, settings.viewport_height,
      placeholderAsset.sha256, placeholderAsset.size, now, now),
  ]);
  const target = await env.DB.prepare(
    "SELECT capture_id, url, capture_interval_seconds, viewport_width, viewport_height, placeholder_sha256, placeholder_size " +
    "FROM capture_targets WHERE variant_key = ?",
  ).bind(variantKey).first();
  if (!target) throw new HTTPError(503, "The webpage capture could not be saved.");
  return {
    capture_id: target.capture_id,
    url: target.url,
    capture_interval_seconds: target.capture_interval_seconds,
    viewport: { width: target.viewport_width, height: target.viewport_height },
    placeholder_sha256: target.placeholder_sha256,
    placeholder_size: target.placeholder_size,
  };
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
    env.DB.prepare(`DELETE FROM playlist_capture_items WHERE playlist_id = ? AND ${activeGuard}`)
      .bind(playlistID, playlistID),
    env.DB.prepare(`DELETE FROM playlists WHERE playlist_id = ? AND ${activeGuard}`)
      .bind(playlistID, playlistID),
    auditStatement(env, actorID, "playlist.deleted", "playlist", playlistID, {
      revision_count: revisions.results.length,
    }, { onlyWhenPreviousChanged: true }),
    env.DB.prepare(
      `UPDATE asset_integrity_issues SET resolved_at = ? WHERE resolved_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM playlist_assets WHERE sha256 = asset_integrity_issues.sha256)
       AND NOT EXISTS (SELECT 1 FROM capture_targets
         WHERE placeholder_sha256 = asset_integrity_issues.sha256 OR current_sha256 = asset_integrity_issues.sha256)
       AND NOT EXISTS (SELECT 1 FROM capture_history WHERE sha256 = asset_integrity_issues.sha256)`,
    ).bind(Date.now()),
  ]);
  const deletedRevisions = results?.[2]?.meta?.changes ?? 0;
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
  const device = await env.DB.prepare("SELECT device_id, public_key FROM devices WHERE device_id = ?").bind(deviceID).first();
  if (!device) throw new HTTPError(404, "device not found");
  if (device.public_key) throw new HTTPError(409, "this device uses key-based authentication and has no token to rotate");
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

function hasOnlyKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).every((key) => keys.includes(key));
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
