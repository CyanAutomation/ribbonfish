import { buildCaptureAssessmentState, captureAssessmentQuestions, type CaptureAssessmentTarget } from './jev-use-cases.ts';
import { callJevDecision, type JevDecisionResult } from './jev.ts';
import { summarizeCaptureDurations } from './capture-duration.ts';

interface PolicyTarget extends CaptureAssessmentTarget {
  current_sha256: string | null;
  current_asset_present?: boolean;
}
interface CaptureTarget extends PolicyTarget {
  capture_id: string;
  current_size: number | null;
}
type AssessmentEnv = Pick<ManagementBindings, 'DB' | 'ASSETS'> & {
  OPENROUTER_API_KEY?: string;
  CAPTURE_BUDGET_RESERVE_MS?: string;
};
type Decision = Pick<JevDecisionResult, 'answers'>;


const MIN_JEV_CONFIDENCE = 0.8;
const DURATION_REVIEW_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function safeSchedule(target: PolicyTarget, now: number) {
  const intervalSeconds = target.capture_interval_seconds;
  const due = target.next_due_at;
  const lastSuccessAt = target.last_success_at;
  if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds <= 0 || !Number.isSafeInteger(due) ||
      typeof lastSuccessAt !== "number" || !Number.isSafeInteger(lastSuccessAt)) return null;

  const intervalMs = intervalSeconds * 1000;
  if (!Number.isSafeInteger(intervalMs) || lastSuccessAt > now || due < now ||
      due + intervalMs - lastSuccessAt > 2 * intervalMs) return null;
  return { due, intervalMs };
}

function hasStableRecentScreenshot(target: PolicyTarget) {
  const recent = (target.history ?? []).slice(0, 3);
  return Boolean(target.current_sha256) && recent.length === 3 &&
    recent.every((item) => item.sha256 === target.current_sha256);
}

function hasNoCaptureFault(target: PolicyTarget) {
  return Boolean(target.current_asset_present) && !target.failure_count && !target.last_error && !target.job_status;
}

function isConfident(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= MIN_JEV_CONFIDENCE;
}

function hasConfidentLowRiskRecommendation(decision: Decision | null) {
  const recommendation = decision?.answers?.recommendation;
  const risk = decision?.answers?.risk;
  return recommendation?.choice === "skip_once" && isConfident(recommendation.confidence) &&
    isConfident(risk?.confidence) && typeof risk?.score === "number" && Number.isFinite(risk.score) && risk.score <= 0.5;
}

// The model supplies a suggestion; deterministic rules bound any prospective deferral.
export function decideCapturePolicy(target: PolicyTarget, decision: Decision | null, now: number) {
  const schedule = safeSchedule(target, now);
  if (schedule && hasNoCaptureFault(target) && hasStableRecentScreenshot(target) && hasConfidentLowRiskRecommendation(decision)) {
    return { action: 'defer_once', next_due_at: schedule.due + schedule.intervalMs,
      reason: 'Three recent screenshots are identical and the current image is available.' };
  }
  return { action: 'capture', next_due_at: target.next_due_at, reason: 'Keep the scheduled capture when evidence is insufficient or a safeguard applies.' };
}

// Shadow decisions are recorded ahead of time and never modify capture schedules.
export async function assessUpcomingCaptures(env: AssessmentEnv, now = Date.now(), decide = callJevDecision) {
  const reserveValue = Number(env.CAPTURE_BUDGET_RESERVE_MS);
  const reserveMs = Number.isSafeInteger(reserveValue) && reserveValue >= 0 ? reserveValue : 60_000;
  const rows = await env.DB.prepare(
    "SELECT t.*, (SELECT j.status FROM capture_jobs j WHERE j.capture_id = t.capture_id AND j.status IN ('queued','running') LIMIT 1) AS job_status " +
    "FROM capture_targets t WHERE t.enabled = 1 AND t.capture_type = 'browser-screenshot' AND t.next_due_at > ? AND t.next_due_at <= ? " +
    "AND EXISTS (SELECT 1 FROM playlist_capture_items p JOIN active_playlist a ON a.playlist_id = p.playlist_id AND a.revision = p.revision WHERE p.capture_id = t.capture_id) " +
    "AND NOT EXISTS (SELECT 1 FROM capture_decisions d WHERE d.capture_id = t.capture_id AND d.due_at = t.next_due_at AND (d.action != 'pending' OR d.assessed_at > ?)) " +
    "ORDER BY t.next_due_at LIMIT 3"
  ).bind(now, now + 5 * 60_000, now - 120_000).all<CaptureTarget>();
  for (const target of rows.results ?? []) {
    const claim = await env.DB.prepare("INSERT INTO capture_decisions (capture_id, due_at, assessed_at, action, reason) VALUES (?, ?, ?, 'pending', 'Assessment in progress.') ON CONFLICT(capture_id, due_at) DO UPDATE SET assessed_at = excluded.assessed_at WHERE capture_decisions.action = 'pending' AND capture_decisions.assessed_at <= ?")
      .bind(target.capture_id, target.next_due_at, now, now - 120_000).run();
    if (claim.meta?.changes !== 1) continue;
    try {
      const [history, durationSamples, asset] = await Promise.all([
        env.DB.prepare('SELECT sha256, browser_ms, browser_ms_source, captured_at FROM capture_history WHERE capture_id = ? ORDER BY captured_at DESC LIMIT 10').bind(target.capture_id).all<NonNullable<CaptureAssessmentTarget['history']>[number]>(),
        env.DB.prepare(
          "SELECT browser_ms, browser_ms_source, reserve_ms, attempt, outcome FROM capture_duration_samples " +
          "WHERE capture_id = ? AND sampled_at >= ? ORDER BY sampled_at DESC LIMIT 500",
        ).bind(target.capture_id, now - DURATION_REVIEW_WINDOW_MS).all<{ browser_ms: number; browser_ms_source: string; reserve_ms: number; attempt: number; outcome: string }>(),
        target.current_sha256 ? env.ASSETS.head(`assets/${target.current_sha256}`) : Promise.resolve(null),
      ]);
      target.history = history.results ?? [];
      target.duration_summary = summarizeCaptureDurations(durationSamples.results ?? [], reserveMs);
      target.current_asset_present = Boolean(asset && asset.size === target.current_size);
      const state = buildCaptureAssessmentState(target, now);
      const result = await decide(env, { state, questions: captureAssessmentQuestions });
      const policy = decideCapturePolicy(target, result, now);
      await env.DB.prepare("UPDATE capture_decisions SET action = ?, reason = ?, state_json = ?, decision_json = ?, model = ? WHERE capture_id = ? AND due_at = ? AND action = 'pending' AND assessed_at = ?")
        .bind(policy.action, policy.reason, state, JSON.stringify(result), result.model ?? null, target.capture_id, target.next_due_at, now).run();
    } catch (error) {
      console.error(JSON.stringify({ event: 'capture_assessment_failed', message: String(error != null && typeof error === "object" && "message" in error ? error.message ?? error : error).slice(0, 200) }));
      await env.DB.prepare("UPDATE capture_decisions SET action = 'error', reason = 'Assessment unavailable; the normal schedule remains in effect.' WHERE capture_id = ? AND due_at = ? AND action = 'pending' AND assessed_at = ?")
        .bind(target.capture_id, target.next_due_at, now).run();
    }
  }
  await env.DB.prepare('DELETE FROM capture_decisions WHERE assessed_at < ?').bind(now - 30 * 24 * 60 * 60_000).run();
}
