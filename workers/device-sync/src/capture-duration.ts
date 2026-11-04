export type CaptureDurationSource = "response_header" | "reserve" | "unknown";

export interface CaptureDurationSampleSummaryInput {
  browser_ms: number;
  browser_ms_source: string;
  reserve_ms?: number;
  attempt?: number;
  outcome?: string;
}

export interface CaptureDurationSummary {
  total_samples: number;
  measured_sample_count: number;
  reserve_estimated_sample_count: number;
  unknown_sample_count: number;
  failed_attempt_count: number;
  retry_attempt_count: number;
  capture_attempt_failure_rate: number;
  retry_attempt_rate: number;
  measured_header_coverage: number;
  measured_p50_ms: number | null;
  measured_p90_ms: number | null;
  measured_average_ms: number | null;
  reserve_estimated_total_ms: number;
  configured_reserve_ms: number;
  conservative_review: "review" | "insufficient_data" | "not_flagged";
}

const MIN_MEASURED_SAMPLES_FOR_REVIEW = 20;
const MIN_MEASURED_COVERAGE_FOR_REVIEW = 0.8;
const MAX_P90_SHARE_OF_RESERVE_FOR_REVIEW = 0.5;

export function summarizeCaptureDurations(
  samples: CaptureDurationSampleSummaryInput[],
  configuredReserveMs: number,
): CaptureDurationSummary {
  const measured: number[] = [];
  let reserveEstimatedSampleCount = 0;
  let unknownSampleCount = 0;
  let reserveEstimatedTotalMs = 0;
  let failedBrowserRunAttemptCount = 0;
  let retryAttemptCount = 0;

  for (const sample of samples) {
    const duration = nonNegative(sample.browser_ms);
    if (sample.browser_ms_source === "response_header") measured.push(duration);
    else if (sample.browser_ms_source === "reserve") {
      reserveEstimatedSampleCount += 1;
      reserveEstimatedTotalMs += duration;
    } else unknownSampleCount += 1;
    if (sample.outcome === "failed") failedBrowserRunAttemptCount += 1;
    if (typeof sample.attempt === "number" && Number.isSafeInteger(sample.attempt) && sample.attempt > 1) retryAttemptCount += 1;
  }

  measured.sort((left, right) => left - right);
  const measuredCount = measured.length;
  const measuredHeaderCoverage = samples.length ? measuredCount / samples.length : 0;
  const reserveMs = nonNegative(configuredReserveMs);
  const p90 = percentile(measured, 0.9);
  const conservativeReview = classifyConservativeDurationReview(
    measuredCount,
    measuredHeaderCoverage,
    p90,
    reserveMs,
  );

  return {
    total_samples: samples.length,
    measured_sample_count: measuredCount,
    reserve_estimated_sample_count: reserveEstimatedSampleCount,
    unknown_sample_count: unknownSampleCount,
    failed_attempt_count: failedBrowserRunAttemptCount,
    retry_attempt_count: retryAttemptCount,
    capture_attempt_failure_rate: samples.length ? failedBrowserRunAttemptCount / samples.length : 0,
    retry_attempt_rate: samples.length ? retryAttemptCount / samples.length : 0,
    measured_header_coverage: measuredHeaderCoverage,
    measured_p50_ms: median(measured),
    measured_p90_ms: p90,
    measured_average_ms: measuredCount ? measured.reduce((sum, value) => sum + value, 0) / measuredCount : null,
    reserve_estimated_total_ms: reserveEstimatedTotalMs,
    configured_reserve_ms: reserveMs,
    conservative_review: conservativeReview,
  };
}

export function classifyConservativeDurationReview(
  measuredCount: number,
  measuredHeaderCoverage: number,
  measuredP90Ms: number | null,
  configuredReserveMs: number,
): CaptureDurationSummary["conservative_review"] {
  if (measuredCount < MIN_MEASURED_SAMPLES_FOR_REVIEW ||
      measuredHeaderCoverage < MIN_MEASURED_COVERAGE_FOR_REVIEW ||
      configuredReserveMs <= 0 || measuredP90Ms === null) return "insufficient_data";
  return measuredP90Ms <= configuredReserveMs * MAX_P90_SHARE_OF_RESERVE_FOR_REVIEW ? "review" : "not_flagged";
}

function percentile(sorted: number[], quantile: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.ceil(quantile * sorted.length) - 1] ?? null;
}

function median(sorted: number[]): number | null {
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] ?? null : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
