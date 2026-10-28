import { captureScreenshot } from "./capture.js";

export const MAX_CAPTURE_ATTEMPTS = 3;
export const MAX_CAPTURE_HISTORY = 10;
export const CAPTURE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RUNNING_LEASE_MS = 3 * 60 * 1000;
const RETRY_DELAYS_SECONDS = [60, 180];
const DEFAULT_DAILY_BUDGET_MS = 540_000;
const DEFAULT_BUDGET_RESERVE_MS = 45_000;
const DEFAULT_REQUEST_GAP_MS = 10_000;
const MAX_PENDING_CAPTURE_JOBS = 100;

export async function enqueueCapture(captureID, env, { now = Date.now(), scheduled = false } = {}) {
  if (!env.CAPTURE_QUEUE || typeof env.CAPTURE_QUEUE.send !== "function") {
    throw new Error("Capture queue is not configured.");
  }
  const target = await env.DB.prepare(
    "SELECT capture_id, capture_interval_seconds, enabled FROM capture_targets WHERE capture_id = ?",
  ).bind(captureID).first();
  if (!target || target.enabled !== 1) return null;

  const jobID = crypto.randomUUID();
  const inserted = await env.DB.prepare(
    "INSERT OR IGNORE INTO capture_jobs (job_id, capture_id, status, attempts, created_at) VALUES (?, ?, 'queued', 0, ?)",
  ).bind(jobID, captureID, now).run();
  if (inserted.meta?.changes !== 1) {
    const existing = await env.DB.prepare(
      "SELECT job_id, status FROM capture_jobs WHERE capture_id = ? AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1",
    ).bind(captureID).first();
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

export async function dispatchDueCaptures(env, now = Date.now()) {
  if (!env.CAPTURE_QUEUE || typeof env.CAPTURE_QUEUE.send !== "function") return { enqueued: 0, skipped: true };
  const pending = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM capture_jobs WHERE status IN ('queued', 'running')",
  ).first();
  const capacity = Math.max(0, Math.min(MAX_PENDING_CAPTURE_JOBS, Number(env.CAPTURE_MAX_PENDING) || MAX_PENDING_CAPTURE_JOBS) - (pending?.count ?? 0));
  if (capacity === 0) return { enqueued: 0, skipped: false };
  const due = await env.DB.prepare(
    "SELECT t.capture_id FROM capture_targets t " +
    "WHERE t.enabled = 1 AND t.next_due_at <= ? " +
    "AND EXISTS (SELECT 1 FROM playlist_capture_items p JOIN active_playlist a " +
    "ON a.playlist_id = p.playlist_id AND a.revision = p.revision WHERE p.capture_id = t.capture_id) " +
    "AND NOT EXISTS (SELECT 1 FROM capture_jobs j WHERE j.capture_id = t.capture_id AND j.status IN ('queued', 'running')) " +
    "ORDER BY t.next_due_at, t.created_at LIMIT ?",
  ).bind(now, capacity).all();
  let enqueued = 0;
  for (const target of due.results ?? []) {
    try {
      const result = await enqueueCapture(target.capture_id, env, { now, scheduled: true });
      if (result?.queued) enqueued += 1;
    } catch {
      // Leave the due time in place so the next scheduled tick can try the outbox again.
    }
  }
  return { enqueued, skipped: false };
}

export async function handleCaptureQueue(batch, env, now = Date.now()) {
  for (const message of batch.messages ?? []) {
    await processCaptureMessage(message, env, now);
  }
}

async function processCaptureMessage(message, env, now) {
  const jobID = message.body?.job_id;
  if (typeof jobID !== "string" || !/^[0-9a-f-]{36}$/i.test(jobID)) {
    message.ack();
    return;
  }
  const job = await env.DB.prepare(
    "SELECT j.job_id, j.capture_id, j.status, j.attempts, j.lease_until, " +
    "t.url, t.capture_interval_seconds, t.viewport_width, t.viewport_height, t.enabled " +
    "FROM capture_jobs j JOIN capture_targets t ON t.capture_id = j.capture_id WHERE j.job_id = ?",
  ).bind(jobID).first();
  if (!job || ["succeeded", "failed", "deferred"].includes(job.status)) {
    message.ack();
    return;
  }
  if (job.status === "running" && job.lease_until > now) {
    message.retry({ delaySeconds: Math.ceil((job.lease_until - now) / 1000) });
    return;
  }
  if (job.enabled !== 1) {
    await markJobFinished(env, jobID, job.capture_id, "failed", "Capture target is disabled.", now);
    message.ack();
    return;
  }

  const deferral = await captureDeferral(env, now);
  if (deferral) {
    await deferCapture(env, jobID, job.capture_id, deferral.at, deferral.reason, now);
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
  await markBrowserStart(env, now);

  let result;
  try {
    result = await captureScreenshot(job, env);
  } catch (error) {
    const usedMs = Number.isSafeInteger(error.browserMs) && error.browserMs > 0
      ? error.browserMs
      : error.browserStarted ? nonNegativeInteger(env.CAPTURE_BUDGET_RESERVE_MS, DEFAULT_BUDGET_RESERVE_MS) : 0;
    if (usedMs) await addBrowserUsage(env, usedMs, now);
    await handleCaptureFailure(env, message, job, error, now);
    return;
  }

  const usedMs = result.browserMs > 0
    ? result.browserMs
    : nonNegativeInteger(env.CAPTURE_BUDGET_RESERVE_MS, DEFAULT_BUDGET_RESERVE_MS);
  if (usedMs) await addBrowserUsage(env, usedMs, now);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO capture_history (capture_id, job_id, sha256, size, captured_at, browser_ms) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(job.capture_id, jobID, result.sha256, result.size, now, usedMs),
    env.DB.prepare(
      "UPDATE capture_targets SET current_sha256 = ?, current_size = ?, last_attempt_at = ?, last_success_at = ?, " +
      "last_error = NULL, failure_count = 0, next_due_at = ? WHERE capture_id = ?",
    ).bind(result.sha256, result.size, now, now, now + job.capture_interval_seconds * 1000, job.capture_id),
    env.DB.prepare(
      "UPDATE capture_jobs SET status = 'succeeded', finished_at = ?, lease_until = NULL, error = NULL WHERE job_id = ?",
    ).bind(now, jobID),
  ]);
  await pruneCaptureHistory(env, job.capture_id, now);
  message.ack();
}

async function captureDeferral(env, now) {
  const minGap = nonNegativeInteger(env.CAPTURE_MIN_REQUEST_GAP_MS, DEFAULT_REQUEST_GAP_MS);
  const budget = nonNegativeInteger(env.DAILY_BROWSER_BUDGET_MS, DEFAULT_DAILY_BUDGET_MS);
  const reserve = nonNegativeInteger(env.CAPTURE_BUDGET_RESERVE_MS, DEFAULT_BUDGET_RESERVE_MS);
  const usage = await env.DB.prepare(
    "SELECT usage_day, browser_ms, last_started_at FROM capture_usage WHERE singleton = 1",
  ).first();
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

async function markBrowserStart(env, now) {
  const day = new Date(now).toISOString().slice(0, 10);
  await env.DB.prepare(
    "INSERT INTO capture_usage (singleton, usage_day, browser_ms, last_started_at) VALUES (1, ?, 0, ?) " +
    "ON CONFLICT(singleton) DO UPDATE SET usage_day = excluded.usage_day, " +
    "browser_ms = CASE WHEN capture_usage.usage_day = excluded.usage_day THEN capture_usage.browser_ms ELSE 0 END, " +
    "last_started_at = excluded.last_started_at",
  ).bind(day, now).run();
}

async function addBrowserUsage(env, browserMs, now) {
  const day = new Date(now).toISOString().slice(0, 10);
  await env.DB.prepare(
    "INSERT INTO capture_usage (singleton, usage_day, browser_ms, last_started_at) VALUES (1, ?, ?, NULL) " +
    "ON CONFLICT(singleton) DO UPDATE SET browser_ms = " +
    "CASE WHEN capture_usage.usage_day = excluded.usage_day THEN capture_usage.browser_ms + excluded.browser_ms ELSE excluded.browser_ms END, " +
    "usage_day = excluded.usage_day",
  ).bind(day, browserMs).run();
}

async function deferCapture(env, jobID, captureID, at, reason, now) {
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE capture_jobs SET status = 'deferred', finished_at = ?, lease_until = NULL, error = ? WHERE job_id = ?",
    ).bind(now, reason, jobID),
    env.DB.prepare("UPDATE capture_targets SET next_due_at = ?, last_error = ? WHERE capture_id = ?")
      .bind(at, reason, captureID),
  ]);
}

async function handleCaptureFailure(env, message, job, error, now) {
  const attempts = job.attempts + 1;
  const errorMessage = safeCaptureError(error);
  if (error.retryable === true && attempts < MAX_CAPTURE_ATTEMPTS) {
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
  await markJobFinished(env, job.job_id, job.capture_id, "failed", errorMessage, now, job.capture_interval_seconds);
  message.ack();
}

async function markJobFinished(env, jobID, captureID, status, error, now, intervalSeconds = 60) {
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE capture_jobs SET status = ?, finished_at = ?, lease_until = NULL, error = ? WHERE job_id = ?",
    ).bind(status, now, error, jobID),
    env.DB.prepare(
      "UPDATE capture_targets SET last_attempt_at = ?, last_error = ?, failure_count = failure_count + 1, next_due_at = ? WHERE capture_id = ?",
    ).bind(now, error, now + intervalSeconds * 1000, captureID),
  ]);
}

async function pruneCaptureHistory(env, captureID, now) {
  const cutoff = now - CAPTURE_RETENTION_MS;
  const history = await env.DB.prepare(
    "SELECT job_id, sha256, captured_at FROM capture_history WHERE capture_id = ? ORDER BY captured_at DESC, job_id DESC",
  ).bind(captureID).all();
  const retained = (history.results ?? []).filter((row) => row.captured_at >= cutoff).slice(0, MAX_CAPTURE_HISTORY);
  const keep = new Set(retained.map((row) => row.job_id));
  const remove = (history.results ?? []).filter((row) => !keep.has(row.job_id));
  const target = await env.DB.prepare(
    "SELECT current_sha256, last_success_at FROM capture_targets WHERE capture_id = ?",
  ).bind(captureID).first();
  const currentExpired = target?.current_sha256 && target.last_success_at < cutoff;
  const statements = remove.map((row) => env.DB.prepare(
    "DELETE FROM capture_history WHERE capture_id = ? AND job_id = ?",
  ).bind(captureID, row.job_id));
  if (currentExpired) {
    statements.push(env.DB.prepare(
      "UPDATE capture_targets SET current_sha256 = NULL, current_size = NULL WHERE capture_id = ? AND current_sha256 = ?",
    ).bind(captureID, target.current_sha256));
  }
  if (statements.length) await env.DB.batch(statements);
  const candidates = new Set(remove.map((row) => row.sha256));
  if (currentExpired) candidates.add(target.current_sha256);
  for (const sha256 of candidates) await deleteIfUnreferenced(env, sha256);
}

async function deleteIfUnreferenced(env, sha256) {
  const [playlist, capture, history] = await Promise.all([
    env.DB.prepare("SELECT 1 AS present FROM playlist_assets WHERE sha256 = ? LIMIT 1").bind(sha256).first(),
    env.DB.prepare(
      "SELECT 1 AS present FROM capture_targets WHERE placeholder_sha256 = ? OR current_sha256 = ? LIMIT 1",
    ).bind(sha256, sha256).first(),
    env.DB.prepare("SELECT 1 AS present FROM capture_history WHERE sha256 = ? LIMIT 1").bind(sha256).first(),
  ]);
  if (!playlist && !capture && !history) await env.ASSETS.delete?.(`assets/${sha256}`);
}

export async function cleanupExpiredCaptures(env, now = Date.now()) {
  const cutoff = now - CAPTURE_RETENTION_MS;
  const expired = await env.DB.prepare(
    "SELECT capture_id FROM capture_targets WHERE (current_sha256 IS NOT NULL AND last_success_at < ?) " +
    "OR capture_id IN (SELECT capture_id FROM capture_history WHERE captured_at < ?) LIMIT 100",
  ).bind(cutoff, cutoff).all();
  for (const row of expired.results ?? []) await pruneCaptureHistory(env, row.capture_id, now);
  return expired.results?.length ?? 0;
}

function safeCaptureError(error) {
  if (typeof error?.message !== "string") return "Browser capture failed.";
  return error.message.slice(0, 240);
}

function nonNegativeInteger(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
