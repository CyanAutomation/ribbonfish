import { jsonResponse } from "./http-response.ts";
import { matchesETag } from "./http-cache.ts";
import { readRequestBody as readBytes, parseJSONBody } from "./request-body.ts";
import { randomToken, sha256Hex } from "./crypto-primitives.ts";
export { sha256Hex } from "./crypto-primitives.ts";
import { HTTPError } from "./http-error.ts";
import { hasExactKeys, hasOnlyKeys, isRecord, isString } from "./validation.ts";
import {
  DEFAULT_CAPTURE_INTERVAL_SECONDS,
  DEFAULT_ROTATION_INTERVAL,
  intervalCatalog,
  isSupportedCaptureInterval,
  isSupportedRotationInterval,
} from "./intervals.ts";
import { deriveDeviceHealth, type DeviceHealthReport } from "./device-health.ts";
import { isPNG, MAX_ASSET_BYTES, storePngAsset } from "./asset-store.ts";
import { normalizeCaptureSelector, validateCaptureSettings, validateCaptureTargetURL } from "./capture.ts";
import { parseApiDashboardConfig } from "./api-dashboard/index.ts";
import { validateSourceConfig } from "./api-dashboard/adapters.ts";
import { CaptureTargetNotAllowedError, dispatchDueCaptures, enqueueCapture } from "./capture-workflow.ts";
import { AssetDeletionInProgressError, markAssetLiveStatement } from "./asset-registry.ts";
import { callJevDecision, JEVRequestError } from "./jev.ts";
import { classifyReserveReview, summarizeCaptureDurations } from "./capture-duration.ts";
import type { CaptureDurationSampleSummaryInput } from "./capture-duration.ts";
import {
  calculateDailyCaptureForecast,
  CLOUDFLARE_FREE_BROWSER_DAILY_LIMIT_MS,
} from "./capture-forecast.ts";
import {
  buildCaptureAssessmentState,
  captureAssessmentQuestions,
  durationReviewRecommendation,
} from "./jev-use-cases.ts";
import type { SqlRow, WorkerEnvironment, WorkerExecutionContext } from "./worker-contracts.ts";

type AdminRequestContext = Partial<Pick<WorkerExecutionContext, "access" | "waitUntil">>;
type CaptureSkipTarget = SqlRow & {
  capture_interval_seconds: number;
  current_sha256: string | null;
  last_success_at: number | null;
  current_asset_present: boolean;
  next_due_at: number;
  job_status: string | null;
  failure_count: number;
  last_error: string | null;
  history: Array<{ sha256: string | null; browser_ms: number; browser_ms_source: string | null }>;
};
type CaptureAssessmentTargetRow = SqlRow & {
  capture_interval_seconds: number;
  current_sha256: string | null;
  last_success_at: number | null;
  next_due_at: number;
  failure_count: number;
  last_error: string | null;
  enabled: number;
  job_status: string | null;
};
type StoredHealthSnapshot = Pick<DeviceHealthReport, "state" | "startup_error_code"> & {
  sync?: Pick<DeviceHealthReport["sync"], "status" | "error_code">;
  outputs?: Array<Pick<DeviceHealthReport["outputs"][number], "display_id" | "connector" | "status" | "error_code">>;
  host?: DeviceHealthReport["host"];
};
type PlaylistAssetInput = { sha256: string; size: number };
type PlaylistCaptureInput = { capture_id: string };

const MAX_JSON_BYTES = 64 << 10;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAPTURE_DURATION_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const CAPTURE_DURATION_REVIEW_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const CAPTURE_DURATION_SUMMARY_LIMIT = 50_000;
const ADMIN_FILES = new Map([
  ["/admin/index.html", { key: "admin/index.html", contentType: "text/html; charset=utf-8", maxAge: 60 }],
  ["/admin/app.js", { key: "admin/app.js", contentType: "text/javascript; charset=utf-8", maxAge: 300 }],
  ["/admin/styles.css", { key: "admin/styles.css", contentType: "text/css; charset=utf-8", maxAge: 300 }],
  ["/admin/favicon.png", { key: "admin/favicon.png", contentType: "image/png", maxAge: 3600 }],
  ["/admin/capture-pending.png", { key: "admin/capture-pending.png", contentType: "image/png", maxAge: 3600 }],
]);

// Production management deployments require a Cloudflare Access identity and an
// explicit email allowlist, so the admin API fails closed if either is missing.
type AdminRouteContext = {
  request: Request;
  url: URL;
  env: WorkerEnvironment;
  actorID: string;
  ctx?: AdminRequestContext;
};
type AdminApiRoute = (context: AdminRouteContext) => Promise<Response | null>;

async function adminActorID(env: WorkerEnvironment, ctx?: AdminRequestContext): Promise<string | Response> {
  if (env.ADMIN_ENABLED !== "true") return new Response("not found", { status: 404 });
  if (env.ADMIN_ACCESS_REQUIRED !== "true") return "anonymous";

  try {
    const identity = await ctx?.access?.getIdentity();
    if (typeof identity?.email !== "string" || !identity.email.trim()) {
      return new Response("access required", { status: 401 });
    }
    if (!isAllowedAdminEmail(identity.email, env.ADMIN_ALLOWED_EMAILS)) {
      return new Response("admin access required", { status: 403 });
    }
    return identity.email.trim();
  } catch {
    return new Response("access required", { status: 401 });
  }
}

function withAdminMethod(
  request: Request,
  expected: string,
  run: () => Response | Promise<Response>,
): Response | Promise<Response> {
  return request.method === expected ? run() : methodNotAllowed(expected);
}

// Production management deployments require a Cloudflare Access identity and an
// explicit email allowlist, so the admin API fails closed if either is missing.
export async function handleAdminRequest(request: Request, env: WorkerEnvironment, ctx?: AdminRequestContext) {
  const actorID = await adminActorID(env, ctx);
  if (actorID instanceof Response) return actorID;

  const context: AdminRouteContext = { request, url: new URL(request.url), env, actorID, ctx };
  try {
    const staticResponse = await handleAdminStaticRoute(context);
    return staticResponse ?? await dispatchAdminApiRoute(context);
  } catch (error) {
    if (error instanceof JEVRequestError) return jsonResponse({ error: "Analysis is temporarily unavailable. Try again shortly." }, error.status);
    if (error instanceof HTTPError) return jsonResponse({ error: error.message }, error.status);
    return jsonResponse({ error: "internal error" }, 500);
  }
}

async function handleAdminStaticRoute({ request, url, env }: AdminRouteContext): Promise<Response | null> {
  if (url.pathname === "/admin" || url.pathname === "/admin/") {
    return await withAdminMethod(request, "GET", () => fetchAdminAsset(request, env, "/admin/index.html"));
  }
  if (url.pathname.startsWith("/admin/api/")) return null;
  return await withAdminMethod(request, "GET", () => fetchAdminAsset(request, env, url.pathname));
}

async function dispatchAdminApiRoute(context: AdminRouteContext): Promise<Response> {
  const routes: AdminApiRoute[] = [
    handleAdminReadRoutes,
    handleAdminEnrollmentRoutes,
    handleAdminDashboardRoutes,
    handleAdminCaptureRoutes,
    handleAdminAssetRoutes,
    handleAdminPlaylistRoutes,
    handleAdminDeviceRoutes,
  ];
  for (const route of routes) {
    const response = await route(context);
    if (response) return response;
  }
  return jsonResponse({ error: "not found" }, 404);
}

async function handleAdminReadRoutes({ request, url, env, actorID }: AdminRouteContext): Promise<Response | null> {
  switch (url.pathname) {
    case "/admin/api/overview":
      return await withAdminMethod(request, "GET", async () => jsonResponse(await readOverview(env)));
    case "/admin/api/capture-forecast":
      return await withAdminMethod(request, "GET", async () => jsonResponse(await readCaptureForecast(env)));
    case "/admin/api/intervals":
      return await withAdminMethod(request, "GET", () => jsonResponse(intervalCatalog()));
    case "/admin/api/capture-decisions":
      return await withAdminMethod(request, "GET", async () => {
        const rows = await env.DB.prepare(
          "SELECT d.capture_id, d.due_at, d.assessed_at, d.action, d.reason, d.observed_at, d.observed_result, d.observed_delay_ms, d.state_json, d.decision_json FROM capture_decisions d " +
          "JOIN capture_targets t ON t.capture_id = d.capture_id " +
          "WHERE t.enabled = 1 AND d.action != 'pending' AND d.due_at = (SELECT MAX(d2.due_at) FROM capture_decisions d2 WHERE d2.capture_id = d.capture_id AND d2.action != 'pending') " +
          "LIMIT 1000",
        ).all();
        return jsonResponse((rows.results ?? []).map((row) => {
          const { state_json: stateJSON, decision_json: decisionJSON, ...summary } = row;
          const state = parseMetadata(stateJSON);
          const decision = parseMetadata(decisionJSON);
          return { ...summary, duration_review: durationReviewRecommendation(decision?.answers, state?.capture_duration) };
        }));
      });
    case "/admin/api/jev/capture-assessment":
      return await withAdminMethod(request, "POST", async () => {
        const data = await readJSON(request);
        if (!hasExactKeys(data, ["capture_id"]) || typeof data.capture_id !== "string" || !UUID_PATTERN.test(data.capture_id)) {
          throw new HTTPError(400, "request body must contain a valid capture_id");
        }
        const target = await readCaptureAssessmentTarget(data.capture_id, env);
        if (!target) throw new HTTPError(404, "that page screenshot is not available for assessment");
        await enforceJevRateLimit(env, actorID);
        const decision = await callJevDecision(env, {
          state: buildCaptureAssessmentState(target),
          questions: captureAssessmentQuestions,
        });
        return jsonResponse({
          ...decision,
          duration_review: durationReviewRecommendation(decision.answers, target.duration_summary),
          skip_eligibility: captureSkipEligibility(target, Date.now()),
        });
      });
    default:
      return null;
  }
}

async function handleAdminEnrollmentRoutes({ request, url, env, actorID }: AdminRouteContext): Promise<Response | null> {
  if (url.pathname === "/admin/api/enrollment-requests") {
    return await withAdminMethod(request, "GET", async () => jsonResponse(await readEnrollmentRequests(env)));
  }
  const decisionMatch = url.pathname.match(/^\/admin\/api\/enrollment-requests\/([a-f0-9]{64})\/(approve|reject)$/);
  if (decisionMatch) {
    return await withAdminMethod(request, "POST", async () => {
      const data = await readJSON(request);
      if (!hasExactKeys(data, [])) throw new HTTPError(400, "request body must be an empty JSON object");
      return decisionMatch[2] === "approve"
        ? await approveEnrollmentRequest(decisionMatch[1], env, actorID)
        : await rejectEnrollmentRequest(decisionMatch[1], env, actorID);
    });
  }
  if (url.pathname === "/admin/api/enrollment-codes") {
    return await withAdminMethod(request, "POST", () => createEnrollmentCode(request, env, actorID));
  }
  return null;
}

async function handleAdminDashboardRoutes({ request, url, env, actorID }: AdminRouteContext): Promise<Response | null> {
  if (url.pathname === "/admin/api/api-dashboards") {
    if (request.method === "GET") return jsonResponse(await readApiDashboards(env));
    if (request.method !== "POST") return methodNotAllowed("GET, POST");
    return await createApiDashboard(request, env, actorID);
  }
  const dashboardMatch = url.pathname.match(/^\/admin\/api\/api-dashboards\/([0-9a-f-]{36})$/i);
  if (dashboardMatch) {
    return await withAdminMethod(request, "PATCH", () =>
      updateApiDashboard(request, dashboardMatch[1].toLowerCase(), env, actorID));
  }
  return null;
}

async function handleAdminCaptureRoutes({ request, url, env, actorID }: AdminRouteContext): Promise<Response | null> {
  if (url.pathname === "/admin/api/capture-sites") {
    return await withAdminMethod(request, "POST", () => createCaptureSite(request, env, actorID));
  }
  const durationMatch = url.pathname.match(/^\/admin\/api\/captures\/([^/]+)\/duration-samples$/);
  if (durationMatch) {
    return await withAdminMethod(request, "GET", async () => {
      const captureID = durationMatch[1];
      if (!UUID_PATTERN.test(captureID)) throw new HTTPError(400, "capture_id must be a UUID");
      return jsonResponse(await readCaptureDurationSamples(captureID.toLowerCase(), url.searchParams, env));
    });
  }
  const skipMatch = url.pathname.match(/^\/admin\/api\/captures\/([0-9a-f-]{36})\/skip-once$/i);
  if (skipMatch) {
    return await withAdminMethod(request, "POST", async () => {
      const data = await readJSON(request);
      if (!hasExactKeys(data, ["due_at"]) || typeof data.due_at !== "number" || !Number.isSafeInteger(data.due_at) || data.due_at < 0) {
        throw new HTTPError(400, "request body must contain a valid due_at timestamp");
      }
      await confirmCaptureSkip(skipMatch[1].toLowerCase(), data.due_at, env, actorID);
      return jsonResponse({ confirmed: true, due_at: data.due_at }, 202);
    });
  }
  const nameMatch = url.pathname.match(/^\/admin\/api\/captures\/([0-9a-f-]{36})\/name$/i);
  if (nameMatch) {
    return await withAdminMethod(request, "PATCH", () =>
      updateCaptureName(request, nameMatch[1].toLowerCase(), env, actorID));
  }
  const readinessMatch = url.pathname.match(/^\/admin\/api\/captures\/([0-9a-f-]{36})\/readiness$/i);
  if (readinessMatch) {
    return await withAdminMethod(request, "PATCH", () =>
      updateCaptureReadiness(request, readinessMatch[1].toLowerCase(), env, actorID));
  }
  const captureMatch = url.pathname.match(/^\/admin\/api\/captures\/([0-9a-f-]{36})$/i);
  if (captureMatch) {
    if (request.method === "PATCH") {
      return await updateCaptureInterval(request, captureMatch[1].toLowerCase(), env, actorID);
    }
    if (request.method === "DELETE") {
      return await removeCaptureSite(captureMatch[1].toLowerCase(), env, actorID);
    }
    return methodNotAllowed("PATCH, DELETE");
  }
  const runMatch = url.pathname.match(/^\/admin\/api\/captures\/([0-9a-f-]{36})\/run$/i);
  if (runMatch) {
    return await withAdminMethod(request, "POST", async () => {
      let result;
      try {
        result = await enqueueCapture(runMatch[1].toLowerCase(), env);
      } catch (error) {
        if (error instanceof CaptureTargetNotAllowedError) throw new HTTPError(409, error.message);
        throw new HTTPError(503, "Capture could not be queued. Check the capture queue configuration and try again.");
      }
      if (!result) throw new HTTPError(404, "That webpage capture is no longer available.");
      return jsonResponse({ job_id: result.job_id, status: result.status }, 202);
    });
  }
  return null;
}

async function handleAdminAssetRoutes({ request, url, env, actorID }: AdminRouteContext): Promise<Response | null> {
  if (url.pathname === "/admin/api/assets") {
    return await withAdminMethod(request, "POST", () => uploadAsset(request, env, actorID));
  }
  const assetMatch = url.pathname.match(/^\/admin\/api\/assets\/([a-f0-9]{64})$/);
  if (assetMatch) {
    return await withAdminMethod(request, "GET", () => readPlaylistAsset(assetMatch[1], env));
  }
  return null;
}

async function handleAdminPlaylistRoutes({ request, url, env, actorID, ctx }: AdminRouteContext): Promise<Response | null> {
  if (url.pathname === "/admin/api/playlists") {
    return await withAdminMethod(request, "POST", () => createPlaylist(request, env, actorID, ctx));
  }
  const revisionMatch = url.pathname.match(/^\/admin\/api\/playlists\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/);
  if (revisionMatch) {
    return await withAdminMethod(request, "GET", () =>
      readPlaylistRevision(decodeURIComponent(revisionMatch[1]), decodeURIComponent(revisionMatch[2]), env));
  }
  const playlistMatch = url.pathname.match(/^\/admin\/api\/playlists\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/);
  if (playlistMatch) {
    return await withAdminMethod(request, "DELETE", () =>
      deletePlaylist(decodeURIComponent(playlistMatch[1]), env, actorID));
  }
  if (url.pathname === "/admin/api/active-playlist") {
    return await withAdminMethod(request, "PUT", () => activatePlaylist(request, env, actorID));
  }
  return null;
}

async function handleAdminDeviceRoutes({ request, url, env, actorID }: AdminRouteContext): Promise<Response | null> {
  const historyMatch = url.pathname.match(/^\/admin\/api\/devices\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/health-history$/);
  if (historyMatch) {
    return await withAdminMethod(request, "GET", async () =>
      jsonResponse(await readDeviceHealthHistory(decodeURIComponent(historyMatch[1]), url.searchParams, env)));
  }
  const healthMatch = url.pathname.match(/^\/admin\/api\/devices\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/health$/);
  if (healthMatch) {
    return await withAdminMethod(request, "GET", async () =>
      jsonResponse(await readDeviceHealth(decodeURIComponent(healthMatch[1]), env)));
  }
  const rotateMatch = url.pathname.match(/^\/admin\/api\/devices\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/rotate$/);
  if (rotateMatch) {
    return await withAdminMethod(request, "POST", () =>
      rotateDeviceCredential(request, decodeURIComponent(rotateMatch[1]), env, actorID));
  }
  const deviceMatch = url.pathname.match(/^\/admin\/api\/devices\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/);
  if (deviceMatch) {
    if (request.method === "PATCH") {
      return await setDeviceEnabled(request, decodeURIComponent(deviceMatch[1]), env, actorID);
    }
    if (request.method === "DELETE") {
      return await deleteDevice(decodeURIComponent(deviceMatch[1]), env, actorID);
    }
    return methodNotAllowed("PATCH, DELETE");
  }
  return null;
}

async function readCaptureAssessmentTarget(captureID: string, env: WorkerEnvironment): Promise<CaptureSkipTarget | null> {
  const target = await env.DB.prepare(
    "SELECT t.url, t.capture_interval_seconds, t.last_success_at, t.next_due_at, t.failure_count, t.last_error, " +
    "t.current_sha256, t.current_size, t.enabled, " +
    "CASE WHEN t.wait_for_selector IS NULL THEN 'domcontentloaded' ELSE 'selector' END AS readiness_mode, " +
    "(SELECT j.status FROM capture_jobs j WHERE j.capture_id = t.capture_id AND j.status IN ('queued', 'running') " +
    "ORDER BY j.created_at DESC LIMIT 1) AS job_status " +
    "FROM capture_targets t WHERE t.capture_id = ? AND t.enabled = 1 LIMIT 1",
  ).bind(captureID).first<CaptureAssessmentTargetRow>();
  if (!target) return null;
  const [history, durationSamples, image] = await Promise.all([
    env.DB.prepare(
      "SELECT browser_ms, browser_ms_source, sha256, captured_at FROM capture_history WHERE capture_id = ? ORDER BY captured_at DESC LIMIT 10",
    ).bind(captureID).all<{ sha256: string | null; browser_ms: number; browser_ms_source: string | null }>(),
    env.DB.prepare(
      "SELECT browser_ms, browser_ms_source, reserve_ms, attempt, outcome FROM capture_duration_samples " +
      "WHERE capture_id = ? AND sampled_at >= ? ORDER BY sampled_at DESC LIMIT 500",
    ).bind(captureID, Date.now() - CAPTURE_DURATION_REVIEW_WINDOW_MS).all<CaptureDurationSampleSummaryInput>(),
    target.current_sha256 ? env.ASSETS.head(`assets/${target.current_sha256}`) : Promise.resolve(null),
  ]);
  return {
    ...target,
    current_asset_present: Boolean(image && image.size === target.current_size),
    history: history.results ?? [],
    duration_summary: summarizeCaptureDurations(durationSamples.results ?? [], configuredCaptureReserveMs(env)),
  };
}

const CAPTURE_SKIP_APPROVAL_GRACE_MS = 5 * 60 * 1000;

function captureSkipEligibility(target: CaptureSkipTarget, now: number) {
  let reason: string | null = null;
  const nextDueAt = Number.isSafeInteger(target.next_due_at) ? target.next_due_at : null;
  const lastSuccessAt = Number.isSafeInteger(target.last_success_at) ? target.last_success_at : null;
  const intervalMs = Number.isSafeInteger(target.capture_interval_seconds)
    ? target.capture_interval_seconds * 1000 : 0;
  if (target.enabled !== undefined && target.enabled !== 1) reason = "This screenshot target is disabled.";
  else if (!target.current_sha256 || lastSuccessAt === null) reason = "A successful screenshot is required before skipping.";
  else if (!target.current_asset_present) reason = "The current screenshot asset is missing or inconsistent.";
  else if (nextDueAt === null || nextDueAt <= now) reason = "The next screenshot is due or already being processed.";
  else if (target.job_status) reason = "A screenshot job is already queued or running.";
  else if (target.failure_count > 0 || target.last_error) reason = "Recent screenshot failures require another capture.";
  else if (!hasStableRecentScreenshots(target)) reason = "At least three recent identical screenshots are required before considering a skip.";
  else if (!intervalMs || lastSuccessAt === null || nextDueAt === null || lastSuccessAt > now || nextDueAt - lastSuccessAt > intervalMs * 2) {
    reason = "The current screenshot may be too old to skip safely.";
  }
  return { eligible: reason === null, reason, due_at: nextDueAt };
}

function hasStableRecentScreenshots(target: CaptureSkipTarget) {
  const recent = (target.history ?? []).slice(0, 3);
  return recent.length === 3 && Boolean(target.current_sha256) &&
    recent.every((item) => item.sha256 === target.current_sha256);
}

async function confirmCaptureSkip(captureID: string, dueAt: number, env: WorkerEnvironment, actorID: string) {
  const now = Date.now();
  const target = await readCaptureAssessmentTarget(captureID, env);
  if (!target) throw new HTTPError(404, "That webpage capture is no longer available.");
  const eligibility = captureSkipEligibility(target, now);
  if (!eligibility.eligible || eligibility.due_at !== dueAt) {
    throw new HTTPError(409, eligibility.reason ?? "The screenshot schedule changed. Assess it again before confirming.");
  }
  const expiresAt = dueAt + CAPTURE_SKIP_APPROVAL_GRACE_MS;
  const batch = await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO capture_skip_approvals (capture_id, due_at, expires_at, actor_id, created_at) " +
      "SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM capture_targets t WHERE t.capture_id = ? AND t.enabled = 1 " +
      "AND t.next_due_at = ? AND t.current_sha256 IS NOT NULL AND t.last_success_at <= ? AND t.failure_count = 0 " +
      "AND t.last_error IS NULL AND (? - t.last_success_at) <= (t.capture_interval_seconds * 2000) " +
      "AND (SELECT COUNT(*) FROM (SELECT sha256 FROM capture_history WHERE capture_id = t.capture_id " +
      "ORDER BY captured_at DESC LIMIT 3) recent WHERE recent.sha256 = t.current_sha256) = 3 " +
      "AND NOT EXISTS (SELECT 1 FROM capture_jobs j WHERE j.capture_id = t.capture_id AND j.status IN ('queued', 'running'))) " +
      "ON CONFLICT(capture_id) DO UPDATE SET due_at = excluded.due_at, expires_at = excluded.expires_at, " +
      "actor_id = excluded.actor_id, created_at = excluded.created_at",
    ).bind(captureID, dueAt, expiresAt, actorID, now, captureID, dueAt, now, dueAt),
    auditStatement(env, actorID, "capture.skip_once_confirmed", "capture", captureID,
      { due_at: dueAt, expires_at: expiresAt }, { onlyWhenPreviousChanged: true }),
  ]);
  if (batch[0]?.meta?.changes !== 1) {
    throw new HTTPError(409, "The screenshot schedule changed. Assess it again before confirming.");
  }
}

async function enforceJevRateLimit(env: WorkerEnvironment, actorID: string) {
  if (typeof env.ENROLLMENT_RATE_LIMITER?.limit !== "function") {
    throw new HTTPError(503, "Analysis is temporarily unavailable.");
  }
  const key = `jev:${actorID.trim().toLowerCase() || "anonymous"}`;
  let result;
  try { result = await env.ENROLLMENT_RATE_LIMITER.limit({ key }); } catch {
    throw new HTTPError(503, "Analysis is temporarily unavailable.");
  }
  if (!result?.success) throw new HTTPError(429, "Analysis limit reached. Try again shortly.");
}

async function readCaptureDurationSamples(captureID: string, searchParams: URLSearchParams, env: WorkerEnvironment, now = Date.now()) {
  for (const key of searchParams.keys()) {
    if (!["since", "limit", "before", "before_sample_id"].includes(key)) {
      throw new HTTPError(400, `unsupported query parameter: ${key}`);
    }
  }
  const requestedLimit = parseOptionalQueryInteger(searchParams.get("limit"), "limit");
  const limit = requestedLimit ?? 50;
  if (limit < 1 || limit > 100) throw new HTTPError(400, "limit must be an integer from 1 to 100");
  const requestedSince = parseOptionalQueryInteger(searchParams.get("since"), "since");
  if (requestedSince !== null && requestedSince > now) throw new HTTPError(400, "since must not be in the future");
  const requestedBefore = parseOptionalQueryInteger(searchParams.get("before"), "before");
  const beforeSampleID = searchParams.get("before_sample_id");
  if ((requestedBefore === null) !== (beforeSampleID === null) || (beforeSampleID !== null && (!beforeSampleID || beforeSampleID.length > 128))) {
    throw new HTTPError(400, "before and before_sample_id must be supplied together");
  }
  if (requestedBefore !== null && requestedBefore > now) throw new HTTPError(400, "before must not be in the future");

  const target = await env.DB.prepare("SELECT capture_id FROM capture_targets WHERE capture_id = ?")
    .bind(captureID).first();
  if (!target) throw new HTTPError(404, "That webpage capture could not be found.");

  const retainedSince = now - CAPTURE_DURATION_RETENTION_MS;
  const since = Math.max(requestedSince ?? retainedSince, retainedSince);
  const summaryRows = await env.DB.prepare(
    "SELECT browser_ms, browser_ms_source, reserve_ms, attempt, outcome FROM capture_duration_samples " +
    "WHERE capture_id = ? AND sampled_at >= ? ORDER BY sampled_at DESC, sample_id DESC LIMIT ?",
  ).bind(captureID, since, CAPTURE_DURATION_SUMMARY_LIMIT).all<CaptureDurationSampleSummaryInput>();

  let sql = "SELECT sample_id, capture_id, job_id, attempt, sampled_at, browser_ms, browser_ms_source, reserve_ms, " +
    "browser_run_elapsed_ms, capture_elapsed_ms, outcome, readiness_mode, readiness_selector FROM capture_duration_samples " +
    "WHERE capture_id = ? AND sampled_at >= ?";
  const values = [captureID, since];
  if (requestedBefore !== null && beforeSampleID !== null) {
    sql += " AND (sampled_at < ? OR (sampled_at = ? AND sample_id < ?))";
    values.push(requestedBefore, requestedBefore, beforeSampleID);
  }
  sql += " ORDER BY sampled_at DESC, sample_id DESC LIMIT ?";
  values.push(limit + 1);
  const page = await env.DB.prepare(sql).bind(...values).all<SqlRow>();
  const hasMore = (page.results ?? []).length > limit;
  const samples = (page.results ?? []).slice(0, limit);
  const last = samples.at(-1);
  const currentReserveMs = configuredCaptureReserveMs(env);
  return {
    capture_id: captureID,
    retained_since: since,
    configured_reserve_ms: currentReserveMs,
    summary_sample_limit: CAPTURE_DURATION_SUMMARY_LIMIT,
    summary_truncated: (summaryRows.results ?? []).length === CAPTURE_DURATION_SUMMARY_LIMIT,
    summary: summarizeCaptureDurations(summaryRows.results ?? [], currentReserveMs),
    samples,
    next_before: hasMore && last ? last.sampled_at : null,
    next_before_sample_id: hasMore && last ? last.sample_id : null,
  };
}

function parseOptionalQueryInteger(value: string | null, name: string): number | null {
  if (value === null) return null;
  if (!/^\d+$/.test(value)) throw new HTTPError(400, `${name} must be a nonnegative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new HTTPError(400, `${name} must be a nonnegative integer`);
  return parsed;
}

function configuredCaptureReserveMs(env: WorkerEnvironment): number {
  const parsed = Number(env.CAPTURE_BUDGET_RESERVE_MS);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 60_000;
}

function summarizeDurationAggregate(row: SqlRow | null | undefined, reserveMs: number) {
  const totalSamples = Number(row?.total_samples ?? 0);
  const measuredCount = Number(row?.measured_sample_count ?? 0);
  const measuredCoverage = totalSamples ? measuredCount / totalSamples : 0;
  const measuredP50 = finiteNonNegativeOrNull(row?.measured_p50_ms);
  const measuredP90 = finiteNonNegativeOrNull(row?.measured_p90_ms);
  return {
    total_samples: totalSamples,
    measured_sample_count: measuredCount,
    reserve_estimated_sample_count: Number(row?.reserve_estimated_sample_count ?? 0),
    unknown_sample_count: Number(row?.unknown_sample_count ?? 0),
    failed_attempt_count: Number(row?.failed_attempt_count ?? 0),
    retry_attempt_count: Number(row?.retry_attempt_count ?? 0),
    capture_attempt_failure_rate: totalSamples ? Number(row?.failed_attempt_count ?? 0) / totalSamples : 0,
    retry_attempt_rate: totalSamples ? Number(row?.retry_attempt_count ?? 0) / totalSamples : 0,
    measured_header_coverage: measuredCoverage,
    measured_p50_ms: measuredP50,
    measured_p90_ms: measuredP90,
    measured_average_ms: finiteNonNegativeOrNull(row?.measured_average_ms),
    reserve_estimated_total_ms: Number(row?.reserve_estimated_total_ms ?? 0),
    configured_reserve_ms: reserveMs,
    reserve_review: classifyReserveReview(measuredCount, measuredCoverage, measuredP90, reserveMs),
  };
}

function finiteNonNegativeOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function isAllowedAdminEmail(email: string, configuredEmails: string | undefined) {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail || typeof configuredEmails !== "string") return false;
  return configuredEmails.split(",").some((candidate) => candidate.trim().toLowerCase() === normalizedEmail);
}

async function fetchAdminAsset(request: Request, env: WorkerEnvironment, pathname: string) {
  const file = ADMIN_FILES.get(pathname);
  if (!file) return new Response("not found", { status: 404 });
  const cacheControl = `private, max-age=${file.maxAge}, must-revalidate`;
  if (request.headers.has("If-None-Match")) {
    const metadata = await env.ASSETS.head(file.key);
    if (!metadata) return new Response("management asset not found", { status: 404 });
    if (metadata.httpEtag && matchesETag(request.headers.get("If-None-Match"), metadata.httpEtag)) {
      return new Response(null, { status: 304, headers: adminAssetHeaders(file, cacheControl, metadata.httpEtag) });
    }
  }
  const object = await env.ASSETS.get(file.key);
  if (!object) return new Response("management asset not found", { status: 404 });
  const headers = adminAssetHeaders(file, cacheControl, object.httpEtag);
  headers.set("Content-Length", String(object.size));
  return new Response(object.body, { status: 200, headers });
}

function adminAssetHeaders(file: { contentType: string }, cacheControl: string, etag: string | null = null) {
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

async function readOverview(env: WorkerEnvironment) {
  const now = Date.now();
  const windowStart = now - 30 * 24 * 60 * 60 * 1000;
  const [devices, playlists, active, audit, captureTargets, captureRuntimeAverages, integrityIssues, captureJobs, captureHistory, captureDurationSummaries, captureUsage, captureDecisions] = await Promise.all([
    env.DB.prepare(
      "SELECT d.device_id, d.enabled, d.created_at, d.last_seen_at, " +
      "CASE WHEN d.public_key IS NULL THEN 'token' ELSE 'key' END AS auth_type, " +
      "h.received_at AS health_received_at, h.reported_state, h.agent_version, h.sync_status, " +
      "h.applied_playlist_id, h.applied_revision, h.report_json " +
      "FROM devices d LEFT JOIN device_health_latest h ON h.device_id = d.device_id ORDER BY d.device_id",
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
      "SELECT t.capture_id, t.url, t.name, t.capture_type, t.api_status_json, t.api_last_fetch_at, t.api_last_image_at, t.capture_interval_seconds, t.viewport_width, t.viewport_height, t.wait_for_selector, " +
      "CASE WHEN t.current_sha256 IS NOT NULL AND t.last_success_at >= ? THEN t.current_sha256 ELSE t.placeholder_sha256 END AS sha256, " +
      "CASE WHEN t.current_size IS NOT NULL AND t.last_success_at >= ? THEN t.current_size ELSE t.placeholder_size END AS size, " +
      "t.last_attempt_at, t.last_success_at, " +
      "t.last_error, t.next_due_at, t.schedule_reviewed_at, " +
      "EXISTS (SELECT 1 FROM playlist_capture_items p JOIN active_playlist a " +
      "ON a.playlist_id = p.playlist_id AND a.revision = p.revision WHERE p.capture_id = t.capture_id) AS active_in_playlist, " +
      "(SELECT j.status FROM capture_jobs j WHERE j.capture_id = t.capture_id AND j.status IN ('queued', 'running') " +
      "ORDER BY j.created_at DESC LIMIT 1) AS job_status FROM capture_targets t " +
      "WHERE t.enabled = 1 ORDER BY t.next_due_at, t.created_at LIMIT 1000",
    ).bind(now - 30 * 24 * 60 * 60 * 1000, now - 30 * 24 * 60 * 60 * 1000).all(),
    env.DB.prepare(
      "SELECT capture_id, AVG(browser_ms) AS average_browser_ms, COUNT(*) AS sample_count " +
      "FROM capture_history WHERE captured_at >= ? GROUP BY capture_id",
    ).bind(windowStart).all(),
    env.DB.prepare(
      "SELECT sha256, issue_type, first_seen_at, last_seen_at FROM asset_integrity_issues " +
      "WHERE resolved_at IS NULL ORDER BY last_seen_at DESC LIMIT 100",
    ).all(),
    env.DB.prepare(
      "SELECT " +
      "SUM(CASE WHEN status = 'succeeded' AND result_kind = 'screenshot' THEN 1 ELSE 0 END) AS successful_screenshots, " +
      "SUM(CASE WHEN status = 'succeeded' AND result_kind = 'validator_unchanged' THEN 1 ELSE 0 END) AS validator_unchanged, " +
      "SUM(CASE WHEN status = 'succeeded' AND result_kind = 'unknown' THEN 1 ELSE 0 END) AS successful_unclassified, " +
      "SUM(CASE WHEN validator_outcome = 'disabled' THEN 1 ELSE 0 END) AS validator_disabled, " +
      "SUM(CASE WHEN validator_outcome = 'changed' THEN 1 ELSE 0 END) AS validator_changed, " +
      "SUM(CASE WHEN validator_outcome = 'no_stored_validator' THEN 1 ELSE 0 END) AS validator_no_stored_validator, " +
      "SUM(CASE WHEN validator_outcome = 'unavailable' THEN 1 ELSE 0 END) AS validator_unavailable, " +
      "SUM(CASE WHEN validator_outcome = 'cached_asset_missing' THEN 1 ELSE 0 END) AS validator_cached_asset_missing, " +
      "SUM(CASE WHEN validator_outcome = 'unknown' THEN 1 ELSE 0 END) AS validator_unknown, " +
      "SUM(browser_ms_response_header) AS browser_ms_response_header, " +
      "SUM(browser_ms_reserve) AS browser_ms_reserve, " +
      "SUM(browser_ms_legacy_unknown) AS browser_ms_unclassified_jobs " +
      "FROM capture_jobs WHERE created_at >= ? AND capture_id IN (SELECT capture_id FROM capture_targets WHERE capture_type = 'browser-screenshot')",
    ).bind(windowStart).first(),
    env.DB.prepare(
      "SELECT " +
      "SUM(CASE WHEN browser_ms_source = 'response_header' THEN 1 ELSE 0 END) AS response_header, " +
      "SUM(CASE WHEN browser_ms_source = 'reserve' THEN 1 ELSE 0 END) AS reserve, " +
      "SUM(CASE WHEN browser_ms_source = 'unknown' THEN 1 ELSE 0 END) AS unknown " +
      "FROM capture_history WHERE captured_at >= ? AND capture_id IN (SELECT capture_id FROM capture_targets WHERE capture_type = 'browser-screenshot')",
    ).bind(windowStart).first(),
    env.DB.prepare(
      "WITH measured_ranked AS (" +
      "SELECT capture_id, browser_ms, ROW_NUMBER() OVER (PARTITION BY capture_id ORDER BY browser_ms) AS sample_rank, " +
      "COUNT(*) OVER (PARTITION BY capture_id) AS measured_count FROM capture_duration_samples " +
      "WHERE sampled_at >= ? AND browser_ms_source = 'response_header'), " +
      "measured_stats AS (SELECT capture_id, COUNT(*) AS measured_sample_count, AVG(browser_ms) AS measured_average_ms, " +
      "AVG(CASE WHEN sample_rank IN (CAST((measured_count + 1) / 2 AS INTEGER), CAST((measured_count + 2) / 2 AS INTEGER)) THEN browser_ms END) AS measured_p50_ms, " +
      "MAX(CASE WHEN sample_rank = CAST(measured_count * 0.9 + 0.999999 AS INTEGER) THEN browser_ms END) AS measured_p90_ms " +
      "FROM measured_ranked GROUP BY capture_id), " +
      "source_stats AS (SELECT capture_id, COUNT(*) AS total_samples, " +
      "SUM(CASE WHEN browser_ms_source = 'response_header' THEN 1 ELSE 0 END) AS measured_sample_count, " +
      "SUM(CASE WHEN browser_ms_source = 'reserve' THEN 1 ELSE 0 END) AS reserve_estimated_sample_count, " +
      "SUM(CASE WHEN browser_ms_source = 'unknown' THEN 1 ELSE 0 END) AS unknown_sample_count, " +
      "SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failed_attempt_count, " +
      "SUM(CASE WHEN attempt > 1 THEN 1 ELSE 0 END) AS retry_attempt_count, " +
      "SUM(CASE WHEN browser_ms_source = 'reserve' THEN browser_ms ELSE 0 END) AS reserve_estimated_total_ms " +
      "FROM capture_duration_samples WHERE sampled_at >= ? GROUP BY capture_id) " +
      "SELECT source_stats.*, measured_stats.measured_average_ms, measured_stats.measured_p50_ms, measured_stats.measured_p90_ms " +
      "FROM source_stats LEFT JOIN measured_stats USING (capture_id)",
    ).bind(windowStart, windowStart).all(),
    env.DB.prepare("SELECT usage_day, browser_ms FROM capture_usage WHERE singleton = 1").first(),
    env.DB.prepare(
      "SELECT COUNT(*) AS assessments, " +
      "SUM(CASE WHEN action = 'defer_once' THEN 1 ELSE 0 END) AS candidate_deferrals, " +
      "SUM(CASE WHEN action = 'defer_once' AND observed_result = 'changed' THEN 1 ELSE 0 END) AS candidate_changed, " +
      "SUM(CASE WHEN action = 'defer_once' AND observed_result = 'unchanged' THEN 1 ELSE 0 END) AS candidate_unchanged, " +
      "SUM(CASE WHEN action = 'defer_once' AND observed_result = 'validator_unchanged' THEN 1 ELSE 0 END) AS candidate_validator_unchanged, " +
      "SUM(CASE WHEN action = 'defer_once' AND observed_result = 'failed' THEN 1 ELSE 0 END) AS candidate_failed, " +
      "SUM(CASE WHEN action = 'defer_once' AND observed_result = 'budget_deferred' THEN 1 ELSE 0 END) AS candidate_budget_deferred, " +
      "SUM(CASE WHEN action = 'defer_once' AND observed_result IS NULL THEN 1 ELSE 0 END) AS candidate_unobserved, " +
      "SUM(CASE WHEN action = 'defer_once' AND (observed_result IN ('validator_unchanged', 'failed', 'budget_deferred') OR observed_result IS NULL) THEN 1 ELSE 0 END) AS candidate_unverified, " +
      "SUM(CASE WHEN action = 'error' THEN 1 ELSE 0 END) AS errors " +
      "FROM capture_decisions WHERE assessed_at >= ? AND action != 'pending'",
    ).bind(windowStart).first(),
  ]);

  const missing = await readMissingActiveAssets(env, active, windowStart);
  const budgetValue = Number(env.DAILY_BROWSER_BUDGET_MS);
  const budgetMs = Number.isSafeInteger(budgetValue) && budgetValue >= 0 ? budgetValue : 600_000;
  const reserveMs = configuredCaptureReserveMs(env);
  const captureTargetSummaries = summarizeOverviewCaptureTargets(
    captureTargets.results ?? [], captureRuntimeAverages.results ?? [], captureDurationSummaries.results ?? [], reserveMs,
  );
  const captureUsageSummary = buildCaptureUsageSummary(captureTargetSummaries.filter((target) => target.capture_type !== "api-dashboard"), captureUsage, budgetMs, now);

  return {
    generated_at: now,
    environment: env.ADMIN_ACCESS_REQUIRED === "true" ? "production" : "development",
    devices: (devices.results ?? []).map((device) => summarizeDeviceHealth(device, now)),
    playlists: playlists.results ?? [],
    active_playlist: active,
    capture_targets: captureTargetSummaries,
    capture_efficiency: summarizeOverviewCaptureEfficiency(
      captureTargetSummaries, captureUsage, budgetMs, now, captureJobs, captureHistory, captureDecisions,
    ),
    asset_health: {
      missing,
      integrity_issues: integrityIssues.results ?? [],
    },
    audit: (audit.results ?? []).map(formatOverviewAuditEvent),
  };
}

type MissingAsset = { sha256: string; expected_size: number; actual_size: number | null };

async function readMissingActiveAssets(env: WorkerEnvironment, active: SqlRow | null, windowStart: number): Promise<MissingAsset[]> {
  if (!active) return [];
  const [assets, captures] = await Promise.all([
    env.DB.prepare(
      "SELECT sha256, size FROM playlist_assets WHERE playlist_id = ? AND revision = ? ORDER BY position",
    ).bind(active.playlist_id, active.revision).all(),
    env.DB.prepare(
      "SELECT CASE WHEN t.current_sha256 IS NOT NULL AND t.last_success_at >= ? THEN t.current_sha256 ELSE t.placeholder_sha256 END AS sha256, " +
      "CASE WHEN t.current_size IS NOT NULL AND t.last_success_at >= ? THEN t.current_size ELSE t.placeholder_size END AS size " +
      "FROM playlist_capture_items p JOIN capture_targets t ON t.capture_id = p.capture_id " +
      "WHERE p.playlist_id = ? AND p.revision = ? ORDER BY p.position",
    ).bind(windowStart, windowStart, active.playlist_id, active.revision).all(),
  ]);
  const missing = await Promise.all([...(assets.results ?? []), ...(captures.results ?? [])].map(async (asset): Promise<MissingAsset | null> => {
    const object = await env.ASSETS.head("assets/" + asset.sha256);
    if (object && object.size === asset.size) return null;
    return { sha256: asset.sha256, expected_size: asset.size, actual_size: object?.size ?? null };
  }));
  return missing.filter((item): item is MissingAsset => item !== null);
}

function summarizeOverviewCaptureTargets(targets: SqlRow[], runtimes: SqlRow[], durations: SqlRow[], reserveMs: number) {
  const runtimeAverageByCapture = new Map(runtimes.map((row) => [row.capture_id, row]));
  const durationSummaryByCapture = new Map(durations.map((row) => [row.capture_id, row]));
  return targets.map((target) => {
    const source = target.capture_type === "api-dashboard" ? null : new URL(target.url);
    const runtime = runtimeAverageByCapture.get(target.capture_id);
    const duration = durationSummaryByCapture.get(target.capture_id);
    return {
      capture_id: target.capture_id,
      display_url: source ? source.origin + source.pathname : "API dashboard",
      capture_type: target.capture_type ?? "browser-screenshot",
      api_status: parseMetadata(target.api_status_json) ?? [],
      api_last_fetch_at: target.api_last_fetch_at ?? null,
      api_last_image_at: target.api_last_image_at ?? null,
      name: target.name ?? null,
      capture_interval_seconds: target.capture_interval_seconds,
      wait_for_selector: target.wait_for_selector,
      viewport: { width: target.viewport_width, height: target.viewport_height },
      sha256: target.sha256,
      size: target.size,
      last_attempt_at: target.last_attempt_at,
      last_success_at: target.last_success_at,
      last_error: target.last_error,
      job_status: target.job_status,
      next_due_at: target.next_due_at,
      schedule_reviewed: target.schedule_reviewed_at != null,
      active_in_playlist: target.active_in_playlist === 1,
      average_browser_ms: target.capture_type !== "api-dashboard" && typeof runtime?.average_browser_ms === "number" && Number.isFinite(runtime.average_browser_ms)
        ? runtime.average_browser_ms : null,
      browser_ms_samples: Number(runtime?.sample_count ?? 0),
      duration_summary: target.capture_type === "api-dashboard" ? null : summarizeDurationAggregate(duration, reserveMs),
    };
  });
}

function summarizeOverviewCaptureEfficiency(
  captureTargets: SqlRow[],
  captureUsage: SqlRow | null,
  budgetMs: number,
  now: number,
  captureJobs: SqlRow | null,
  captureHistory: SqlRow | null,
  captureDecisions: SqlRow | null,
) {
  const summary = buildCaptureUsageSummary(captureTargets.filter((target) => target.capture_type !== "api-dashboard"), captureUsage, budgetMs, now);
  return {
    daily_usage: summary.daily_usage,
    forecast: summary.forecast,
    last_30_days: summarizeOverviewLast30Days(captureJobs, captureHistory, captureDecisions),
  };
}

function overviewCount(row: SqlRow | null, key: string) {
  return row?.[key] ?? 0;
}

function summarizeOverviewLast30Days(captureJobs: SqlRow | null, captureHistory: SqlRow | null, captureDecisions: SqlRow | null) {
  return {
    successful_screenshots: overviewCount(captureJobs, "successful_screenshots"),
    validator_unchanged: overviewCount(captureJobs, "validator_unchanged"),
    successful_unclassified: overviewCount(captureJobs, "successful_unclassified"),
    jev_shadow_assessments: overviewCount(captureDecisions, "assessments"),
    jev_candidate_deferrals: overviewCount(captureDecisions, "candidate_deferrals"),
    jev_candidate_changed: overviewCount(captureDecisions, "candidate_changed"),
    jev_candidate_unchanged: overviewCount(captureDecisions, "candidate_unchanged"),
    jev_candidate_validator_unchanged: overviewCount(captureDecisions, "candidate_validator_unchanged"),
    jev_candidate_failed: overviewCount(captureDecisions, "candidate_failed"),
    jev_candidate_budget_deferred: overviewCount(captureDecisions, "candidate_budget_deferred"),
    jev_candidate_unobserved: overviewCount(captureDecisions, "candidate_unobserved"),
    jev_candidate_unverified: overviewCount(captureDecisions, "candidate_unverified"),
    jev_errors: overviewCount(captureDecisions, "errors"),
    validator_outcomes: {
      disabled: overviewCount(captureJobs, "validator_disabled"),
      changed: overviewCount(captureJobs, "validator_changed"),
      no_stored_validator: overviewCount(captureJobs, "validator_no_stored_validator"),
      unavailable: overviewCount(captureJobs, "validator_unavailable"),
      cached_asset_missing: overviewCount(captureJobs, "validator_cached_asset_missing"),
      unknown: overviewCount(captureJobs, "validator_unknown"),
    },
    browser_run_ms: {
      response_header: overviewCount(captureJobs, "browser_ms_response_header"),
      reserve: overviewCount(captureJobs, "browser_ms_reserve"),
      unclassified_jobs: overviewCount(captureJobs, "browser_ms_unclassified_jobs"),
    },
    browser_ms_sources: {
      response_header: overviewCount(captureHistory, "response_header"),
      reserve: overviewCount(captureHistory, "reserve"),
      unknown: overviewCount(captureHistory, "unknown"),
    },
  };
}

function formatOverviewAuditEvent(event: SqlRow) {
  return {
    event_id: event.event_id,
    actor_id: event.actor_id,
    event_type: event.event_type,
    subject_type: event.subject_type,
    subject_id: event.subject_id,
    occurred_at: event.occurred_at,
    metadata: parseMetadata(event.metadata_json),
  };
}

async function readCaptureForecast(env: WorkerEnvironment, now = Date.now()) {
  const windowStart = now - 30 * 24 * 60 * 60 * 1000;
  const [targets, runtimeAverages, captureUsage] = await Promise.all([
    env.DB.prepare(
      "SELECT t.capture_id, t.name, t.url, t.capture_type, t.capture_interval_seconds, t.schedule_reviewed_at, " +
      "EXISTS (SELECT 1 FROM playlist_capture_items p JOIN active_playlist a " +
      "ON a.playlist_id = p.playlist_id AND a.revision = p.revision WHERE p.capture_id = t.capture_id) AS active_in_playlist " +
      "FROM capture_targets t WHERE t.enabled = 1 AND t.capture_type = 'browser-screenshot' ORDER BY t.next_due_at, t.created_at LIMIT 1000",
    ).all(),
    env.DB.prepare(
      "SELECT capture_id, AVG(browser_ms) AS average_browser_ms, COUNT(*) AS sample_count " +
      "FROM capture_history WHERE captured_at >= ? GROUP BY capture_id",
    ).bind(windowStart).all(),
    env.DB.prepare("SELECT usage_day, browser_ms FROM capture_usage WHERE singleton = 1").first(),
  ]);
  const runtimeAverageByCapture = new Map((runtimeAverages.results ?? []).map((row) => [row.capture_id, row]));
  const forecastTargets = (targets.results ?? []).map((target) => {
    const runtime = runtimeAverageByCapture.get(target.capture_id);
    const source = new URL(target.url);
    return {
      capture_id: target.capture_id,
      display_url: source.origin + source.pathname,
      name: target.name ?? null,
      capture_interval_seconds: target.capture_interval_seconds,
      schedule_reviewed: target.schedule_reviewed_at != null,
      active_in_playlist: target.active_in_playlist === 1,
      average_browser_ms: typeof runtime?.average_browser_ms === "number" && Number.isFinite(runtime.average_browser_ms)
        ? runtime.average_browser_ms : null,
      browser_ms_samples: Number(runtime?.sample_count ?? 0),
    };
  });
  const budgetValue = Number(env.DAILY_BROWSER_BUDGET_MS);
  const budgetMs = Number.isSafeInteger(budgetValue) && budgetValue >= 0 ? budgetValue : CLOUDFLARE_FREE_BROWSER_DAILY_LIMIT_MS;
  const summary = buildCaptureUsageSummary(forecastTargets, captureUsage, budgetMs, now);
  return {
    generated_at: now,
    plan: "workers-free",
    quota_scope: "account-wide",
    other_account_usage_included: false,
    ...summary,
  };
}

function buildCaptureUsageSummary(targets: SqlRow[], captureUsage: SqlRow | null, budgetMs: number, now: number) {
  const accountedMs = captureUsage?.usage_day === new Date(now).toISOString().slice(0, 10)
    ? captureUsage.browser_ms : 0;
  const forecast = calculateDailyCaptureForecast(targets.map((target) => ({
    capture_id: target.capture_id,
    display_label: target.name || target.display_url,
    capture_interval_seconds: target.capture_interval_seconds,
    active_in_playlist: target.active_in_playlist === true,
    schedule_reviewed: target.schedule_reviewed === true,
    average_browser_ms: target.average_browser_ms,
    browser_ms_samples: target.browser_ms_samples,
  })), new Map(), {
    freePlanLimitMs: CLOUDFLARE_FREE_BROWSER_DAILY_LIMIT_MS,
    workerBudgetMs: budgetMs,
  });
  return {
    daily_usage: {
      day: captureUsage?.usage_day ?? null,
      accounted_ms: accountedMs,
      budget_ms: budgetMs,
      free_plan_limit_ms: CLOUDFLARE_FREE_BROWSER_DAILY_LIMIT_MS,
      remaining_ms: Math.max(0, budgetMs - accountedMs),
    },
    forecast,
  };
}

function summarizeDeviceHealth(device: SqlRow, now: number) {
  const report = parseHealthJSON(device.report_json);
  return {
    device_id: device.device_id,
    enabled: device.enabled,
    created_at: device.created_at,
    last_seen_at: device.last_seen_at,
    auth_type: device.auth_type,
    health: {
      status: device.enabled ? deriveDeviceHealth(report, device.health_received_at, now) : "disabled",
      received_at: device.health_received_at ?? null,
      reported_state: device.reported_state ?? null,
      agent_version: device.agent_version ?? null,
      sync_status: device.sync_status ?? "unknown",
      applied_playlist_id: device.applied_playlist_id ?? null,
      applied_revision: device.applied_revision ?? null,
      outputs: (report?.outputs ?? []).map(({ display_id, connector, status, error_code }) => ({ display_id, connector, status, error_code })),
      host: report?.host ?? null,
      last_error_code: report?.startup_error_code ?? report?.sync?.error_code ?? report?.outputs?.find((item) => item.error_code)?.error_code ?? null,
    },
  };
}

async function readDeviceHealth(deviceID: string, env: WorkerEnvironment) {
  const device = await env.DB.prepare("SELECT device_id, enabled FROM devices WHERE device_id = ?").bind(deviceID).first();
  if (!device) throw new HTTPError(404, "device not found");
  const [latest, events] = await Promise.all([
    env.DB.prepare("SELECT instance_id, received_at, reported_state, agent_version, sync_status, report_json FROM device_health_latest WHERE device_id = ?")
      .bind(deviceID).first(),
    env.DB.prepare("SELECT event_id, received_at, event_type, reported_state, error_code, metadata_json FROM device_health_events WHERE device_id = ? ORDER BY received_at DESC LIMIT ?")
      .bind(deviceID, 50).all(),
  ]);
  const report = parseHealthJSON(latest?.report_json);
  return {
    device_id: deviceID,
    enabled: Boolean(device.enabled),
    health_status: device.enabled ? deriveDeviceHealth(report, latest?.received_at, Date.now()) : "disabled",
    received_at: latest?.received_at ?? null,
    latest: report,
    events: (events.results ?? []).map(formatHealthEvent),
  };
}

async function readDeviceHealthHistory(deviceID: string, params: URLSearchParams, env: WorkerEnvironment) {
  const device = await env.DB.prepare("SELECT device_id, enabled FROM devices WHERE device_id = ?").bind(deviceID).first();
  if (!device) throw new HTTPError(404, "device not found");
  const rawLimit = params.get("limit") ?? "100";
  const limit = Number(rawLimit);
  if (!/^\d+$/.test(rawLimit) || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new HTTPError(400, "limit must be an integer from 1 to 500");
  }
  const rawSince = params.get("since");
  const now = Date.now();
  const retentionCutoff = now - 30 * 24 * 60 * 60 * 1000;
  let since = rawSince === null ? retentionCutoff : Number(rawSince);
  if (rawSince !== null && (!/^\d+$/.test(rawSince) || !Number.isSafeInteger(since))) {
    throw new HTTPError(400, "since must be a Unix timestamp in milliseconds");
  }
  if (since > now) throw new HTTPError(400, "since must not be in the future");
  since = Math.max(since, retentionCutoff);
  const [samples, events] = await Promise.all([
    env.DB.prepare("SELECT bucket_at, received_at, report_json FROM device_health_samples WHERE device_id = ? AND received_at >= ? ORDER BY received_at DESC LIMIT ?")
      .bind(deviceID, since, limit).all(),
    env.DB.prepare("SELECT event_id, received_at, event_type, reported_state, error_code, metadata_json FROM device_health_events WHERE device_id = ? AND received_at >= ? ORDER BY received_at DESC LIMIT ?")
      .bind(deviceID, since, limit).all(),
  ]);
  return {
    device_id: deviceID,
    enabled: Boolean(device.enabled),
    since,
    samples: (samples.results ?? []).map((sample) => ({
      bucket_at: sample.bucket_at,
      received_at: sample.received_at,
      report: parseHealthJSON(sample.report_json),
    })),
    events: (events.results ?? []).map(formatHealthEvent),
  };
}

function formatHealthEvent(event: SqlRow) {
  return {
    event_id: event.event_id,
    received_at: event.received_at,
    event_type: event.event_type,
    reported_state: event.reported_state,
    error_code: event.error_code,
    metadata: parseMetadata(event.metadata_json),
  };
}

function parseHealthJSON(value: unknown): StoredHealthSnapshot | null {
  if (!isString(value)) return null;
  try {
    const report: unknown = JSON.parse(value);
    if (!isRecord(report) || !["starting", "ready", "degraded", "startup_failed", "stopping"].includes(String(report.state))) return null;
    return report as unknown as StoredHealthSnapshot;
  } catch { return null; }
}

async function readEnrollmentRequests(env: WorkerEnvironment) {
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

async function approveEnrollmentRequest(requestID: string, env: WorkerEnvironment, actorID: string) {
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

async function rejectEnrollmentRequest(requestID: string, env: WorkerEnvironment, actorID: string) {
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

async function createEnrollmentCode(request: Request, env: WorkerEnvironment, actorID: string) {
  const data = await readJSON(request);
  if (!hasExactKeys(data, ["expires_in_minutes"]) || typeof data.expires_in_minutes !== "number" || !Number.isSafeInteger(data.expires_in_minutes) ||
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

async function uploadAsset(request: Request, env: WorkerEnvironment, actorID: string) {
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

async function readPlaylistAsset(sha256: string, env: WorkerEnvironment) {
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

async function createPlaylist(request: Request, env: WorkerEnvironment, actorID: string, ctx?: AdminRequestContext) {
  const input = await readPlaylistInput(request);
  await verifyPlaylistAssets(input.assets, env);
  const captureTargets = await resolvePlaylistCaptures(input.captures, env, actorID);
  const revision = "r-" + crypto.randomUUID().replaceAll("-", "");
  await savePlaylistRevision(input, revision, captureTargets, env, actorID);
  await dispatchPlaylistCaptures(captureTargets, env, ctx);
  return jsonResponse({
    id: input.id,
    revision,
    rotation_interval: input.rotationInterval,
    asset_count: input.assets.length,
    capture_count: captureTargets.length,
    ...(captureTargets.length ? { captures: captureTargets } : {}),
  }, 201);
}

type PlaylistInput = {
  id: string;
  rotationInterval: string;
  assets: PlaylistAssetInput[];
  captures: PlaylistCaptureInput[];
};

async function readPlaylistInput(request: Request): Promise<PlaylistInput> {
  const data = await readJSON(request);
  if (!hasOnlyKeys(data, ["id", "rotation_interval", "assets", "captures"]) ||
      !Object.hasOwn(data, "id") ||
      !isString(data.id) || !ID_PATTERN.test(data.id)) {
    throw new HTTPError(400, "Add a playlist ID, a valid rotation interval and at least one image or webpage (up to 256 items).");
  }

  const rotationInterval = Object.hasOwn(data, "rotation_interval") ? data.rotation_interval : DEFAULT_ROTATION_INTERVAL;
  const rawAssets = data.assets ?? [];
  const rawCaptures = data.captures ?? [];
  if (!isSupportedRotationInterval(rotationInterval) || !Array.isArray(rawAssets) || !Array.isArray(rawCaptures) ||
      rawAssets.length + rawCaptures.length < 1 || rawAssets.length + rawCaptures.length > 256) {
    throw new HTTPError(400, "Add a playlist ID, a valid rotation interval and at least one image or webpage (up to 256 items).");
  }

  return {
    id: data.id,
    rotationInterval,
    assets: normalizePlaylistAssets(rawAssets),
    captures: normalizePlaylistCaptures(rawCaptures),
  };
}

function normalizePlaylistAssets(rawAssets: unknown[]): PlaylistAssetInput[] {
  const assets: PlaylistAssetInput[] = [];
  for (const asset of rawAssets) {
    if (!hasExactKeys(asset, ["sha256", "size"]) || !isString(asset.sha256) || !DIGEST_PATTERN.test(asset.sha256) ||
        typeof asset.size !== "number" || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > MAX_ASSET_BYTES) {
      throw new HTTPError(400, "One of the images in this playlist is not valid. Please review the selection.");
    }
    assets.push({ sha256: asset.sha256, size: asset.size });
  }
  return assets;
}

function normalizePlaylistCaptures(rawCaptures: unknown[]): PlaylistCaptureInput[] {
  const captures: PlaylistCaptureInput[] = [];
  for (const capture of rawCaptures) {
    if (!hasExactKeys(capture, ["capture_id"]) || !isString(capture.capture_id)) {
      throw new HTTPError(400, "Add existing sites from the Sites section after reviewing their screenshot schedules.");
    }
    captures.push({ capture_id: capture.capture_id });
  }
  return captures;
}

async function verifyPlaylistAssets(assets: PlaylistAssetInput[], env: WorkerEnvironment): Promise<void> {
  for (const asset of assets) {
    const object = await env.ASSETS.head("assets/" + asset.sha256);
    if (!object || object.size !== asset.size) {
      throw new HTTPError(409, "One of these images is no longer available. Upload it again before saving the playlist.");
    }
  }
}

async function resolvePlaylistCaptures(captures: PlaylistCaptureInput[], env: WorkerEnvironment, actorID: string): Promise<SqlRow[]> {
  const targets: SqlRow[] = [];
  for (const capture of captures) {
    targets.push(await resolveCaptureTarget(capture, env, actorID));
  }
  return targets;
}

async function savePlaylistRevision(
  input: PlaylistInput,
  revision: string,
  captureTargets: SqlRow[],
  env: WorkerEnvironment,
  actorID: string,
): Promise<void> {
  const statements = [env.DB.prepare(
    "INSERT INTO playlists (playlist_id, revision, rotation_interval, created_at) VALUES (?, ?, ?, ?)",
  ).bind(input.id, revision, input.rotationInterval, Date.now())];
  for (const [position, asset] of input.assets.entries()) {
    statements.push(markAssetLiveStatement(env.DB, asset.sha256, asset.size, Date.now()));
    statements.push(env.DB.prepare(
      "INSERT INTO playlist_assets (playlist_id, revision, position, sha256, size) VALUES (?, ?, ?, ?, ?)",
    ).bind(input.id, revision, position, asset.sha256, asset.size));
  }
  for (const [index, target] of captureTargets.entries()) {
    statements.push(env.DB.prepare(
      "INSERT INTO playlist_capture_items (playlist_id, revision, position, capture_id) VALUES (?, ?, ?, ?)",
    ).bind(input.id, revision, input.assets.length + index, target.capture_id));
  }
  statements.push(auditStatement(env, actorID, "playlist.revision_created", "playlist", input.id, {
    revision,
    asset_count: input.assets.length,
    capture_count: captureTargets.length,
  }));
  try {
    await env.DB.batch(statements);
  } catch (error) {
    if ((error instanceof Error ? error.message : String(error)).includes("asset deletion in progress")) {
      throw new HTTPError(409, "One of these images is being cleaned up. Please upload it again shortly.");
    }
    throw error;
  }
}

async function dispatchPlaylistCaptures(captureTargets: SqlRow[], env: WorkerEnvironment, ctx?: AdminRequestContext): Promise<void> {
  if (captureTargets.length) {
    const dispatch = dispatchDueCaptures(env, Date.now()).catch((error) => {
      console.error(JSON.stringify({
        message: "initial capture dispatch failed after playlist save",
        error: error instanceof Error ? error.message : String(error),
      }));
    });
    if (typeof ctx?.waitUntil === "function") ctx.waitUntil(dispatch);
    else await dispatch;
  }
}

async function updateCaptureInterval(request: Request, captureID: string, env: WorkerEnvironment, actorID: string) {
  const data = await readJSON(request);
  if (!hasExactKeys(data, ["capture_interval_seconds"]) || !isSupportedCaptureInterval(data.capture_interval_seconds)) {
    throw new HTTPError(400, "capture_interval_seconds must be one of the supported values: 900, 1800, 3600, 10800, 21600, 43200, or 86400.");
  }
  const existing = await env.DB.prepare(
    "SELECT capture_id, last_success_at, schedule_reviewed_at FROM capture_targets WHERE capture_id = ? AND enabled = 1",
  ).bind(captureID).first();
  if (!existing) throw new HTTPError(404, "That webpage capture is not available.");
  const now = Date.now();
  const nextDueAt = existing.last_success_at == null
    ? now : Math.max(now, existing.last_success_at + data.capture_interval_seconds * 1000);
  const batch = await env.DB.batch([
    env.DB.prepare(
      "UPDATE capture_targets SET capture_interval_seconds = ?, next_due_at = ?, schedule_reviewed_at = ? WHERE capture_id = ? AND enabled = 1",
    ).bind(data.capture_interval_seconds, nextDueAt, Date.now(), captureID),
    auditStatement(env, actorID, existing.schedule_reviewed_at == null ? "capture.schedule_reviewed" : "capture.interval_updated", "capture", captureID,
      { capture_interval_seconds: data.capture_interval_seconds }, { onlyWhenPreviousChanged: true }),
  ]);
  if (batch[0]?.meta?.changes !== 1) throw new HTTPError(404, "That webpage capture is not available.");
  return jsonResponse({ capture_id: captureID, capture_interval_seconds: data.capture_interval_seconds });
}

async function updateCaptureName(request: Request, captureID: string, env: WorkerEnvironment, actorID: string) {
  const data = await readJSON(request);
  if (!hasExactKeys(data, ["name"]) || typeof data.name !== "string" || data.name.trim().length > 120 || /[\u0000-\u001f\u007f]/.test(data.name)) {
    throw new HTTPError(400, "Name must be text of at most 120 characters on one line.");
  }
  const name = data.name.trim() || null;
  const batch = await env.DB.batch([
    env.DB.prepare("UPDATE capture_targets SET name = ? WHERE capture_id = ? AND enabled = 1").bind(name, captureID),
    auditStatement(env, actorID, "capture.name_updated", "capture", captureID, { name }, { onlyWhenPreviousChanged: true }),
  ]);
  if (batch[0]?.meta?.changes !== 1) throw new HTTPError(404, "That webpage capture is not available.");
  return jsonResponse({ capture_id: captureID, name });
}

async function updateCaptureReadiness(request: Request, captureID: string, env: WorkerEnvironment, actorID: string) {
  const data = await readJSON(request);
  if (!hasExactKeys(data, ["wait_for_selector"])) {
    throw new HTTPError(400, "request body must contain only wait_for_selector");
  }
  let selector;
  try { selector = normalizeCaptureSelector(data.wait_for_selector); }
  catch (error) { throw new HTTPError(400, error instanceof Error ? error.message : String(error)); }
  const existing = await env.DB.prepare(
    "SELECT capture_id FROM capture_targets WHERE capture_id = ? AND enabled = 1",
  ).bind(captureID).first();
  if (!existing) throw new HTTPError(404, "That webpage capture is not available.");
  const batch = await env.DB.batch([
    env.DB.prepare("UPDATE capture_targets SET wait_for_selector = ? WHERE capture_id = ? AND enabled = 1")
      .bind(selector, captureID),
    auditStatement(env, actorID, "capture.readiness_updated", "capture", captureID,
      { wait_for_selector: selector }, { onlyWhenPreviousChanged: true }),
  ]);
  if (batch[0]?.meta?.changes !== 1) throw new HTTPError(404, "That webpage capture is not available.");
  return jsonResponse({ capture_id: captureID, wait_for_selector: selector });
}

async function removeCaptureSite(captureID: string, env: WorkerEnvironment, actorID: string) {
  const target = await env.DB.prepare(
    "SELECT capture_id FROM capture_targets WHERE capture_id = ?",
  ).bind(captureID).first();
  if (!target) throw new HTTPError(404, "That webpage capture could not be found.");
  const results = await env.DB.batch([
    env.DB.prepare("UPDATE capture_targets SET enabled = 0 WHERE capture_id = ? AND enabled = 1").bind(captureID),
    auditStatement(env, actorID, "capture.site_removed", "capture", captureID, {}, { onlyWhenPreviousChanged: true }),
    env.DB.prepare(
      "UPDATE capture_jobs SET status = 'failed', finished_at = ?, lease_until = NULL, error = ? " +
      "WHERE capture_id = ? AND status = 'queued'",
    ).bind(Date.now(), "Capture site removed.", captureID),
  ]);
  return jsonResponse({ capture_id: captureID, removed: results?.[0]?.meta?.changes === 1 });
}

async function readPlaylistRevision(playlistID: string, revision: string, env: WorkerEnvironment) {
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
  const result: SqlRow = { ...playlist, assets: assets.results ?? [] };
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

async function resolveCaptureTarget(
  input: SqlRow,
  env: WorkerEnvironment,
  actorID: string,
  { preserveExistingSchedule = false }: { preserveExistingSchedule?: boolean } = {},
) {
  if (hasExactKeys(input, ["capture_id"])) {
    const existing = await env.DB.prepare(
      "SELECT capture_id, url, capture_interval_seconds, viewport_width, viewport_height, placeholder_sha256, placeholder_size, schedule_reviewed_at, capture_type " +
      "FROM capture_targets WHERE capture_id = ? AND enabled = 1",
    ).bind(input.capture_id).first();
    if (!existing) throw new HTTPError(409, "One of the webpage captures is no longer available.");
    if (existing.schedule_reviewed_at == null) throw new HTTPError(409, "Review and save this site's screenshot schedule before adding it to a playlist.");
    if (existing.capture_type !== "api-dashboard") {
      try {
        validateCaptureTargetURL(existing.url, env.CAPTURE_ALLOWED_HOSTS);
      } catch {
        throw new HTTPError(409, "One of the webpage capture hosts is not on the configured capture allowlist.");
      }
    }
    return {
      capture_id: existing.capture_id,
      url: existing.url,
      capture_interval_seconds: existing.capture_interval_seconds,
      viewport: { width: existing.viewport_width, height: existing.viewport_height },
      placeholder_sha256: existing.placeholder_sha256,
      placeholder_size: existing.placeholder_size,
      created: false,
    };
  }
  if (!hasOnlyKeys(input, ["url", "capture_interval_seconds", "viewport"]) ||
      !Object.hasOwn(input ?? {}, "url") || !Object.hasOwn(input ?? {}, "viewport")) {
    throw new HTTPError(400, "A webpage capture needs a URL, capture interval and viewport.");
  }

  let url;
  let settings;
  try {
    url = validateCaptureTargetURL(input.url, env.CAPTURE_ALLOWED_HOSTS);
    const captureSettings = { ...input };
    if (!Object.hasOwn(input, "capture_interval_seconds")) {
      captureSettings.capture_interval_seconds = DEFAULT_CAPTURE_INTERVAL_SECONDS;
    }
    settings = validateCaptureSettings(captureSettings);
  } catch (error) {
    throw new HTTPError(400, error instanceof Error ? error.message : String(error));
  }
  const variantKey = await sha256Hex(JSON.stringify({
    url,
    viewport_width: settings.viewport_width,
    viewport_height: settings.viewport_height,
    wait_until: "domcontentloaded",
  }));
  const existing = await env.DB.prepare(
      "SELECT capture_id, url, capture_interval_seconds, viewport_width, viewport_height, placeholder_sha256, placeholder_size, last_success_at, schedule_reviewed_at, enabled " +
    "FROM capture_targets WHERE variant_key = ?",
  ).bind(variantKey).first();
  if (existing) {
    if (!existing.enabled) {
      await env.DB.batch([
        env.DB.prepare("UPDATE capture_targets SET enabled = 1 WHERE capture_id = ?").bind(existing.capture_id),
        auditStatement(env, actorID, "capture.site_restored", "capture", existing.capture_id, {}),
      ]);
    }
    const interval = settings.capture_interval_seconds;
    if (!preserveExistingSchedule && interval !== existing.capture_interval_seconds) {
      const now = Date.now();
      const nextDueAt = existing.last_success_at == null
        ? now : Math.max(now, existing.last_success_at + interval * 1000);
      await env.DB.batch([
        env.DB.prepare("UPDATE capture_targets SET capture_interval_seconds = ?, next_due_at = ? WHERE capture_id = ?")
          .bind(interval, nextDueAt, existing.capture_id),
        auditStatement(env, actorID, "capture.interval_updated", "capture", existing.capture_id,
          { capture_interval_seconds: interval }, { onlyWhenPreviousChanged: true }),
      ]);
    }
    return {
      capture_id: existing.capture_id,
      url: existing.url,
      capture_interval_seconds: interval,
      viewport: { width: existing.viewport_width, height: existing.viewport_height },
      placeholder_sha256: existing.placeholder_sha256,
      placeholder_size: existing.placeholder_size,
      schedule_reviewed_at: existing.schedule_reviewed_at,
      created: false,
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
  const insertBatch = await env.DB.batch([
    markAssetLiveStatement(env.DB, placeholderAsset.sha256, placeholderAsset.size, now),
    env.DB.prepare(
      "INSERT OR IGNORE INTO capture_targets (capture_id, variant_key, url, capture_interval_seconds, viewport_width, viewport_height, " +
      "placeholder_sha256, placeholder_size, created_at, next_due_at, schedule_reviewed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
    ).bind(captureID, variantKey, url, settings.capture_interval_seconds, settings.viewport_width, settings.viewport_height,
      placeholderAsset.sha256, placeholderAsset.size, now, now),
    auditStatement(env, actorID, "capture.site_created", "capture", captureID, {
      capture_interval_seconds: settings.capture_interval_seconds,
      viewport: { width: settings.viewport_width, height: settings.viewport_height },
    }, { onlyWhenPreviousChanged: true }),
  ]);
  const target = await env.DB.prepare(
    "SELECT capture_id, url, capture_interval_seconds, viewport_width, viewport_height, placeholder_sha256, placeholder_size, schedule_reviewed_at " +
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
    schedule_reviewed_at: target.schedule_reviewed_at,
    created: insertBatch[1]?.meta?.changes === 1,
  };
}

async function createCaptureSite(request: Request, env: WorkerEnvironment, actorID: string) {
  const data = await readJSON(request);
  if (!hasExactKeys(data, ["url", "viewport"]) || !Object.hasOwn(data, "url") || !Object.hasOwn(data, "viewport")) {
    throw new HTTPError(400, "A site needs a URL and screenshot size.");
  }
  const site = await resolveCaptureTarget({
    url: data.url,
    capture_interval_seconds: DEFAULT_CAPTURE_INTERVAL_SECONDS,
    viewport: data.viewport,
  }, env, actorID, { preserveExistingSchedule: true });
  const { created, ...existingProperties } = site;
  return jsonResponse(
    { ...existingProperties, schedule_reviewed: site.schedule_reviewed_at != null },
    created ? 201 : 200,
  );
}

function percentile(values: number[], proportion: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * proportion) - 1)];
}

function summarizeApiDashboardJobs(jobs: Array<Record<string, any>>) {
  const succeeded = jobs.filter((job) => job.status === "succeeded");
  const fetchTimes = succeeded.map((job) => Number(job.api_fetch_ms)).filter((value) => Number.isFinite(value) && value > 0);
  const renderTimes = succeeded.map((job) => Number(job.api_render_ms)).filter((value) => Number.isFinite(value) && value > 0);
  const totalTimes = succeeded.map((job) => Number(job.api_total_ms)).filter((value) => Number.isFinite(value) && value > 0);
  const count = jobs.length;
  return {
    sample_count: count,
    successes: succeeded.length,
    failures: jobs.filter((job) => job.status === "failed").length,
    completed_count: succeeded.length + jobs.filter((job) => job.status === "failed").length,
    failure_rate: succeeded.length + jobs.filter((job) => job.status === "failed").length
      ? jobs.filter((job) => job.status === "failed").length / (succeeded.length + jobs.filter((job) => job.status === "failed").length)
      : null,
    retry_attempts: jobs.reduce((sum, job) => sum + Math.max(0, Number(job.attempts ?? 0) - 1), 0),
    partial_source_failures: jobs.filter((job) => job.api_outcome === "partial").length,
    all_source_failures: jobs.filter((job) => job.api_outcome === "all_failed").length,
    upstream_requests: jobs.reduce((sum, job) => sum + Number(job.api_request_count ?? 0), 0),
    not_modified_responses: jobs.reduce((sum, job) => sum + Number(job.api_not_modified_count ?? 0), 0),
    upstream_failed_requests: jobs.reduce((sum, job) => sum + Number(job.api_failed_request_count ?? 0), 0),
    response_bytes: jobs.reduce((sum, job) => sum + Number(job.api_response_bytes ?? 0), 0),
    fetch_p50_ms: percentile(fetchTimes, 0.5),
    fetch_p90_ms: percentile(fetchTimes, 0.9),
    render_p50_ms: percentile(renderTimes, 0.5),
    render_p90_ms: percentile(renderTimes, 0.9),
    total_p50_ms: percentile(totalTimes, 0.5),
    total_p90_ms: percentile(totalTimes, 0.9),
    render_operations: renderTimes.length,
    render_failures: jobs.filter((job) => Number(job.api_render_failed) === 1).length,
    content_hash_matches: succeeded.filter((job) => Number(job.api_content_hash_match) === 1).length,
    asset_reuses: succeeded.filter((job) => Number(job.api_asset_reused) === 1).length,
  };
}

async function readApiDashboards(env: WorkerEnvironment) {
  const [rows, recentJobs] = await Promise.all([env.DB.prepare(
    "SELECT t.capture_id, t.name, t.enabled, t.capture_interval_seconds, t.viewport_width, t.viewport_height, " +
    "t.current_sha256, t.current_size, t.last_attempt_at, t.last_success_at, t.last_error, t.next_due_at, " +
    "t.api_sources_json, t.api_status_json, t.api_last_fetch_at, t.api_last_image_at, " +
    "(SELECT j.status FROM capture_jobs j WHERE j.capture_id = t.capture_id ORDER BY j.created_at DESC LIMIT 1) AS job_status, " +
    "(SELECT j.retry_after_at FROM capture_jobs j WHERE j.capture_id = t.capture_id ORDER BY j.created_at DESC LIMIT 1) AS retry_after_at, " +
    "(SELECT j.recovery_attempts FROM capture_jobs j WHERE j.capture_id = t.capture_id ORDER BY j.created_at DESC LIMIT 1) AS recovery_attempts, " +
    "(SELECT j.api_fetch_ms FROM capture_jobs j WHERE j.capture_id = t.capture_id ORDER BY j.created_at DESC LIMIT 1) AS api_fetch_ms, " +
    "(SELECT j.api_render_ms FROM capture_jobs j WHERE j.capture_id = t.capture_id ORDER BY j.created_at DESC LIMIT 1) AS api_render_ms, " +
    "(SELECT j.api_total_ms FROM capture_jobs j WHERE j.capture_id = t.capture_id ORDER BY j.created_at DESC LIMIT 1) AS api_total_ms, " +
    "(SELECT j.api_asset_reused FROM capture_jobs j WHERE j.capture_id = t.capture_id ORDER BY j.created_at DESC LIMIT 1) AS api_asset_reused " +
    "FROM capture_targets t WHERE t.capture_type = 'api-dashboard' ORDER BY t.created_at DESC LIMIT 100",
  ).all(), env.DB.prepare(
    "WITH ranked AS (SELECT j.capture_id, j.status, j.attempts, j.created_at, j.api_fetch_ms, j.api_render_ms, j.api_total_ms, j.api_render_failed, j.api_asset_reused, " +
    "j.api_request_count, j.api_not_modified_count, j.api_failed_request_count, j.api_response_bytes, j.api_content_hash_match, j.api_outcome, " +
    "ROW_NUMBER() OVER (PARTITION BY j.capture_id ORDER BY j.created_at DESC, j.job_id DESC) AS sample_rank " +
    "FROM capture_jobs j JOIN capture_targets t ON t.capture_id = j.capture_id " +
    "WHERE t.capture_type = 'api-dashboard' AND j.created_at >= ?) " +
    "SELECT capture_id, status, attempts, created_at, api_fetch_ms, api_render_ms, api_total_ms, api_render_failed, api_asset_reused, api_request_count, " +
    "api_not_modified_count, api_failed_request_count, api_response_bytes, api_content_hash_match, api_outcome " +
    "FROM ranked WHERE sample_rank <= 100 ORDER BY capture_id, created_at DESC",
  ).bind(Date.now() - 30 * 24 * 60 * 60 * 1000).all()]);
  const jobsByCapture = new Map<string, Array<Record<string, any>>>();
  for (const job of recentJobs.results ?? []) {
    const items = jobsByCapture.get(job.capture_id) ?? [];
    items.push(job);
    jobsByCapture.set(job.capture_id, items);
  }
  const now = Date.now();
  return (rows.results ?? []).map((row) => ({
    ...row,
    stale: row.enabled === 1 && Number(row.next_due_at) < now - Number(row.capture_interval_seconds) * 1000,
    current_image: row.current_sha256 ? `/admin/api/assets/${row.current_sha256}` : null,
    configuration: parseMetadata(row.api_sources_json),
    sources: parseMetadataArray(row.api_status_json),
    recent_metrics: summarizeApiDashboardJobs(jobsByCapture.get(row.capture_id) ?? []),
  }));
}

function validateApiDashboardInput(data: Record<string, any>, allowedHosts: string) {
  if (typeof data.name !== "string" || !data.name.trim() || data.name.trim().length > 120 || /[\u0000-\u001f\u007f]/.test(data.name)) throw new HTTPError(400, "Dashboard name must be 1 to 120 characters on one line.");
  const interval = data.capture_interval_seconds ?? 300;
  if (![60, 300].includes(interval)) throw new HTTPError(400, "API dashboard interval must be 60 or 300 seconds.");
  let config;
  try { config = parseApiDashboardConfig({ sources: data.sources, width: data.width ?? 1920, height: data.height ?? 1080 }); }
  catch (error) { throw new HTTPError(400, error instanceof Error ? error.message : String(error)); }
  for (const source of config.sources) {
    try { validateSourceConfig(source, allowedHosts); }
    catch (error) { throw new HTTPError(400, error instanceof Error ? error.message : String(error)); }
  }
  return { name: data.name.trim(), interval, config };
}

async function createApiDashboard(request: Request, env: WorkerEnvironment, actorID: string) {
  const data = await readJSON(request);
  if (!hasOnlyKeys(data, ["name", "capture_interval_seconds", "width", "height", "sources"]) || !isRecord(data)) throw new HTTPError(400, "Dashboard configuration contains unsupported fields.");
  const { name, interval, config } = validateApiDashboardInput(data, env.API_STATUS_ALLOWED_HOSTS ?? "");
  const placeholder = await env.ASSETS.get("admin/capture-pending.png");
  if (!placeholder) throw new HTTPError(503, "The built-in image is unavailable. Publish management assets and retry.");
  const placeholderAsset = await storePngAsset(new Uint8Array(await placeholder.arrayBuffer()), env.ASSETS, { db: env.DB });
  const captureID = crypto.randomUUID();
  const now = Date.now();
  const configJson = JSON.stringify(config);
  const variantKey = `api-${captureID}`;
  await env.DB.batch([
    markAssetLiveStatement(env.DB, placeholderAsset.sha256, placeholderAsset.size, now),
    env.DB.prepare(
      "INSERT INTO capture_targets (capture_id, variant_key, url, capture_interval_seconds, viewport_width, viewport_height, placeholder_sha256, placeholder_size, created_at, next_due_at, schedule_reviewed_at, name, capture_type, api_sources_json) " +
      "VALUES (?, ?, 'https://api-dashboard.invalid/', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'api-dashboard', ?)",
    ).bind(captureID, variantKey, interval, config.width, config.height, placeholderAsset.sha256, placeholderAsset.size, now, now, now, name, configJson),
    auditStatement(env, actorID, "api_dashboard.created", "capture", captureID, { capture_interval_seconds: interval, width: config.width, height: config.height, source_count: config.sources.length }),
  ]);
  return jsonResponse({ capture_id: captureID, name, capture_interval_seconds: interval, width: config.width, height: config.height, created: true }, 201);
}

async function updateApiDashboard(request: Request, captureID: string, env: WorkerEnvironment, actorID: string) {
  const data = await readJSON(request);
  if (!isRecord(data) || !hasOnlyKeys(data, ["name", "enabled", "capture_interval_seconds", "width", "height", "sources"])) throw new HTTPError(400, "Dashboard update contains unsupported fields.");
  const existing = await env.DB.prepare("SELECT * FROM capture_targets WHERE capture_id = ? AND capture_type = 'api-dashboard'")
    .bind(captureID).first();
  if (!existing) throw new HTTPError(404, "API dashboard could not be found.");
  const updates: string[] = [];
  const values: unknown[] = [];
  if (Object.hasOwn(data, "name")) {
    if (typeof data.name !== "string" || !data.name.trim() || data.name.trim().length > 120 || /[\u0000-\u001f\u007f]/.test(data.name)) throw new HTTPError(400, "Dashboard name must be 1 to 120 characters on one line.");
    updates.push("name = ?"); values.push(data.name.trim());
  }
  if (Object.hasOwn(data, "enabled")) {
    if (typeof data.enabled !== "boolean") throw new HTTPError(400, "enabled must be true or false.");
    updates.push("enabled = ?"); values.push(data.enabled ? 1 : 0);
  }
  if (Object.hasOwn(data, "capture_interval_seconds")) {
    if (data.capture_interval_seconds !== 60 && data.capture_interval_seconds !== 300) throw new HTTPError(400, "API dashboard interval must be 60 or 300 seconds.");
    updates.push("capture_interval_seconds = ?"); values.push(data.capture_interval_seconds);
  }
  if (Object.hasOwn(data, "sources") || Object.hasOwn(data, "width") || Object.hasOwn(data, "height")) {
    let previous;
    try { previous = JSON.parse(existing.api_sources_json); } catch { throw new HTTPError(409, "Stored API dashboard configuration is invalid."); }
    const config = parseApiDashboardConfig({ sources: data.sources ?? previous.sources, width: data.width ?? previous.width, height: data.height ?? previous.height });
    for (const source of config.sources) {
      try { validateSourceConfig(source, env.API_STATUS_ALLOWED_HOSTS ?? ""); }
      catch (error) { throw new HTTPError(400, error instanceof Error ? error.message : String(error)); }
    }
    updates.push("api_sources_json = ?", "viewport_width = ?", "viewport_height = ?");
    values.push(JSON.stringify(config), config.width, config.height);
  }
  if (!updates.length) throw new HTTPError(400, "No dashboard changes were supplied.");
  const now = Date.now();
  updates.push("next_due_at = ?", "schedule_reviewed_at = ?"); values.push(now, now, captureID);
  await env.DB.batch([
    env.DB.prepare(`UPDATE capture_targets SET ${updates.join(", ")} WHERE capture_id = ? AND capture_type = 'api-dashboard'`).bind(...values),
    auditStatement(env, actorID, "api_dashboard.updated", "capture", captureID, { fields: Object.keys(data) }),
  ]);
  return jsonResponse({ capture_id: captureID, updated: true });
}

async function activatePlaylist(request: Request, env: WorkerEnvironment, actorID: string) {
  const data = await readJSON(request);
  if (!hasExactKeys(data, ["playlist_id", "revision"]) || !isString(data.playlist_id) ||
      !isString(data.revision) || !ID_PATTERN.test(data.playlist_id) || !ID_PATTERN.test(data.revision)) {
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

async function deletePlaylist(playlistID: string, env: WorkerEnvironment, actorID: string) {
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

async function setDeviceEnabled(request: Request, deviceID: string, env: WorkerEnvironment, actorID: string) {
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

async function deleteDevice(deviceID: string, env: WorkerEnvironment, actorID: string) {
  const device = await env.DB.prepare("SELECT device_id FROM devices WHERE device_id = ?").bind(deviceID).first();
  if (!device) throw new HTTPError(404, "device not found");
  const now = Date.now();
  const results = await env.DB.batch([
    env.DB.prepare(
      "UPDATE enrollment_requests SET status = 'rejected', decided_at = ?, actor_id = ? " +
      "WHERE device_id = ? AND status = 'pending'",
    ).bind(now, actorID, deviceID),
    env.DB.prepare("DELETE FROM devices WHERE device_id = ?").bind(deviceID),
    auditStatement(env, actorID, "device.deleted", "device", deviceID, {}, { onlyWhenPreviousChanged: true }),
  ]);
  if (results?.[1]?.meta?.changes !== 1) throw new HTTPError(404, "device not found");
  return jsonResponse({ device_id: deviceID, deleted: true });
}

async function rotateDeviceCredential(request: Request, deviceID: string, env: WorkerEnvironment, actorID: string) {
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

function auditStatement(
  env: WorkerEnvironment,
  actorID: string,
  eventType: string,
  subjectType: string,
  subjectID: string,
  metadata: unknown,
  { onlyWhenPreviousChanged = false }: { onlyWhenPreviousChanged?: boolean } = {},
) {
  const insert = onlyWhenPreviousChanged
    ? "SELECT ?, ?, ?, ?, ?, ?, ? WHERE changes() > 0"
    : "VALUES (?, ?, ?, ?, ?, ?, ?)";
  return env.DB.prepare(
    "INSERT INTO audit_events (event_id, actor_id, event_type, subject_type, subject_id, occurred_at, metadata_json) " +
    insert,
  ).bind(crypto.randomUUID(), actorID, eventType, subjectType, subjectID, Date.now(), JSON.stringify(metadata));
}

async function readJSON(request: Request): Promise<unknown> {
  if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new HTTPError(415, "Content-Type must be application/json");
  }
  const bytes = await readBytes(request, MAX_JSON_BYTES);
  return parseJSONBody(bytes);
}

function parseMetadata(value: unknown): SqlRow | null {
  if (!isString(value)) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed as SqlRow : {};
  } catch { return {}; }
}

function parseMetadataArray(value: unknown) {
  if (!isString(value)) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function methodNotAllowed(allowed: string) {
  return new Response("method not allowed", { status: 405, headers: { Allow: allowed } });
}
