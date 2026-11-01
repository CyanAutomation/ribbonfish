// The model supplies a suggestion; deterministic rules bound any prospective deferral.
export function decideCapturePolicy(target, decision, now) {
  const interval = target.capture_interval_seconds * 1000;
  const due = target.next_due_at;
  const recent = (target.history ?? []).slice(0, 3);
  const stable = target.current_sha256 && recent.length === 3 && recent.every((item) => item.sha256 === target.current_sha256);
  const safe = Number.isSafeInteger(interval) && interval > 0 && Number.isSafeInteger(due) &&
    Number.isSafeInteger(target.last_success_at) && target.last_success_at <= now &&
    due >= now && due + interval - target.last_success_at <= 2 * interval &&
    target.current_asset_present && !target.failure_count && !target.last_error && !target.job_status && stable;
  if (safe && decision?.answers?.recommendation?.choice === 'skip_once' &&
      Number.isFinite(decision?.answers?.risk?.score) && decision.answers.risk.score <= 0.5) {
    return { action: 'defer_once', next_due_at: due + interval,
      reason: 'Three recent screenshots are identical and the current image is available.' };
  }
  return { action: 'capture', next_due_at: due, reason: 'Keep the scheduled capture when evidence is insufficient or a safeguard applies.' };
}

import { buildCaptureAssessmentState, captureAssessmentQuestions } from './jev-use-cases.js';
import { callJevDecision } from './jev.js';

// Shadow decisions are recorded ahead of time and never modify capture schedules.
export async function assessUpcomingCaptures(env, now = Date.now(), decide = callJevDecision) {
  const rows = await env.DB.prepare(
    "SELECT t.*, (SELECT j.status FROM capture_jobs j WHERE j.capture_id = t.capture_id AND j.status IN ('queued','running') LIMIT 1) AS job_status " +
    "FROM capture_targets t WHERE t.enabled = 1 AND t.next_due_at > ? AND t.next_due_at <= ? " +
    "AND EXISTS (SELECT 1 FROM playlist_capture_items p JOIN active_playlist a ON a.playlist_id = p.playlist_id AND a.revision = p.revision WHERE p.capture_id = t.capture_id) " +
    "AND NOT EXISTS (SELECT 1 FROM capture_decisions d WHERE d.capture_id = t.capture_id AND d.due_at = t.next_due_at AND (d.action != 'pending' OR d.assessed_at > ?)) " +
    "ORDER BY t.next_due_at LIMIT 3"
  ).bind(now, now + 5 * 60_000, now - 120_000).all();
  for (const target of rows.results ?? []) {
    const claim = await env.DB.prepare("INSERT INTO capture_decisions (capture_id, due_at, assessed_at, action, reason) VALUES (?, ?, ?, 'pending', 'Assessment in progress.') ON CONFLICT(capture_id, due_at) DO UPDATE SET assessed_at = excluded.assessed_at WHERE capture_decisions.action = 'pending' AND capture_decisions.assessed_at <= ?")
      .bind(target.capture_id, target.next_due_at, now, now - 120_000).run();
    if (claim.meta?.changes !== 1) continue;
    try {
      const [history, asset] = await Promise.all([
        env.DB.prepare('SELECT sha256, browser_ms, captured_at FROM capture_history WHERE capture_id = ? ORDER BY captured_at DESC LIMIT 10').bind(target.capture_id).all(),
        target.current_sha256 ? env.ASSETS.head(`assets/${target.current_sha256}`) : Promise.resolve(null),
      ]);
      target.history = history.results ?? [];
      target.current_asset_present = Boolean(asset && asset.size === target.current_size);
      const state = buildCaptureAssessmentState(target, now);
      const result = await decide(env, { state, questions: captureAssessmentQuestions });
      const policy = decideCapturePolicy(target, result, now);
      await env.DB.prepare("UPDATE capture_decisions SET action = ?, reason = ?, state_json = ?, decision_json = ?, model = ? WHERE capture_id = ? AND due_at = ? AND action = 'pending' AND assessed_at = ?")
        .bind(policy.action, policy.reason, state, JSON.stringify(result), result.model ?? null, target.capture_id, target.next_due_at, now).run();
    } catch (error) {
      console.error(JSON.stringify({ event: 'capture_assessment_failed', message: String(error?.message ?? error).slice(0, 200) }));
      await env.DB.prepare("UPDATE capture_decisions SET action = 'error', reason = 'Assessment unavailable; the normal schedule remains in effect.' WHERE capture_id = ? AND due_at = ? AND action = 'pending' AND assessed_at = ?")
        .bind(target.capture_id, target.next_due_at, now).run();
    }
  }
  await env.DB.prepare('DELETE FROM capture_decisions WHERE assessed_at < ?').bind(now - 30 * 24 * 60 * 60_000).run();
}
