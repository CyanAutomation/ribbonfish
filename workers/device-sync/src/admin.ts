import { jsonResponse } from "./http-response.ts";
import { ADMIN_ASSETS } from "./admin-assets.ts";
import { matchesETag } from "./http-cache.ts";
import { readRequestBody as readBytes } from "./request-body.ts";
import { randomToken, sha256Hex } from "./crypto-primitives.ts";
export { sha256Hex } from "./crypto-primitives.ts";
import { HTTPError } from "./http-error.ts";
import { hasExactKeys, hasOnlyKeys, isRecord, isString } from "./validation.ts";
import { readAdminJSON as readJSON } from "./admin-request.ts";
import { parseMetadata } from "./admin-metadata.ts";
import { auditStatement } from "./admin-audit.ts";
import { createApiDashboard, readApiDashboards, updateApiDashboard } from "./admin-api-dashboards.ts";
import {
  configuredCaptureReserveMs,
  readCaptureForecast,
  readDeviceHealth,
  readDeviceHealthHistory,
  readEnrollmentRequests,
  readOverview,
} from "./admin-read-models.ts";
import {
  DEFAULT_CAPTURE_INTERVAL_SECONDS,
  DEFAULT_ROTATION_INTERVAL,
  intervalCatalog,
  isSupportedCaptureInterval,
  isSupportedRotationInterval,
} from "./intervals.ts";
import { isPNG, MAX_ASSET_BYTES, storePngAsset } from "./asset-store.ts";
import { normalizeCaptureSelector, validateCaptureSettings, validateCaptureTargetURL } from "./capture.ts";
import { CaptureTargetNotAllowedError, dispatchDueCaptures, enqueueCapture } from "./capture-workflow.ts";
import { AssetDeletionInProgressError, markAssetLiveStatement } from "./asset-registry.ts";
import { callJevDecision, JEVRequestError, validateAnswers } from "./jev.ts";
import { summarizeCaptureDurations } from "./capture-duration.ts";
import type { CaptureDurationSampleSummaryInput } from "./capture-duration.ts";
import {
  buildCaptureAssessmentState,
  captureAssessmentQuestions,
  buildPlaylistReadinessState,
  durationReviewRecommendation,
  playlistReadinessQuestions,
} from "./jev-use-cases.ts";
import { assessPlaylistReadiness } from "./playlist-readiness.ts";
import { readPlaylistContent } from "./playlist-revision.ts";
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
type PlaylistAssetInput = { sha256: string; size: number };
type PlaylistCaptureInput = { capture_id: string };

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAPTURE_DURATION_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const CAPTURE_DURATION_REVIEW_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const CAPTURE_DURATION_SUMMARY_LIMIT = 50_000;
const ADMIN_FILES: Map<string, { key: string; contentType: string; maxAge: number }> = new Map(ADMIN_ASSETS.map(({ pathname, key, contentType, maxAge }) =>
  [pathname, { key, contentType, maxAge }] as const));

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
          return {
            ...summary,
            ...projectCaptureJevAnswers(decision?.answers),
            duration_review: durationReviewRecommendation(decision?.answers, state?.capture_duration),
          };
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
          ...projectCaptureJevAnswers(decision.answers),
          duration_review: durationReviewRecommendation(decision.answers, target.duration_summary),
          skip_eligibility: captureSkipEligibility(target, Date.now()),
        });
      });
    case "/admin/api/jev/playlist-readiness-assessment":
      return await withAdminMethod(request, "POST", async () => {
        const data = await readJSON(request);
        if (!hasExactKeys(data, ["playlist_id", "revision"]) || !isString(data.playlist_id) || !ID_PATTERN.test(data.playlist_id) ||
          !isString(data.revision) || !ID_PATTERN.test(data.revision)) {
          throw new HTTPError(400, "playlist_id and revision are required");
        }
        await enforceJevRateLimit(env, actorID);
        const readiness = await readPlaylistReadiness(data.playlist_id, data.revision, env);
        const decision = await callJevDecision(env, {
          state: buildPlaylistReadinessState(readiness),
          questions: playlistReadinessQuestions,
        });
        const now = Date.now();
        await env.DB.prepare(
          "INSERT INTO playlist_readiness_assessments " +
          "(assessment_id, playlist_id, revision, assessed_at, deterministic_status, decision_json, model) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).bind(randomToken(), data.playlist_id, data.revision, now, readiness.status,
          JSON.stringify(decision.answers), decision.model).run();
        await env.DB.prepare("DELETE FROM playlist_readiness_assessments WHERE assessed_at < ?")
          .bind(now - 30 * 24 * 60 * 60 * 1000).run();
        const answers = projectPlaylistJevAnswers(decision.answers);
        readiness.latest_assessment = answers ? {
          assessed_at: now,
          deterministic_status: readiness.status,
          answers,
          observed_outcome: null,
        } : null;
        return jsonResponse(readiness);
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
  const readinessMatch = url.pathname.match(/^\/admin\/api\/playlists\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/readiness$/);
  if (readinessMatch) {
    return await withAdminMethod(request, "GET", async () => jsonResponse(
      await readPlaylistReadiness(decodeURIComponent(readinessMatch[1]), decodeURIComponent(readinessMatch[2]), env),
    ));
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

function projectCaptureJevAnswers(answers: unknown) {
  if (!validateAnswers(answers, captureAssessmentQuestions)) return { suggestion: null, suggestion_confidence: null, risk: null };
  const recommendation = answers.recommendation;
  const risk = answers.risk;
  const riskLabels = ["Low", "Moderate", "High"];
  const riskScore = risk.type === "score" && typeof risk.score === "number" ? risk.score : null;
  const riskLabel = riskScore === null ? "Unknown" : riskLabels[Math.round(riskScore)] ?? "Unknown";
  return {
    suggestion: recommendation.type === "choice" ? recommendation.choice : null,
    suggestion_confidence: recommendation.confidence ?? null,
    risk: riskScore === null ? null : { score: riskScore, label: riskLabel, confidence: risk.confidence ?? null },
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
  const query = parseCaptureDurationQuery(searchParams, now);
  const target = await env.DB.prepare("SELECT capture_id FROM capture_targets WHERE capture_id = ?")
    .bind(captureID).first();
  if (!target) throw new HTTPError(404, "That webpage capture could not be found.");

  const retainedSince = now - CAPTURE_DURATION_RETENTION_MS;
  const since = Math.max(query.since ?? retainedSince, retainedSince);
  const [summaryRows, page] = await Promise.all([
    env.DB.prepare(
      "SELECT browser_ms, browser_ms_source, reserve_ms, attempt, outcome FROM capture_duration_samples " +
      "WHERE capture_id = ? AND sampled_at >= ? ORDER BY sampled_at DESC, sample_id DESC LIMIT ?",
    ).bind(captureID, since, CAPTURE_DURATION_SUMMARY_LIMIT).all<CaptureDurationSampleSummaryInput>(),
    readCaptureDurationPage(captureID, since, query, env),
  ]);
  const samples = page.results.slice(0, query.limit);
  const last = samples.at(-1);
  const reserveMs = configuredCaptureReserveMs(env);
  return {
    capture_id: captureID,
    retained_since: since,
    configured_reserve_ms: reserveMs,
    summary_sample_limit: CAPTURE_DURATION_SUMMARY_LIMIT,
    summary_truncated: (summaryRows.results ?? []).length === CAPTURE_DURATION_SUMMARY_LIMIT,
    summary: summarizeCaptureDurations(summaryRows.results ?? [], reserveMs),
    samples,
    next_before: page.hasMore && last ? last.sampled_at : null,
    next_before_sample_id: page.hasMore && last ? last.sample_id : null,
  };
}

function parseCaptureDurationQuery(searchParams: URLSearchParams, now: number) {
  for (const key of searchParams.keys()) {
    if (!["since", "limit", "before", "before_sample_id"].includes(key)) {
      throw new HTTPError(400, `unsupported query parameter: ${key}`);
    }
  }
  const requestedLimit = parseOptionalQueryInteger(searchParams.get("limit"), "limit");
  const limit = requestedLimit ?? 50;
  if (limit < 1 || limit > 100) throw new HTTPError(400, "limit must be an integer from 1 to 100");
  const since = parseOptionalQueryInteger(searchParams.get("since"), "since");
  if (since !== null && since > now) throw new HTTPError(400, "since must not be in the future");
  const before = parseOptionalQueryInteger(searchParams.get("before"), "before");
  const beforeSampleID = searchParams.get("before_sample_id");
  if ((before === null) !== (beforeSampleID === null) || (beforeSampleID !== null && (!beforeSampleID || beforeSampleID.length > 128))) {
    throw new HTTPError(400, "before and before_sample_id must be supplied together");
  }
  if (before !== null && before > now) throw new HTTPError(400, "before must not be in the future");
  return { limit, since, before, beforeSampleID };
}

async function readCaptureDurationPage(
  captureID: string,
  since: number,
  query: ReturnType<typeof parseCaptureDurationQuery>,
  env: WorkerEnvironment,
) {
  let sql = "SELECT sample_id, capture_id, job_id, attempt, sampled_at, browser_ms, browser_ms_source, reserve_ms, " +
    "browser_run_elapsed_ms, capture_elapsed_ms, outcome, readiness_mode, readiness_selector FROM capture_duration_samples " +
    "WHERE capture_id = ? AND sampled_at >= ?";
  const values = [captureID, since];
  if (query.before !== null && query.beforeSampleID !== null) {
    sql += " AND (sampled_at < ? OR (sampled_at = ? AND sample_id < ?))";
    values.push(query.before, query.before, query.beforeSampleID);
  }
  sql += " ORDER BY sampled_at DESC, sample_id DESC LIMIT ?";
  values.push(query.limit + 1);
  const page = await env.DB.prepare(sql).bind(...values).all<SqlRow>();
  const results = page.results ?? [];
  return { results, hasMore: results.length > query.limit };
}

function parseOptionalQueryInteger(value: string | null, name: string): number | null {
  if (value === null) return null;
  if (!/^\d+$/.test(value)) throw new HTTPError(400, `${name} must be a nonnegative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new HTTPError(400, `${name} must be a nonnegative integer`);
  return parsed;
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

const PLAYLIST_CAPTURE_FRESHNESS_MS = 30 * 24 * 60 * 60 * 1000;

async function readPlaylistReadiness(playlistID: string, revision: string, env: WorkerEnvironment, now = Date.now()) {
  const playlist = await env.DB.prepare(
    "SELECT playlist_id, revision FROM playlists WHERE playlist_id = ? AND revision = ?",
  ).bind(playlistID, revision).first();
  if (!playlist) throw new HTTPError(404, "That playlist revision could not be found.");

  const [assetRows, captureRows, deviceRows, active, latestAssessment] = await Promise.all([
    env.DB.prepare(
      "SELECT position, sha256, size FROM playlist_assets WHERE playlist_id = ? AND revision = ? ORDER BY position",
    ).bind(playlistID, revision).all<SqlRow>(),
    env.DB.prepare(
      "SELECT p.position, p.capture_id, t.enabled, t.schedule_reviewed_at, t.last_success_at, " +
      "t.current_sha256, t.current_size, t.placeholder_sha256, t.placeholder_size " +
      "FROM playlist_capture_items p LEFT JOIN capture_targets t ON t.capture_id = p.capture_id " +
      "WHERE p.playlist_id = ? AND p.revision = ? ORDER BY p.position",
    ).bind(playlistID, revision).all<SqlRow>(),
    env.DB.prepare(
      "SELECT d.device_id, d.enabled, h.applied_playlist_id, h.applied_revision, h.health_status " +
      "FROM devices d LEFT JOIN device_health_latest h ON h.device_id = d.device_id WHERE d.enabled = 1 ORDER BY d.device_id",
    ).all<SqlRow>(),
    env.DB.prepare("SELECT playlist_id, revision FROM active_playlist WHERE singleton = 1").first<SqlRow>(),
    env.DB.prepare(
      "SELECT assessed_at, deterministic_status, decision_json, model FROM playlist_readiness_assessments " +
      "WHERE playlist_id = ? AND revision = ? ORDER BY assessed_at DESC LIMIT 1",
    ).bind(playlistID, revision).first<SqlRow>(),
  ]);

  const assets = await Promise.all((assetRows.results ?? []).map(async (asset) => ({
    position: Number(asset.position),
    present: await assetMatches(env, asset.sha256, asset.size),
  })));
  const captures = await Promise.all((captureRows.results ?? []).map(async (capture, index) => {
    const lastSuccessAt = Number.isSafeInteger(capture.last_success_at) ? capture.last_success_at : null;
    const fresh = lastSuccessAt !== null && lastSuccessAt >= now - PLAYLIST_CAPTURE_FRESHNESS_MS;
    const currentSelected = fresh && typeof capture.current_sha256 === "string";
    const imageHash = currentSelected ? capture.current_sha256 : capture.placeholder_sha256;
    const imageSize = currentSelected ? capture.current_size : capture.placeholder_size;
    return {
      capture_id: typeof capture.capture_id === "string" ? capture.capture_id : `missing-${index}`,
      fresh,
      enabled: capture.enabled === 1,
      schedule_reviewed: capture.schedule_reviewed_at !== null && capture.schedule_reviewed_at !== undefined,
      asset_present: await assetMatches(env, imageHash, imageSize),
    };
  }));
  const content = await readPlaylistContent(env, playlistID, revision, now);
  const readiness = assessPlaylistReadiness({
    revision: { playlist_id: playlistID, revision, effective_revision: content.effective_revision },
    assets,
    captures,
    devices: (deviceRows.results ?? []).map((device) => ({
      device_id: String(device.device_id ?? ""),
      enabled: device.enabled === 1,
      applied_playlist_id: typeof device.applied_playlist_id === "string" ? device.applied_playlist_id : null,
      applied_revision: typeof device.applied_revision === "string" || typeof device.applied_revision === "number"
        ? device.applied_revision : null,
    })),
  });
  const latestAnswers = parseMetadata(latestAssessment?.decision_json);
  const projectedAssessment = projectPlaylistJevAnswers(latestAnswers);
  let observedOutcome: string | null = null;
  if (latestAssessment) {
    const activeRevision = active?.playlist_id === playlistID && String(active.revision) === revision;
    observedOutcome = !activeRevision ? "not_activated"
      : readiness.devices_to_update.length === 0 ? (deviceRows.results?.length ? "all_devices_applied" : "no_enabled_devices")
        : "awaiting_device_sync";
  }

  return {
    ...readiness,
    latest_assessment: latestAssessment && projectedAssessment ? {
      assessed_at: latestAssessment.assessed_at,
      deterministic_status: latestAssessment.deterministic_status,
      answers: projectedAssessment,
      observed_outcome: observedOutcome,
    } : null,
  };
}

async function assetMatches(env: WorkerEnvironment, sha256: unknown, expectedSize: unknown) {
  if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256) ||
    typeof expectedSize !== "number" || !Number.isSafeInteger(expectedSize) || expectedSize <= 0) return false;
  const object = await env.ASSETS.head(`assets/${sha256}`);
  return Boolean(object && object.size === expectedSize);
}

function projectPlaylistJevAnswers(answers: unknown) {
  if (!validateAnswers(answers, playlistReadinessQuestions)) return null;
  const assessment = answers.assessment;
  const risk = answers.risk;
  const labels = ["Low", "Moderate", "High"];
  const riskScore = risk.type === "score" && typeof risk.score === "number" ? risk.score : null;
  return {
    assessment: assessment.type === "choice" ? { choice: assessment.choice, confidence: assessment.confidence ?? null } : null,
    risk: riskScore === null ? null : {
      score: riskScore,
      label: labels[Math.round(riskScore)] ?? "Unknown",
      confidence: risk.confidence ?? null,
    },
  };
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
  if (hasExactKeys(input, ["capture_id"])) return resolveExistingCaptureTarget(input, env);
  const { url, settings } = validateNewCaptureTarget(input, env);
  const variantKey = await captureVariantKey(url, settings);
  const existing = await findCaptureTargetByVariant(variantKey, env);
  if (existing) return restoreExistingCaptureTarget(existing, settings, env, actorID, preserveExistingSchedule);
  return createCaptureTarget(variantKey, url, settings, env, actorID);
}

async function resolveExistingCaptureTarget(input: SqlRow, env: WorkerEnvironment) {
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
  return captureTargetResult(existing, false);
}

function validateNewCaptureTarget(input: SqlRow, env: WorkerEnvironment) {
  if (!hasOnlyKeys(input, ["url", "capture_interval_seconds", "viewport"]) ||
      !Object.hasOwn(input ?? {}, "url") || !Object.hasOwn(input ?? {}, "viewport")) {
    throw new HTTPError(400, "A webpage capture needs a URL, capture interval and viewport.");
  }
  try {
    const url = validateCaptureTargetURL(input.url, env.CAPTURE_ALLOWED_HOSTS);
    const captureSettings = { ...input };
    if (!Object.hasOwn(input, "capture_interval_seconds")) {
      captureSettings.capture_interval_seconds = DEFAULT_CAPTURE_INTERVAL_SECONDS;
    }
    return { url, settings: validateCaptureSettings(captureSettings) };
  } catch (error) {
    throw new HTTPError(400, error instanceof Error ? error.message : String(error));
  }
}

async function captureVariantKey(url: string, settings: ReturnType<typeof validateCaptureSettings>) {
  return sha256Hex(JSON.stringify({
    url,
    viewport_width: settings.viewport_width,
    viewport_height: settings.viewport_height,
    wait_until: "domcontentloaded",
  }));
}

async function findCaptureTargetByVariant(variantKey: string, env: WorkerEnvironment) {
  return env.DB.prepare(
    "SELECT capture_id, url, capture_interval_seconds, viewport_width, viewport_height, placeholder_sha256, placeholder_size, last_success_at, schedule_reviewed_at, enabled " +
    "FROM capture_targets WHERE variant_key = ?",
  ).bind(variantKey).first();
}

async function restoreExistingCaptureTarget(
  existing: SqlRow,
  settings: ReturnType<typeof validateCaptureSettings>,
  env: WorkerEnvironment,
  actorID: string,
  preserveExistingSchedule: boolean,
) {
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
  return captureTargetResult({ ...existing, capture_interval_seconds: interval }, false, true);
}

function captureTargetResult(target: SqlRow, created: boolean, includeScheduleReview = false) {
  return {
    capture_id: target.capture_id,
    url: target.url,
    capture_interval_seconds: target.capture_interval_seconds,
    viewport: { width: target.viewport_width, height: target.viewport_height },
    placeholder_sha256: target.placeholder_sha256,
    placeholder_size: target.placeholder_size,
    ...(includeScheduleReview ? { schedule_reviewed_at: target.schedule_reviewed_at } : {}),
    created,
  };
}

async function createCaptureTarget(
  variantKey: string,
  url: string,
  settings: ReturnType<typeof validateCaptureSettings>,
  env: WorkerEnvironment,
  actorID: string,
) {
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
  return captureTargetResult(target, insertBatch[1]?.meta?.changes === 1, true);
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
  const readiness = await readPlaylistReadiness(data.playlist_id, data.revision, env);
  if (readiness.blockers.length) {
    throw new HTTPError(409, "This revision has missing assets or disabled capture items. Review readiness before activation.");
  }

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

function methodNotAllowed(allowed: string) {
  return new Response("method not allowed", { status: 405, headers: { Allow: allowed } });
}
