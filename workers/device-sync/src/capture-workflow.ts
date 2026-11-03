import { captureScreenshot, validateCaptureTargetURL, type CaptureTarget } from "./capture.ts";
import { ASSET_RECONCILIATION_PAGE_SIZE, deleteUnreferencedAssets } from "./asset-maintenance.ts";
import { markAssetLiveStatement } from "./asset-registry.ts";
import { DEFAULT_CAPTURE_INTERVAL_SECONDS } from "./intervals.ts";

type CaptureEnv = ManagementBindings;
type DueTarget = { capture_id: string; next_due_at: number };
type CaptureJob = CaptureTarget & { job_id: string; capture_id: string; status: string; attempts: number; lease_until: number; scheduled_due_at: number | null; enabled: number; capture_interval_seconds: number; current_sha256: string | null; current_size: number | null; validator_etag: string | null; validator_last_modified: string | null };
type ValidatorTarget = Pick<CaptureJob, "url" | "current_sha256" | "current_size" | "validator_etag" | "validator_last_modified">;
type ValidatorResult = { unchanged: boolean; outcome: string; etag: string | null; lastModified: string | null };
type JobDecision = Pick<CaptureJob, "capture_id" | "scheduled_due_at">;
type CaptureMessage = Message<{ job_id?: unknown }>;
type CaptureFailureDetails = { message?: string; browserMs: number; browserStarted: boolean; retryable: boolean };

export const MAX_CAPTURE_ATTEMPTS = 3;
export const MAX_CAPTURE_HISTORY = 10;
export const CAPTURE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RUNNING_LEASE_MS = 3 * 60 * 1000;
const RETRY_DELAYS_SECONDS = [60, 180];
const DEFAULT_DAILY_BUDGET_MS = 600_000;
const DEFAULT_BUDGET_RESERVE_MS = 60_000;
const DEFAULT_REQUEST_GAP_MS = 10_000;
const MAX_PENDING_CAPTURE_JOBS = 100;
const CAPTURE_VALIDATOR_TIMEOUT_MS = 5_000;

export class CaptureTargetNotAllowedError extends Error {
  constructor() {
    super("That webpage capture host is not on the configured capture allowlist.");
    this.name = "CaptureTargetNotAllowedError";
  }
}

export async function enqueueCapture(captureID: string, env: CaptureEnv, { now = Date.now(), scheduled = false } = {}) {
  if (!env.CAPTURE_QUEUE || typeof env.CAPTURE_QUEUE.send !== "function") {
    throw new Error("Capture queue is not configured.");
  }
  const target = await env.DB.prepare(
    "SELECT capture_id, url, capture_interval_seconds, enabled, next_due_at FROM capture_targets WHERE capture_id = ?",
  ).bind(captureID).first<{ enabled: number; url: string; capture_interval_seconds: number; next_due_at: number }>();
  if (!target || target.enabled !== 1) return null;
  try {
    validateCaptureTargetURL(target.url, env.CAPTURE_ALLOWED_HOSTS);
  } catch {
    throw new CaptureTargetNotAllowedError();
  }

  const jobID = crypto.randomUUID();
  const inserted = await env.DB.prepare(
    "INSERT OR IGNORE INTO capture_jobs (job_id, capture_id, status, attempts, created_at, validator_outcome, result_kind, scheduled_due_at, " +
    "browser_ms_total, browser_ms_response_header, browser_ms_reserve, browser_ms_legacy_unknown) " +
    "VALUES (?, ?, 'queued', 0, ?, 'unknown', 'screenshot', ?, 0, 0, 0, 0)",
  ).bind(jobID, captureID, now, scheduled ? target.next_due_at : null).run();
  if (inserted.meta?.changes !== 1) {
    const existing = await env.DB.prepare(
      "SELECT job_id, status FROM capture_jobs WHERE capture_id = ? AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1",
    ).bind(captureID).first<{ job_id: string; status: string }>();
    return existing ? { job_id: existing.job_id, queued: false, status: existing.status } : null;
  }
  if (scheduled) {
    await env.DB.prepare("UPDATE capture_targets SET next_due_at = ? WHERE capture_id = ?")
      .bind(now + target.capture_interval_seconds * 1000, captureID).run();
  }
  try {
    await env.CAPTURE_QUEUE.send({ job_id: jobID });
    return { job_id: jobID, queued: true, status: "queued" };
  } catch (error) {
    await env.DB.prepare(
      "UPDATE capture_jobs SET status = 'failed', finished_at = ?, error = ? WHERE job_id = ? AND status = 'queued'",
    ).bind(now, "Queue publish failed.", jobID).run();
    if (scheduled) {
      await env.DB.prepare("UPDATE capture_targets SET next_due_at = ? WHERE capture_id = ?")
        .bind(now, captureID).run();
    }
    throw error;
  }
}

export async function dispatchDueCaptures(env: CaptureEnv, now = Date.now()) {
  if (!env.CAPTURE_QUEUE || typeof env.CAPTURE_QUEUE.send !== "function") return { enqueued: 0, skipped: true };
  const pending = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM capture_jobs WHERE status IN ('queued', 'running')",
  ).first<{ count: number }>();
  const capacity = Math.max(0, Math.min(MAX_PENDING_CAPTURE_JOBS, Number(env.CAPTURE_MAX_PENDING) || MAX_PENDING_CAPTURE_JOBS) - (pending?.count ?? 0));
  if (capacity === 0) return { enqueued: 0, skipped: false };
  // Staged targets receive a first or stale-image warmup; recurring captures stay active-playlist only.
  const due = await env.DB.prepare(
    "SELECT t.capture_id, t.next_due_at FROM capture_targets t " +
    "WHERE t.enabled = 1 AND t.schedule_reviewed_at IS NOT NULL AND t.next_due_at <= ? " +
    "AND (EXISTS (SELECT 1 FROM playlist_capture_items p JOIN active_playlist a " +
    "ON a.playlist_id = p.playlist_id AND a.revision = p.revision WHERE p.capture_id = t.capture_id) " +
    "OR ((t.current_sha256 IS NULL OR t.last_success_at IS NULL OR t.last_success_at < ?) " +
    "AND EXISTS (SELECT 1 FROM playlist_capture_items p WHERE p.capture_id = t.capture_id))) " +
    "AND NOT EXISTS (SELECT 1 FROM capture_jobs j WHERE j.capture_id = t.capture_id AND j.status IN ('queued', 'running')) " +
    "ORDER BY t.next_due_at, t.created_at LIMIT ?",
  ).bind(now, now - CAPTURE_RETENTION_MS, capacity).all<DueTarget>();
  let enqueued = 0;
  for (const target of due.results ?? []) {
    if (await consumeApprovedCaptureSkip(target, env, now)) continue;
    const stillDue = await env.DB.prepare(
      "SELECT 1 AS due FROM capture_targets WHERE capture_id = ? AND enabled = 1 AND next_due_at <= ?",
    ).bind(target.capture_id, now).first();
    if (!stillDue) continue;
    try {
      const result = await enqueueCapture(target.capture_id, env, { now, scheduled: true });
      if (result?.queued) enqueued += 1;
    } catch {
      // Leave the due time in place so the next scheduled tick can try the outbox again.
    }
  }
  return { enqueued, skipped: false };
}

async function consumeApprovedCaptureSkip(target: DueTarget, env: CaptureEnv, now: number) {
  const approval = await env.DB.prepare(
    "SELECT due_at, expires_at FROM capture_skip_approvals WHERE capture_id = ?",
  ).bind(target.capture_id).first<{ due_at: number; expires_at: number }>();
  if (!approval) return false;
  if (approval.due_at !== target.next_due_at || approval.expires_at < now || approval.due_at > now) {
    await env.DB.prepare("DELETE FROM capture_skip_approvals WHERE capture_id = ?").bind(target.capture_id).run();
    return false;
  }
  const targetRow = await env.DB.prepare(
    "SELECT capture_interval_seconds, current_sha256, current_size, last_success_at FROM capture_targets " +
    "WHERE capture_id = ? AND enabled = 1 AND next_due_at = ? " +
    "AND current_sha256 IS NOT NULL AND failure_count = 0 AND last_error IS NULL " +
    "AND NOT EXISTS (SELECT 1 FROM capture_jobs j WHERE j.capture_id = capture_targets.capture_id AND j.status IN ('queued', 'running'))",
  ).bind(target.capture_id, approval.due_at).first<{ capture_interval_seconds: number; current_sha256: string; current_size: number; last_success_at: number }>();
  if (!targetRow) {
    await env.DB.prepare("DELETE FROM capture_skip_approvals WHERE capture_id = ?").bind(target.capture_id).run();
    return false;
  }
  const currentAsset = await env.ASSETS.head(`assets/${targetRow.current_sha256}`);
  if (!currentAsset || currentAsset.size !== targetRow.current_size || !targetRow.last_success_at ||
      targetRow.last_success_at > now || approval.due_at - targetRow.last_success_at > targetRow.capture_interval_seconds * 2000) {
    await env.DB.prepare("DELETE FROM capture_skip_approvals WHERE capture_id = ?").bind(target.capture_id).run();
    return false;
  }
  const recentHistory = await env.DB.prepare(
    "SELECT sha256 FROM capture_history WHERE capture_id = ? ORDER BY captured_at DESC LIMIT 3",
  ).bind(target.capture_id).all<{ sha256: string }>();
  if (recentHistory.results?.length !== 3 ||
      recentHistory.results.some((item) => item.sha256 !== targetRow.current_sha256)) {
    await env.DB.prepare("DELETE FROM capture_skip_approvals WHERE capture_id = ?").bind(target.capture_id).run();
    return false;
  }
  const nextDueAt = approval.due_at + targetRow.capture_interval_seconds * 1000;
  const result = await env.DB.batch([
    env.DB.prepare(
      "UPDATE capture_targets SET next_due_at = ? WHERE capture_id = ? AND next_due_at = ? " +
      "AND NOT EXISTS (SELECT 1 FROM capture_jobs j WHERE j.capture_id = capture_targets.capture_id AND j.status IN ('queued', 'running'))",
    ).bind(nextDueAt, target.capture_id, approval.due_at),
    env.DB.prepare(
      "INSERT INTO audit_events (event_id, actor_id, event_type, subject_type, subject_id, occurred_at, metadata_json) " +
      "SELECT ?, actor_id, 'capture.skip_once_applied', 'capture', capture_id, ?, ? FROM capture_skip_approvals " +
      "WHERE capture_id = ? AND due_at = ? AND changes() > 0",
    ).bind(crypto.randomUUID(), now, JSON.stringify({ due_at: approval.due_at, next_due_at: nextDueAt }), target.capture_id, approval.due_at),
    env.DB.prepare("DELETE FROM capture_skip_approvals WHERE capture_id = ? AND due_at = ?")
      .bind(target.capture_id, approval.due_at),
  ]);
  return result[0]?.meta?.changes === 1;
}

export async function handleCaptureQueue(batch: MessageBatch<{ job_id?: unknown }>, env: CaptureEnv, now = Date.now()) {
  for (const message of batch.messages ?? []) {
    await processCaptureMessage(message, env, now);
  }
}

async function processCaptureMessage(message: CaptureMessage, env: CaptureEnv, now: number) {
  const jobID = message.body?.job_id;
  if (typeof jobID !== "string" || !/^[0-9a-f-]{36}$/i.test(jobID)) {
    message.ack();
    return;
  }
  const job = await env.DB.prepare(
    "SELECT j.job_id, j.capture_id, j.status, j.attempts, j.lease_until, j.scheduled_due_at, " +
    "t.url, t.capture_interval_seconds, t.viewport_width, t.viewport_height, t.wait_for_selector, t.enabled, " +
    "t.current_sha256, t.current_size, t.validator_etag, t.validator_last_modified " +
    "FROM capture_jobs j JOIN capture_targets t ON t.capture_id = j.capture_id WHERE j.job_id = ?",
  ).bind(jobID).first<CaptureJob>();
  if (!job || ["succeeded", "failed", "deferred"].includes(job.status)) {
    message.ack();
    return;
  }
  if (job.status === "running" && job.lease_until > now) {
    message.retry({ delaySeconds: Math.ceil((job.lease_until - now) / 1000) });
    return;
  }
  if (job.enabled !== 1) {
    await markJobFinished(env, jobID, job.capture_id, "failed", "Capture target is disabled.", now, job.capture_interval_seconds, job.scheduled_due_at);
    message.ack();
    return;
  }

  const claimed = await env.DB.prepare(
    "UPDATE capture_jobs SET status = 'running', attempts = attempts + 1, started_at = ?, lease_until = ?, error = NULL " +
    "WHERE job_id = ? AND (status = 'queued' OR (status = 'running' AND lease_until <= ?))",
  ).bind(now, now + RUNNING_LEASE_MS, jobID, now).run();
  if (claimed.meta?.changes !== 1) {
    message.retry({ delaySeconds: 60 });
    return;
  }

  const validator = await probeCaptureValidator(job, env);
  await env.DB.prepare("UPDATE capture_jobs SET validator_outcome = ? WHERE job_id = ?")
    .bind(validator.outcome, jobID).run();
  if (validator?.unchanged) {
    await completeUnchangedCapture(env, job, validator, now);
    message.ack();
    return;
  }
  const deferral = await captureDeferral(env, now);
  if (deferral) {
    await deferCapture(env, jobID, job.capture_id, deferral.at, deferral.reason, now, job.scheduled_due_at);
    message.ack();
    return;
  }
  await markBrowserStart(env, now);

  let result;
  try {
    result = await captureScreenshot(job, env);
  } catch (caught) {
    const error = captureFailureDetails(caught);
    const usedMs = Number.isSafeInteger(error.browserMs) && error.browserMs > 0
      ? error.browserMs
      : error.browserStarted ? nonNegativeInteger(env.CAPTURE_BUDGET_RESERVE_MS, DEFAULT_BUDGET_RESERVE_MS) : 0;
    if (usedMs) await addBrowserUsage(env, usedMs, now, jobID,
      error.browserMs > 0 ? "response_header" : "reserve");
    await handleCaptureFailure(env, message, job, error, now);
    return;
  }

  const usedMs = result.browserMs > 0
    ? result.browserMs
    : nonNegativeInteger(env.CAPTURE_BUDGET_RESERVE_MS, DEFAULT_BUDGET_RESERVE_MS);
  if (usedMs) await addBrowserUsage(env, usedMs, now, jobID,
    result.browserMs > 0 ? "response_header" : "reserve");
  const validatorHeadersUsable = !["disabled", "unavailable"].includes(validator.outcome);
  const validatorEtag = validatorHeadersUsable ? validator.etag : job.validator_etag;
  const validatorLastModified = validatorHeadersUsable ? validator.lastModified : job.validator_last_modified;
  await env.DB.batch([
    markAssetLiveStatement(env.DB, result.sha256, result.size, now),
    env.DB.prepare(
      "INSERT INTO capture_history (capture_id, job_id, sha256, size, captured_at, browser_ms, browser_ms_source) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(job.capture_id, jobID, result.sha256, result.size, now, usedMs, result.browserMs > 0 ? "response_header" : "reserve"),
    env.DB.prepare(
      "UPDATE capture_targets SET current_sha256 = ?, current_size = ?, last_attempt_at = ?, last_success_at = ?, " +
      "last_error = NULL, failure_count = 0, next_due_at = ?, validator_etag = ?, validator_last_modified = ? WHERE capture_id = ?",
    ).bind(result.sha256, result.size, now, now, now + job.capture_interval_seconds * 1000,
      validatorEtag, validatorLastModified, job.capture_id),
    env.DB.prepare(
      "UPDATE capture_jobs SET status = 'succeeded', finished_at = ?, lease_until = NULL, error = NULL WHERE job_id = ?",
    ).bind(now, jobID),
    decisionObservationStatement(env.DB, job, result.sha256 === job.current_sha256 ? "unchanged" : "changed", now),
  ]);
  await pruneCaptureHistory(env, job.capture_id, now);
  message.ack();
}

export async function probeCaptureValidator(target: ValidatorTarget, env: CaptureEnv, fetcher = globalThis.fetch): Promise<ValidatorResult> {
  const approvedHosts = new Set(String(env.CAPTURE_VALIDATOR_HOSTS ?? "")
    .split(",").map((host) => host.trim().toLowerCase()).filter(Boolean));
  let url;
  try { url = new URL(validateCaptureTargetURL(target.url, env.CAPTURE_ALLOWED_HOSTS)); } catch {
    return { unchanged: false, outcome: "disabled", etag: target.validator_etag, lastModified: target.validator_last_modified };
  }
  if (!approvedHosts.has(url.hostname)) {
    return { unchanged: false, outcome: "disabled", etag: target.validator_etag, lastModified: target.validator_last_modified };
  }

  const headers = new Headers();
  if (target.validator_etag) headers.set("If-None-Match", target.validator_etag);
  if (target.validator_last_modified) headers.set("If-Modified-Since", target.validator_last_modified);
  try {
    const response = await fetcher(url, {
      method: "HEAD",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(CAPTURE_VALIDATOR_TIMEOUT_MS),
    });
    const etag = response.headers.get("ETag");
    const lastModified = response.headers.get("Last-Modified");
    const hasStoredValidator = Boolean(target.validator_etag || target.validator_last_modified);
    let unchanged = response.status === 304 && hasStoredValidator;
    let outcome;
    if (response.status === 304) {
      outcome = hasStoredValidator ? "unchanged" : "no_stored_validator";
    } else if (response.status >= 200 && response.status < 300 && hasStoredValidator) {
      const hasComparable = Boolean((target.validator_etag && etag) || (target.validator_last_modified && lastModified));
      unchanged = hasComparable &&
        (!target.validator_etag || target.validator_etag === etag) &&
        (!target.validator_last_modified || target.validator_last_modified === lastModified);
      outcome = unchanged ? "unchanged" : "changed";
    } else if (response.status >= 200 && response.status < 300) {
      outcome = "no_stored_validator";
    } else {
      outcome = "unavailable";
    }
    if (unchanged) {
      if (target.current_sha256 && target.current_size !== null && target.current_size > 0) {
        const object = await env.ASSETS.head(`assets/${target.current_sha256}`);
        unchanged = object?.size === target.current_size;
      } else {
        unchanged = false;
      }
      outcome = unchanged ? "unchanged" : "cached_asset_missing";
    }
    return {
      unchanged,
      outcome,
      etag: response.status === 304 ? etag ?? target.validator_etag : etag,
      lastModified: response.status === 304 ? lastModified ?? target.validator_last_modified : lastModified,
    };
  } catch {
    return { unchanged: false, outcome: "unavailable", etag: target.validator_etag, lastModified: target.validator_last_modified };
  }
}

async function completeUnchangedCapture(env: CaptureEnv, job: CaptureJob, validator: ValidatorResult, now: number) {
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE capture_targets SET last_attempt_at = ?, last_success_at = ?, last_error = NULL, failure_count = 0, " +
      "next_due_at = ?, validator_etag = ?, validator_last_modified = ? WHERE capture_id = ?",
    ).bind(now, now, now + job.capture_interval_seconds * 1000, validator.etag, validator.lastModified, job.capture_id),
    env.DB.prepare(
      "UPDATE capture_jobs SET status = 'succeeded', result_kind = 'validator_unchanged', validator_outcome = 'unchanged', finished_at = ?, lease_until = NULL, error = NULL WHERE job_id = ?",
    ).bind(now, job.job_id),
    decisionObservationStatement(env.DB, job, "validator_unchanged", now),
  ]);
}

function decisionObservationStatement(db: D1Database, job: JobDecision, outcome: string, now: number) {
  return db.prepare(
    "UPDATE capture_decisions SET observed_at = ?, observed_result = ?, observed_delay_ms = ? " +
    "WHERE capture_id = ? AND due_at = ? AND observed_result IS NULL",
  ).bind(now, outcome, Math.max(0, now - (job.scheduled_due_at ?? now)), job.capture_id, job.scheduled_due_at);
}

async function captureDeferral(env: CaptureEnv, now: number) {
  const minGap = nonNegativeInteger(env.CAPTURE_MIN_REQUEST_GAP_MS, DEFAULT_REQUEST_GAP_MS);
  const budget = nonNegativeInteger(env.DAILY_BROWSER_BUDGET_MS, DEFAULT_DAILY_BUDGET_MS);
  const reserve = nonNegativeInteger(env.CAPTURE_BUDGET_RESERVE_MS, DEFAULT_BUDGET_RESERVE_MS);
  const usage = await env.DB.prepare(
    "SELECT usage_day, browser_ms, last_started_at FROM capture_usage WHERE singleton = 1",
  ).first<{ usage_day: string; browser_ms: number; last_started_at: number | null }>();
  if (usage?.last_started_at && minGap > 0 && now - usage.last_started_at < minGap) {
    return { at: usage.last_started_at + minGap, reason: "Browser Run request rate limit." };
  }
  const day = new Date(now).toISOString().slice(0, 10);
  const used = usage?.usage_day === day ? usage.browser_ms : 0;
  if (budget > 0 && used + reserve > budget) {
    const nextDay = Date.parse(`${day}T00:00:00.000Z`) + 24 * 60 * 60 * 1000;
    return { at: nextDay, reason: "Daily Browser Run time budget reached." };
  }
  return null;
}

async function markBrowserStart(env: CaptureEnv, now: number) {
  const day = new Date(now).toISOString().slice(0, 10);
  await env.DB.prepare(
    "INSERT INTO capture_usage (singleton, usage_day, browser_ms, last_started_at) VALUES (1, ?, 0, ?) " +
    "ON CONFLICT(singleton) DO UPDATE SET usage_day = excluded.usage_day, " +
    "browser_ms = CASE WHEN capture_usage.usage_day = excluded.usage_day THEN capture_usage.browser_ms ELSE 0 END, " +
    "last_started_at = excluded.last_started_at",
  ).bind(day, now).run();
}

async function addBrowserUsage(env: CaptureEnv, browserMs: number, now: number, jobID: string, source: "response_header" | "reserve") {
  const day = new Date(now).toISOString().slice(0, 10);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO capture_usage (singleton, usage_day, browser_ms, last_started_at) VALUES (1, ?, ?, NULL) " +
      "ON CONFLICT(singleton) DO UPDATE SET browser_ms = " +
      "CASE WHEN capture_usage.usage_day = excluded.usage_day THEN capture_usage.browser_ms + excluded.browser_ms ELSE excluded.browser_ms END, " +
      "usage_day = excluded.usage_day",
    ).bind(day, browserMs),
    env.DB.prepare(
      "UPDATE capture_jobs SET browser_ms_total = COALESCE(browser_ms_total, 0) + ?, " +
      "browser_ms_response_header = COALESCE(browser_ms_response_header, 0) + ?, " +
      "browser_ms_reserve = COALESCE(browser_ms_reserve, 0) + ? WHERE job_id = ?",
    ).bind(browserMs, source === "response_header" ? browserMs : 0, source === "reserve" ? browserMs : 0, jobID),
  ]);
}

async function deferCapture(env: CaptureEnv, jobID: string, captureID: string, at: number, reason: string, now: number, scheduledDueAt: number | null = null) {
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE capture_jobs SET status = 'deferred', finished_at = ?, lease_until = NULL, error = ? WHERE job_id = ?",
    ).bind(now, reason, jobID),
    env.DB.prepare("UPDATE capture_targets SET next_due_at = ?, last_error = ? WHERE capture_id = ?")
      .bind(at, reason, captureID),
    decisionObservationStatement(env.DB, { capture_id: captureID, scheduled_due_at: scheduledDueAt }, "budget_deferred", now),
  ]);
}

async function handleCaptureFailure(env: CaptureEnv, message: CaptureMessage, job: CaptureJob, error: CaptureFailureDetails, now: number) {
  const attempts = job.attempts + 1;
  const errorMessage = error.message?.slice(0, 240) ?? "Browser capture failed.";
  if (error.retryable && attempts < MAX_CAPTURE_ATTEMPTS) {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE capture_jobs SET status = 'queued', lease_until = NULL, error = ? WHERE job_id = ?",
      ).bind(errorMessage, job.job_id),
      env.DB.prepare("UPDATE capture_targets SET last_attempt_at = ?, last_error = ? WHERE capture_id = ?")
        .bind(now, errorMessage, job.capture_id),
    ]);
    message.retry({ delaySeconds: RETRY_DELAYS_SECONDS[Math.min(attempts - 1, RETRY_DELAYS_SECONDS.length - 1)] });
    return;
  }
  await markJobFinished(env, job.job_id, job.capture_id, "failed", errorMessage, now, job.capture_interval_seconds, job.scheduled_due_at);
  message.ack();
}

async function markJobFinished(env: CaptureEnv, jobID: string, captureID: string, status: string, error: string, now: number,
  intervalSeconds = DEFAULT_CAPTURE_INTERVAL_SECONDS, scheduledDueAt: number | null = null) {
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE capture_jobs SET status = ?, finished_at = ?, lease_until = NULL, error = ? WHERE job_id = ?",
    ).bind(status, now, error, jobID),
    env.DB.prepare(
      "UPDATE capture_targets SET last_attempt_at = ?, last_error = ?, failure_count = failure_count + 1, next_due_at = ? WHERE capture_id = ?",
    ).bind(now, error, now + intervalSeconds * 1000, captureID),
    ...(status === "failed" ? [decisionObservationStatement(env.DB,
      { capture_id: captureID, scheduled_due_at: scheduledDueAt }, "failed", now)] : []),
  ]);
}

async function pruneCaptureHistory(env: CaptureEnv, captureID: string, now: number) {
  const cutoff = now - CAPTURE_RETENTION_MS;
  const history = await env.DB.prepare(
    "SELECT job_id, sha256, captured_at FROM capture_history WHERE capture_id = ? ORDER BY captured_at DESC, job_id DESC",
  ).bind(captureID).all<{ job_id: string; sha256: string; captured_at: number }>();
  const retained = (history.results ?? []).filter((row) => row.captured_at >= cutoff).slice(0, MAX_CAPTURE_HISTORY);
  const keep = new Set(retained.map((row) => row.job_id));
  const remove = (history.results ?? []).filter((row) => !keep.has(row.job_id));
  const target = await env.DB.prepare(
    "SELECT current_sha256, last_success_at FROM capture_targets WHERE capture_id = ?",
  ).bind(captureID).first<{ current_sha256: string | null; last_success_at: number }>();
  const currentExpired = target?.current_sha256 && target.last_success_at < cutoff;
  const statements = remove.map((row) => env.DB.prepare(
    "DELETE FROM capture_history WHERE capture_id = ? AND job_id = ?",
  ).bind(captureID, row.job_id));
  if (currentExpired) {
    statements.push(env.DB.prepare(
      "UPDATE capture_targets SET current_sha256 = NULL, current_size = NULL WHERE capture_id = ? AND current_sha256 = ?",
    ).bind(captureID, target.current_sha256));
  }
  for (let offset = 0; offset < statements.length; offset += ASSET_RECONCILIATION_PAGE_SIZE) {
    await env.DB.batch(statements.slice(offset, offset + ASSET_RECONCILIATION_PAGE_SIZE));
  }
  const candidates = new Set(remove.map((row) => row.sha256));
  if (currentExpired && target.current_sha256) candidates.add(target.current_sha256);
  await deleteUnreferencedAssets(env, [...candidates], now);
}

export async function cleanupExpiredCaptures(env: CaptureEnv, now = Date.now()) {
  const cutoff = now - CAPTURE_RETENTION_MS;
  const expired = await env.DB.prepare(
    "SELECT capture_id FROM capture_targets WHERE (current_sha256 IS NOT NULL AND last_success_at < ?) " +
    "OR capture_id IN (SELECT capture_id FROM capture_history WHERE captured_at < ?) LIMIT 100",
  ).bind(cutoff, cutoff).all<{ capture_id: string }>();
  for (const row of expired.results ?? []) await pruneCaptureHistory(env, row.capture_id, now);
  return expired.results?.length ?? 0;
}

function captureFailureDetails(error: unknown): CaptureFailureDetails {
  const details = error !== null && typeof error === "object" ? error as Record<string, unknown> : {};
  return { message: typeof details.message === "string" ? details.message : undefined,
    browserMs: typeof details.browserMs === "number" ? details.browserMs : 0,
    browserStarted: details.browserStarted === true, retryable: details.retryable === true };
}

function nonNegativeInteger(value: unknown, fallback: number) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
