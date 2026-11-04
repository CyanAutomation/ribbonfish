import type { CaptureDurationSummary } from "./capture-duration.ts";

export interface CaptureAssessmentTarget {
  last_success_at: number | null;
  next_due_at: number;
  capture_interval_seconds: number;
  failure_count: number;
  job_status?: string | null;
  last_error?: string | null;
  wait_for_selector?: string | null;
  readiness_mode?: string | null;
  history?: { sha256: string | null; browser_ms: number; browser_ms_source: string | null }[];
  duration_summary?: CaptureDurationSummary;
}

export const captureAssessmentQuestions = Object.freeze({
  duration_review: {
    type: "choice",
    instructions: "Should the operator review this site's configured Browser Run accounting reserve based on the supplied duration evidence? Recommend review_duration only when the measured Browser Run p90 is far below the configured reserve and the measured sample count and coverage are sufficient. The reserve is an accounting estimate, not a Browser Run timeout or screenshot wait. This question does not judge screenshot completeness or page readiness, and must never recommend an automatic change.",
    criteria: {
      keep_current: "Keep the current settings or evidence is insufficient",
      review_duration: "Recommend an operator review of the accounting reserve; do not change it",
    },
  },
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
  const durationSummary = target.duration_summary;
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
    capture_duration: {
      total_samples: safeCount(durationSummary?.total_samples),
      measured_sample_count: safeCount(durationSummary?.measured_sample_count),
      reserve_estimated_sample_count: safeCount(durationSummary?.reserve_estimated_sample_count),
      unknown_sample_count: safeCount(durationSummary?.unknown_sample_count),
      failed_attempt_count: safeCount(durationSummary?.failed_attempt_count),
      retry_attempt_count: safeCount(durationSummary?.retry_attempt_count),
      capture_attempt_failure_rate: safeRatio(durationSummary?.capture_attempt_failure_rate),
      retry_attempt_rate: safeRatio(durationSummary?.retry_attempt_rate),
      measured_header_coverage: safeRatio(durationSummary?.measured_header_coverage),
      measured_p50_ms: safeDuration(durationSummary?.measured_p50_ms),
      measured_p90_ms: safeDuration(durationSummary?.measured_p90_ms),
      measured_average_ms: safeDuration(durationSummary?.measured_average_ms),
      reserve_estimated_total_ms: safeCount(durationSummary?.reserve_estimated_total_ms),
      configured_reserve_ms: safeCount(durationSummary?.configured_reserve_ms, 60_000),
      conservative_review: durationSummary?.conservative_review === "review" || durationSummary?.conservative_review === "not_flagged"
        ? durationSummary.conservative_review : "insufficient_data",
    },
    readiness_mode: target.readiness_mode === "selector" || target.wait_for_selector ? "selector" : "domcontentloaded",
    recent_content_change_count: recentContentChangeCount,
    unchanged_capture_streak: unchangedCaptureStreak,
  });
}

export function durationReviewRecommendation(answers: unknown, durationSummary?: CaptureDurationSummary) {
  if (durationSummary?.conservative_review === "insufficient_data") return "insufficient_data";
  if (durationSummary?.conservative_review !== "review") return "keep_current";
  if (!answers || typeof answers !== "object") return "keep_current";
  const answer = (answers as Record<string, unknown>).duration_review;
  if (!answer || typeof answer !== "object") return "keep_current";
  const choice = (answer as Record<string, unknown>).choice;
  const confidence = (answer as Record<string, unknown>).confidence;
  return choice === "review_duration" && typeof confidence === "number" && Number.isFinite(confidence) && confidence >= 0.8
    ? "review" : "keep_current";
}

function safeCount(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function safeRatio(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0;
}

function safeDuration(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
