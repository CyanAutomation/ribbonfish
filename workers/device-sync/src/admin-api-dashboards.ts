import { jsonResponse } from "./http-response.ts";
import { HTTPError } from "./http-error.ts";
import { hasOnlyKeys, isRecord } from "./validation.ts";
import { parseApiDashboardConfig } from "./api-dashboard/index.ts";
import { validateSourceConfig } from "./api-dashboard/adapters.ts";
import { storePngAsset } from "./asset-store.ts";
import { markAssetLiveStatement } from "./asset-registry.ts";
import { auditStatement } from "./admin-audit.ts";
import { readAdminJSON } from "./admin-request.ts";
import { parseMetadata, parseMetadataArray } from "./admin-metadata.ts";
import type { SqlRow, WorkerEnvironment } from "./worker-contracts.ts";

const DASHBOARD_FIELDS = ["name", "enabled", "capture_interval_seconds", "width", "height", "sources"];

type DashboardUpdatePlan = { updates: string[]; values: unknown[] };

function percentile(values: number[], proportion: number): number | null {
  if (!values.length) return null;
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * proportion) - 1)];
}

function summarizeApiDashboardJobs(jobs: Array<Record<string, any>>) {
  const succeeded = jobs.filter((job) => job.status === "succeeded");
  const failed = jobs.filter((job) => job.status === "failed");
  const fetchTimes = succeeded.map((job) => Number(job.api_fetch_ms)).filter((value) => Number.isFinite(value) && value > 0);
  const renderTimes = succeeded.map((job) => Number(job.api_render_ms)).filter((value) => Number.isFinite(value) && value > 0);
  const totalTimes = succeeded.map((job) => Number(job.api_total_ms)).filter((value) => Number.isFinite(value) && value > 0);
  const completed = succeeded.length + failed.length;
  return {
    sample_count: jobs.length,
    successes: succeeded.length,
    failures: failed.length,
    completed_count: completed,
    failure_rate: completed ? failed.length / completed : null,
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

export async function readApiDashboards(env: WorkerEnvironment) {
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
  if (typeof data.name !== "string" || !data.name.trim() || data.name.trim().length > 120 || /[\u0000-\u001f\u007f]/.test(data.name)) {
    throw new HTTPError(400, "Dashboard name must be 1 to 120 characters on one line.");
  }
  const interval = data.capture_interval_seconds ?? 300;
  if (![60, 300].includes(interval)) throw new HTTPError(400, "API dashboard interval must be 60 or 300 seconds.");
  const config = parseConfigForRequest({ sources: data.sources, width: data.width ?? 1920, height: data.height ?? 1080 }, allowedHosts);
  return { name: data.name.trim(), interval, config };
}

function parseConfigForRequest(input: unknown, allowedHosts: string) {
  let config;
  try { config = parseApiDashboardConfig(input); }
  catch (error) { throw new HTTPError(400, error instanceof Error ? error.message : String(error)); }
  for (const source of config.sources) {
    try { validateSourceConfig(source, allowedHosts); }
    catch (error) { throw new HTTPError(400, error instanceof Error ? error.message : String(error)); }
  }
  return config;
}

export async function createApiDashboard(request: Request, env: WorkerEnvironment, actorID: string): Promise<Response> {
  const data = await readAdminJSON(request);
  if (!hasOnlyKeys(data, ["name", "capture_interval_seconds", "width", "height", "sources"]) || !isRecord(data)) {
    throw new HTTPError(400, "Dashboard configuration contains unsupported fields.");
  }
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

export async function updateApiDashboard(request: Request, captureID: string, env: WorkerEnvironment, actorID: string): Promise<Response> {
  const rawData = await readAdminJSON(request);
  if (!isRecord(rawData) || !hasOnlyKeys(rawData, DASHBOARD_FIELDS)) {
    throw new HTTPError(400, "Dashboard update contains unsupported fields.");
  }
  const data = rawData as Record<string, any>;
  const existing = await env.DB.prepare("SELECT * FROM capture_targets WHERE capture_id = ? AND capture_type = 'api-dashboard'")
    .bind(captureID).first();
  if (!existing) throw new HTTPError(404, "API dashboard could not be found.");
  const plan = createDashboardUpdatePlan(data, existing, env.API_STATUS_ALLOWED_HOSTS ?? "");
  if (!plan.updates.length) throw new HTTPError(400, "No dashboard changes were supplied.");
  const now = Date.now();
  plan.updates.push("next_due_at = ?", "schedule_reviewed_at = ?");
  plan.values.push(now, now, captureID);
  await env.DB.batch([
    env.DB.prepare(`UPDATE capture_targets SET ${plan.updates.join(", ")} WHERE capture_id = ? AND capture_type = 'api-dashboard'`).bind(...plan.values),
    auditStatement(env, actorID, "api_dashboard.updated", "capture", captureID, { fields: Object.keys(data) }),
  ]);
  return jsonResponse({ capture_id: captureID, updated: true });
}

function createDashboardUpdatePlan(data: Record<string, any>, existing: SqlRow, allowedHosts: string): DashboardUpdatePlan {
  const changes = [
    nameUpdate(data),
    enabledUpdate(data),
    intervalUpdate(data),
    configUpdate(data, existing, allowedHosts),
  ].filter((change): change is DashboardUpdatePlan => change !== null);
  return changes.reduce<DashboardUpdatePlan>((plan, change) => ({
    updates: [...plan.updates, ...change.updates],
    values: [...plan.values, ...change.values],
  }), { updates: [], values: [] });
}

function nameUpdate(data: Record<string, any>): DashboardUpdatePlan | null {
  if (!Object.hasOwn(data, "name")) return null;
  if (typeof data.name !== "string" || !data.name.trim() || data.name.trim().length > 120 || /[\u0000-\u001f\u007f]/.test(data.name)) {
    throw new HTTPError(400, "Dashboard name must be 1 to 120 characters on one line.");
  }
  return { updates: ["name = ?"], values: [data.name.trim()] };
}

function enabledUpdate(data: Record<string, any>): DashboardUpdatePlan | null {
  if (!Object.hasOwn(data, "enabled")) return null;
  if (typeof data.enabled !== "boolean") throw new HTTPError(400, "enabled must be true or false.");
  return { updates: ["enabled = ?"], values: [data.enabled ? 1 : 0] };
}

function intervalUpdate(data: Record<string, any>): DashboardUpdatePlan | null {
  if (!Object.hasOwn(data, "capture_interval_seconds")) return null;
  if (data.capture_interval_seconds !== 60 && data.capture_interval_seconds !== 300) {
    throw new HTTPError(400, "API dashboard interval must be 60 or 300 seconds.");
  }
  return { updates: ["capture_interval_seconds = ?"], values: [data.capture_interval_seconds] };
}

function configUpdate(data: Record<string, any>, existing: SqlRow, allowedHosts: string): DashboardUpdatePlan | null {
  if (!Object.hasOwn(data, "sources") && !Object.hasOwn(data, "width") && !Object.hasOwn(data, "height")) return null;
  let previous;
  try { previous = JSON.parse(existing.api_sources_json); }
  catch { throw new HTTPError(409, "Stored API dashboard configuration is invalid."); }
  const config = parseConfigForRequest({
    sources: data.sources ?? previous.sources,
    width: data.width ?? previous.width,
    height: data.height ?? previous.height,
  }, allowedHosts);
  return {
    updates: ["api_sources_json = ?", "viewport_width = ?", "viewport_height = ?"],
    values: [JSON.stringify(config), config.width, config.height],
  };
}
