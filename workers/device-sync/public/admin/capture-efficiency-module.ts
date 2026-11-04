import {
  CLOUDFLARE_FREE_BROWSER_DAILY_LIMIT_MS,
  type CaptureForecastTarget,
  type DailyCaptureForecast,
} from "../../src/capture-forecast.ts";
import { formatJevCaptureOutcomeSummary, formatRunTime } from "./capture-presentation.ts";
import { renderCaptureUsageForecast } from "./capture-forecast-view.ts";
import { node } from "./ui-primitives.ts";
import type { CaptureDurationSummary } from "../../src/capture-duration.ts";

interface CaptureTargetSummary {
  capture_id: string;
  display_url: string;
  name?: string | null;
  capture_interval_seconds: number;
  wait_for_selector?: string | null;
  active_in_playlist?: boolean;
  schedule_reviewed?: boolean;
  average_browser_ms?: number | null;
  browser_ms_samples?: number;
  duration_summary?: CaptureDurationSummary;
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

  const durationSection = node("section", undefined, "capture-duration-analysis", ownerDocument);
  durationSection.append(node("h3", "Per-site capture duration samples", undefined, ownerDocument));
  durationSection.append(node(
    "p",
    "Measured Browser Run time, reserve estimates, and screenshot readiness are separate signals. A possible reserve overestimate is a review cue only; it does not change the configured reserve.",
    "muted",
    ownerDocument,
  ));
  const durationList = node("ul", undefined, "capture-duration-analysis__sites", ownerDocument);
  for (const target of targets) {
    const summary = target.duration_summary;
    const item = node("li", undefined, "capture-duration-analysis__site", ownerDocument);
    item.append(node("strong", target.name || target.display_url, undefined, ownerDocument));
    const readinessMode = target.wait_for_selector ? "selector gated" : "domcontentloaded";
    if (!summary || summary.total_samples === 0) {
      item.append(node("p", "No Browser Run duration samples yet. Current reserve: " +
        formatRunTime(summary?.configured_reserve_ms) + " · readiness: " + readinessMode + ".", "muted", ownerDocument));
    } else {
      item.append(node(
        "p",
        summary.measured_sample_count + " measured samples · p50 " + formatRunTime(summary.measured_p50_ms) +
        " · p90 " + formatRunTime(summary.measured_p90_ms) + " · " +
        Math.round(summary.measured_header_coverage * 100) + "% measured-header coverage",
        "muted",
        ownerDocument,
      ));
      item.append(node(
        "p",
        summary.reserve_estimated_sample_count + " reserve-estimated samples · " +
        formatRunTime(summary.reserve_estimated_total_ms) + " reserved · current reserve " +
        formatRunTime(summary.configured_reserve_ms) + " · " + summary.unknown_sample_count + " unknown · " +
        summary.failed_attempt_count + " failed capture " + (summary.failed_attempt_count === 1 ? "attempt" : "attempts") + " · " +
        summary.retry_attempt_count + " retry " + (summary.retry_attempt_count === 1 ? "attempt" : "attempts") +
        " · readiness: " + readinessMode,
        "muted",
        ownerDocument,
      ));
      const assessment = summary.conservative_review === "review"
        ? "Possible reserve overestimate: measured p90 is at most half the configured reserve. Review this target; the reserve remains unchanged."
        : summary.conservative_review === "not_flagged"
          ? "No possible reserve overestimate indicated by the current measured samples."
          : "Not enough measured samples and coverage to assess the reserve.";
      item.append(node("p", assessment,
        summary.conservative_review === "review" ? "capture-duration-analysis__review" : "muted", ownerDocument));
    }
    durationList.append(item);
  }
  durationSection.append(durationList);
  container.append(durationSection);

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
