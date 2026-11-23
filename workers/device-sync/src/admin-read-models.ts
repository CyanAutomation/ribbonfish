import { HTTPError } from "./http-error.ts";
import { isRecord, isString } from "./validation.ts";
import { parseMetadata } from "./admin-metadata.ts";
import { deriveDeviceHealth, type DeviceHealthReport } from "./device-health.ts";
import { classifyReserveReview } from "./capture-duration.ts";
import { summarizeCaptureHistory } from "./capture-workbench.ts";
import { readPlaylistContent } from "./playlist-revision.ts";
import {
  calculateDailyCaptureForecast,
  CLOUDFLARE_FREE_BROWSER_DAILY_LIMIT_MS,
} from "./capture-forecast.ts";
import type { SqlRow, WorkerEnvironment } from "./worker-contracts.ts";

type StoredHealthSnapshot = Pick<DeviceHealthReport, "state" | "startup_error_code"> & {
  sync?: Pick<DeviceHealthReport["sync"], "status" | "error_code">;
  outputs?: Array<Pick<DeviceHealthReport["outputs"][number], "display_id" | "connector" | "status" | "error_code">>;
  host?: DeviceHealthReport["host"];
};

export function configuredCaptureReserveMs(env: WorkerEnvironment): number {
  const parsed = Number(env.CAPTURE_BUDGET_RESERVE_MS);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 60_000;
}

function summarizeDurationAggregate(row: SqlRow | null | undefined, reserveMs: number) {
  const totalSamples = durationAggregateNumber(row, "total_samples");
  const measuredCount = durationAggregateNumber(row, "measured_sample_count");
  const failedAttemptCount = durationAggregateNumber(row, "failed_attempt_count");
  const retryAttemptCount = durationAggregateNumber(row, "retry_attempt_count");
  const measuredCoverage = aggregateRate(measuredCount, totalSamples);
  const measuredP50 = finiteNonNegativeOrNull(row?.measured_p50_ms);
  const measuredP90 = finiteNonNegativeOrNull(row?.measured_p90_ms);
  return {
    total_samples: totalSamples,
    measured_sample_count: measuredCount,
    reserve_estimated_sample_count: durationAggregateNumber(row, "reserve_estimated_sample_count"),
    unknown_sample_count: durationAggregateNumber(row, "unknown_sample_count"),
    failed_attempt_count: failedAttemptCount,
    retry_attempt_count: retryAttemptCount,
    capture_attempt_failure_rate: aggregateRate(failedAttemptCount, totalSamples),
    retry_attempt_rate: aggregateRate(retryAttemptCount, totalSamples),
    measured_header_coverage: measuredCoverage,
    measured_p50_ms: measuredP50,
    measured_p90_ms: measuredP90,
    measured_average_ms: finiteNonNegativeOrNull(row?.measured_average_ms),
    reserve_estimated_p50_ms: finiteNonNegativeOrNull(row?.reserve_estimated_p50_ms),
    reserve_estimated_p90_ms: finiteNonNegativeOrNull(row?.reserve_estimated_p90_ms),
    reserve_estimated_total_ms: durationAggregateNumber(row, "reserve_estimated_total_ms"),
    configured_reserve_ms: reserveMs,
    reserve_review: classifyReserveReview(measuredCount, measuredCoverage, measuredP90, reserveMs),
  };
}

function durationAggregateNumber(row: SqlRow | null | undefined, key: string): number {
  return Number(row?.[key] ?? 0);
}

function aggregateRate(count: number, total: number): number {
  return total ? count / total : 0;
}

function finiteNonNegativeOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export async function readOverview(env: WorkerEnvironment) {
  const now = Date.now();
  const windowStart = now - 30 * 24 * 60 * 60 * 1000;
  const [devices, playlists, active, audit, captureTargets, captureRuntimeAverages, integrityIssues, captureJobs, captureChangeHistory, captureHistory, captureDurationSummaries, captureUsage, captureDecisions, captureQualityReviews] = await Promise.all([
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
      "SELECT capture_id, job_id, captured_at, sha256, quality AS quality_review FROM (" +
      "SELECT h.capture_id, h.job_id, h.captured_at, h.sha256, r.quality, " +
      "ROW_NUMBER() OVER (PARTITION BY h.capture_id ORDER BY h.captured_at DESC) AS recent_rank " +
      "FROM capture_history h LEFT JOIN capture_quality_reviews r ON r.capture_id = h.capture_id AND r.job_id = h.job_id" +
      ") WHERE recent_rank <= 10 ORDER BY capture_id, captured_at DESC",
    ).all(),
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
      "reserve_ranked AS (" +
      "SELECT capture_id, browser_ms, ROW_NUMBER() OVER (PARTITION BY capture_id ORDER BY browser_ms) AS sample_rank, " +
      "COUNT(*) OVER (PARTITION BY capture_id) AS reserve_count FROM capture_duration_samples " +
      "WHERE sampled_at >= ? AND browser_ms_source = 'reserve'), " +
      "reserve_stats AS (SELECT capture_id, " +
      "AVG(CASE WHEN sample_rank IN (CAST((reserve_count + 1) / 2 AS INTEGER), CAST((reserve_count + 2) / 2 AS INTEGER)) THEN browser_ms END) AS reserve_estimated_p50_ms, " +
      "MAX(CASE WHEN sample_rank = CAST(reserve_count * 0.9 + 0.999999 AS INTEGER) THEN browser_ms END) AS reserve_estimated_p90_ms " +
      "FROM reserve_ranked GROUP BY capture_id), " +
      "source_stats AS (SELECT capture_id, COUNT(*) AS total_samples, " +
      "SUM(CASE WHEN browser_ms_source = 'response_header' THEN 1 ELSE 0 END) AS measured_sample_count, " +
      "SUM(CASE WHEN browser_ms_source = 'reserve' THEN 1 ELSE 0 END) AS reserve_estimated_sample_count, " +
      "SUM(CASE WHEN browser_ms_source = 'unknown' THEN 1 ELSE 0 END) AS unknown_sample_count, " +
      "SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failed_attempt_count, " +
      "SUM(CASE WHEN attempt > 1 THEN 1 ELSE 0 END) AS retry_attempt_count, " +
      "SUM(CASE WHEN browser_ms_source = 'reserve' THEN browser_ms ELSE 0 END) AS reserve_estimated_total_ms " +
      "FROM capture_duration_samples WHERE sampled_at >= ? GROUP BY capture_id) " +
      "SELECT source_stats.*, measured_stats.measured_average_ms, measured_stats.measured_p50_ms, measured_stats.measured_p90_ms, " +
      "reserve_stats.reserve_estimated_p50_ms, reserve_stats.reserve_estimated_p90_ms " +
      "FROM source_stats LEFT JOIN measured_stats USING (capture_id) LEFT JOIN reserve_stats USING (capture_id)",
    ).bind(windowStart, windowStart, windowStart).all(),
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
    env.DB.prepare(
      "SELECT " +
      "SUM(CASE WHEN quality = 'complete' THEN 1 ELSE 0 END) AS complete, " +
      "SUM(CASE WHEN quality = 'incomplete' THEN 1 ELSE 0 END) AS incomplete, " +
      "SUM(CASE WHEN quality = 'uncertain' THEN 1 ELSE 0 END) AS uncertain " +
      "FROM capture_quality_reviews WHERE reviewed_at >= ?",
    ).bind(windowStart).first(),
  ]);

  const missing = await readMissingActiveAssets(env, active, windowStart);
  const budgetValue = Number(env.DAILY_BROWSER_BUDGET_MS);
  const budgetMs = Number.isSafeInteger(budgetValue) && budgetValue >= 0 ? budgetValue : 600_000;
  const reserveMs = configuredCaptureReserveMs(env);
  const captureTargetSummaries = summarizeOverviewCaptureTargets(
    captureTargets.results ?? [], captureRuntimeAverages.results ?? [], captureDurationSummaries.results ?? [],
    captureChangeHistory.results ?? [], reserveMs, now,
  );
  const captureUsageSummary = buildCaptureUsageSummary(captureTargetSummaries.filter((target) => target.capture_type !== "api-dashboard"), captureUsage, budgetMs, now);
  const activePlaylist = active && typeof active.playlist_id === "string" && typeof active.revision === "string"
    ? { ...active, effective_revision: (await readPlaylistContent(env, active.playlist_id, active.revision, now)).effective_revision }
    : active;

  return {
    generated_at: now,
    environment: env.ADMIN_ACCESS_REQUIRED === "true" ? "production" : "development",
    devices: (devices.results ?? []).map((device) => summarizeDeviceHealth(device, now)),
    playlists: playlists.results ?? [],
    active_playlist: activePlaylist,
    capture_targets: captureTargetSummaries,
    capture_efficiency: summarizeOverviewCaptureEfficiency(
      captureTargetSummaries, captureUsage, budgetMs, now, captureJobs, captureHistory, captureDecisions, captureQualityReviews,
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

function summarizeOverviewCaptureTargets(
  targets: SqlRow[],
  runtimes: SqlRow[],
  durations: SqlRow[],
  histories: SqlRow[],
  reserveMs: number,
  now: number,
) {
  const runtimeAverageByCapture = new Map(runtimes.map((row) => [row.capture_id, row]));
  const durationSummaryByCapture = new Map(durations.map((row) => [row.capture_id, row]));
  const historyByCapture = new Map<string, SqlRow[]>();
  for (const row of histories) {
    if (typeof row.capture_id !== "string") continue;
    const history = historyByCapture.get(row.capture_id) ?? [];
    history.push(row);
    historyByCapture.set(row.capture_id, history);
  }
  return targets.map((target) => {
    const source = target.capture_type === "api-dashboard" ? null : new URL(target.url);
    const runtime = runtimeAverageByCapture.get(target.capture_id);
    const duration = durationSummaryByCapture.get(target.capture_id);
    const history = summarizeCaptureHistory((historyByCapture.get(target.capture_id) ?? []).map((row) => ({
      captured_at: Number(row.captured_at),
      sha256: typeof row.sha256 === "string" ? row.sha256 : null,
      job_id: typeof row.job_id === "string" ? row.job_id : undefined,
      quality_review: row.quality_review === "complete" || row.quality_review === "incomplete" || row.quality_review === "uncertain"
        ? row.quality_review : null,
    })));
    const lastSuccessAt = finiteNonNegativeOrNull(target.last_success_at);
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
      screenshot_age_seconds: lastSuccessAt === null ? null : Math.max(0, Math.floor((now - lastSuccessAt) / 1000)),
      ...history,
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
  captureQualityReviews: SqlRow | null,
) {
  const summary = buildCaptureUsageSummary(captureTargets.filter((target) => target.capture_type !== "api-dashboard"), captureUsage, budgetMs, now);
  return {
    daily_usage: summary.daily_usage,
    forecast: summary.forecast,
    last_30_days: summarizeOverviewLast30Days(captureJobs, captureHistory, captureDecisions, captureQualityReviews),
  };
}

function overviewCount(row: SqlRow | null, key: string) {
  return row?.[key] ?? 0;
}

function summarizeOverviewLast30Days(captureJobs: SqlRow | null, captureHistory: SqlRow | null, captureDecisions: SqlRow | null, captureQualityReviews: SqlRow | null) {
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
    screenshot_quality_reviews: {
      complete: overviewCount(captureQualityReviews, "complete"),
      incomplete: overviewCount(captureQualityReviews, "incomplete"),
      uncertain: overviewCount(captureQualityReviews, "uncertain"),
    },
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

export async function readCaptureForecast(env: WorkerEnvironment, now = Date.now()) {
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

export async function readDeviceHealth(deviceID: string, env: WorkerEnvironment) {
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

export async function readDeviceHealthHistory(deviceID: string, params: URLSearchParams, env: WorkerEnvironment) {
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

export async function readEnrollmentRequests(env: WorkerEnvironment) {
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
