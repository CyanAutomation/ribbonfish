export interface CaptureAssessmentTarget {
  last_success_at: number | null;
  next_due_at: number;
  capture_interval_seconds: number;
  failure_count: number;
  job_status?: string | null;
  last_error?: string | null;
  history?: { sha256: string | null; browser_ms: number; browser_ms_source: string | null }[];
}

export const captureAssessmentQuestions = Object.freeze({
  recommendation: {
    type: "choice",
    instructions: "Should the operator keep the next screenshot due, or consider skipping this single screenshot opportunity? Use recent content changes and freshness signals. Recommend skip_once only when multiple recent screenshots are unchanged, the current image is fresh, and there are no failures or active jobs. This is advisory and requires explicit human confirmation.",
    criteria: {
      capture_now: "Keep the scheduled capture; freshness, errors, or missing history argue against skipping",
      skip_once: "Consider skipping one screenshot opportunity; the current screenshot appears sufficiently fresh and signals show low risk",
    },
  },
  risk: {
    type: "score",
    instructions: "Rate the risk of skipping this one screenshot opportunity. Consider stale or missing screenshots, recent content changes, failures, and active jobs.",
    criteria: ["Low", "Moderate", "High"],
  },
});

export function buildCaptureAssessmentState(target: CaptureAssessmentTarget, now = Date.now()) {
  const lastSuccess = typeof target.last_success_at === "number" && Number.isFinite(target.last_success_at) ? target.last_success_at : null;
  const nextDue = Number.isFinite(target.next_due_at) ? target.next_due_at : now;
  const durations = (target.history ?? []).filter((item) => item.browser_ms_source === "response_header")
    .map((item) => item.browser_ms)
    .filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  const midpoint = Math.floor(durations.length / 2);
  const medianBrowserMs = durations.length
    ? durations.length % 2 ? durations[midpoint] : Math.round((durations[midpoint - 1] + durations[midpoint]) / 2)
    : null;
  const recentHashes = (target.history ?? []).slice(0, 10)
    .map((item) => typeof item.sha256 === "string" ? item.sha256 : null);
  let recentContentChangeCount = 0;
  for (let index = 1; index < recentHashes.length; index++) {
    if (recentHashes[index] && recentHashes[index - 1] && recentHashes[index] !== recentHashes[index - 1]) {
      recentContentChangeCount += 1;
    }
  }
  let unchangedCaptureStreak = 0;
  if (recentHashes[0]) {
    for (let index = 1; index < recentHashes.length && recentHashes[index] === recentHashes[0]; index++) {
      unchangedCaptureStreak += 1;
    }
  }
  return JSON.stringify({
    screenshot_age_seconds: lastSuccess === null ? null : Math.max(0, Math.floor((now - lastSuccess) / 1000)),
    configured_interval_seconds: Number.isSafeInteger(target.capture_interval_seconds) ? target.capture_interval_seconds : null,
    seconds_until_due: Math.max(0, Math.floor((nextDue - now) / 1000)),
    consecutive_failures: Number.isSafeInteger(target.failure_count) ? Math.max(0, target.failure_count) : 0,
    recent_job: (target.job_status === "queued" || target.job_status === "running") ? target.job_status : "none",
    recent_error_present: Boolean(target.last_error),
    recent_capture_count: (target.history ?? []).length,
    browser_duration_sample_count: durations.length,
    median_browser_ms: medianBrowserMs,
    recent_content_change_count: recentContentChangeCount,
    unchanged_capture_streak: unchangedCaptureStreak,
  });
}
