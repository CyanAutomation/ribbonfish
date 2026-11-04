export const CLOUDFLARE_FREE_BROWSER_DAILY_LIMIT_MS = 600_000;
const SECONDS_PER_DAY = 24 * 60 * 60;

export interface CaptureForecastTarget {
  capture_id: string;
  display_label: string;
  capture_interval_seconds: number;
  active_in_playlist: boolean;
  schedule_reviewed: boolean;
  average_browser_ms: number | null;
  browser_ms_samples: number;
}

export type CaptureRuntimeSource = "site-history" | "fleet-history" | "unavailable";

export interface CaptureSiteForecast {
  capture_id: string;
  display_label: string;
  interval_seconds: number | null;
  captures_per_day: number | null;
  average_browser_ms: number | null;
  browser_ms_samples: number;
  runtime_source: CaptureRuntimeSource;
  estimated_browser_ms_per_day: number | null;
}

export interface DailyCaptureForecast {
  free_plan_limit_ms: number;
  worker_budget_ms: number;
  total_estimated_ms: number | null;
  known_estimated_ms: number;
  is_complete: boolean;
  sites: CaptureSiteForecast[];
}

export interface DailyCaptureForecastOptions {
  freePlanLimitMs?: number;
  workerBudgetMs?: number;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validRuntime(target: CaptureForecastTarget) {
  return target.browser_ms_samples > 0 && isFiniteNonNegative(target.average_browser_ms);
}

export function calculateDailyCaptureForecast(
  targets: CaptureForecastTarget[],
  intervalOverrides: ReadonlyMap<string, number> = new Map(),
  options: DailyCaptureForecastOptions = {},
): DailyCaptureForecast {
  const eligible = targets.filter((target) => target.active_in_playlist && target.schedule_reviewed);
  const sampled = eligible.filter(validRuntime);
  const sampleWeight = sampled.reduce((total, target) => total + target.browser_ms_samples, 0);
  const fleetAverage = sampleWeight > 0
    ? sampled.reduce((total, target) => total + (target.average_browser_ms ?? 0) * target.browser_ms_samples, 0) / sampleWeight
    : null;

  let knownEstimatedMs = 0;
  let isComplete = eligible.length > 0;
  const sites = eligible.map((target): CaptureSiteForecast => {
    const override = intervalOverrides.get(target.capture_id);
    const interval = Number.isSafeInteger(override) && Number(override) > 0
      ? Number(override) : target.capture_interval_seconds;
    const validInterval = Number.isSafeInteger(interval) && interval > 0;
    const capturesPerDay = validInterval ? SECONDS_PER_DAY / interval : null;
    const hasSiteRuntime = validRuntime(target);
    const averageBrowserMs = hasSiteRuntime ? target.average_browser_ms : fleetAverage;
    const runtimeSource: CaptureRuntimeSource = hasSiteRuntime
      ? "site-history" : averageBrowserMs === null ? "unavailable" : "fleet-history";
    const estimatedBrowserMsPerDay = averageBrowserMs !== null && capturesPerDay !== null
      ? averageBrowserMs * capturesPerDay : null;

    if (estimatedBrowserMsPerDay === null) isComplete = false;
    else knownEstimatedMs += estimatedBrowserMsPerDay;

    return {
      capture_id: target.capture_id,
      display_label: target.display_label,
      interval_seconds: validInterval ? interval : null,
      captures_per_day: capturesPerDay,
      average_browser_ms: averageBrowserMs,
      browser_ms_samples: hasSiteRuntime ? target.browser_ms_samples : 0,
      runtime_source: validInterval ? runtimeSource : "unavailable",
      estimated_browser_ms_per_day: estimatedBrowserMsPerDay,
    };
  });

  const limit = options.freePlanLimitMs ?? CLOUDFLARE_FREE_BROWSER_DAILY_LIMIT_MS;
  const budget = options.workerBudgetMs ?? limit;
  return {
    free_plan_limit_ms: isFiniteNonNegative(limit) ? limit : CLOUDFLARE_FREE_BROWSER_DAILY_LIMIT_MS,
    worker_budget_ms: isFiniteNonNegative(budget) ? budget : CLOUDFLARE_FREE_BROWSER_DAILY_LIMIT_MS,
    total_estimated_ms: isComplete ? knownEstimatedMs : null,
    known_estimated_ms: knownEstimatedMs,
    is_complete: isComplete,
    sites,
  };
}
