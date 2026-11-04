import {
  CLOUDFLARE_FREE_BROWSER_DAILY_LIMIT_MS,
  type CaptureForecastTarget,
  type DailyCaptureForecast,
} from "../../src/capture-forecast.ts";
import { formatJevCaptureOutcomeSummary, formatRunTime } from "./capture-presentation.ts";
import { renderCaptureUsageForecast } from "./capture-forecast-view.ts";
import { node } from "./ui-primitives.ts";

interface CaptureTargetSummary {
  capture_id: string;
  display_url: string;
  name?: string | null;
  capture_interval_seconds: number;
  active_in_playlist?: boolean;
  schedule_reviewed?: boolean;
  average_browser_ms?: number | null;
  browser_ms_samples?: number;
}

interface CaptureEfficiencySummary {
  daily_usage?: {
    accounted_ms?: number;
    budget_ms?: number;
    free_plan_limit_ms?: number;
  };
  last_30_days?: Record<string, any>;
}

const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
const milliseconds = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;

/** Compose the Browser Run forecast and recent outcomes into the standalone module region. */
export function renderCaptureEfficiencyModule(
  container: HTMLElement,
  targets: CaptureTargetSummary[],
  efficiency: CaptureEfficiencySummary | null | undefined,
): DailyCaptureForecast | null {
  const ownerDocument = container.ownerDocument;
  if (!efficiency) {
    container.replaceChildren(node(
      "p",
      "Capture efficiency data is unavailable. Refresh the page to try again.",
      "muted",
      ownerDocument,
    ));
    return null;
  }

  const forecastTargets: CaptureForecastTarget[] = targets.map((target) => ({
    capture_id: target.capture_id,
    display_label: target.name || target.display_url,
    capture_interval_seconds: target.capture_interval_seconds,
    active_in_playlist: target.active_in_playlist === true,
    schedule_reviewed: target.schedule_reviewed === true,
    average_browser_ms: typeof target.average_browser_ms === "number" ? target.average_browser_ms : null,
    browser_ms_samples: count(target.browser_ms_samples),
  }));
  const dailyUsage = efficiency.daily_usage ?? {};
  const forecast = renderCaptureUsageForecast(container, forecastTargets, {
    accounted_ms: milliseconds(dailyUsage.accounted_ms),
    budget_ms: milliseconds(dailyUsage.budget_ms),
    free_plan_limit_ms: dailyUsage.free_plan_limit_ms === undefined
      ? CLOUDFLARE_FREE_BROWSER_DAILY_LIMIT_MS
      : milliseconds(dailyUsage.free_plan_limit_ms),
  });

  const recent = efficiency.last_30_days ?? {};
  const runTime = recent.browser_run_ms ?? {};
  const history = node("details", undefined, "capture-outcomes-details", ownerDocument);
  history.append(node("summary", "Last 30 days of capture outcomes", undefined, ownerDocument));
  history.append(node(
    "p",
    count(recent.successful_screenshots) + " screenshots completed, " +
    count(recent.validator_unchanged) + " unchanged validator checks skipped Browser Run, " +
    count(recent.successful_unclassified) + " older results unclassified. Browser Run time: " +
    formatRunTime(runTime.response_header) + " measured, " +
    formatRunTime(runTime.reserve) + " reserve-estimated, " +
    count(runTime.unclassified_jobs) + " older jobs unclassified. " +
    formatJevCaptureOutcomeSummary(recent),
    "muted",
    ownerDocument,
  ));
  container.append(history);
  return forecast;
}
