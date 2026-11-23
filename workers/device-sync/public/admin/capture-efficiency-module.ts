import {
  CLOUDFLARE_FREE_BROWSER_DAILY_LIMIT_MS,
  type CaptureForecastTarget,
  type CaptureSiteForecast,
  type DailyCaptureForecast,
} from "../../src/capture-forecast.ts";
import { formatRunTime } from "./capture-presentation.ts";
import { renderCaptureUsageForecast } from "./capture-forecast-view.ts";
import { node } from "./ui-primitives.ts";
import { formatCaptureInterval } from "./ui-formatters.ts";
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

function buildForecastTargets(targets: CaptureTargetSummary[]): CaptureForecastTarget[] {
  return targets.map((target) => ({
    capture_id: target.capture_id,
    display_label: target.name || target.display_url,
    capture_interval_seconds: target.capture_interval_seconds,
    active_in_playlist: target.active_in_playlist === true,
    schedule_reviewed: target.schedule_reviewed === true,
    average_browser_ms: typeof target.average_browser_ms === "number" ? target.average_browser_ms : null,
    browser_ms_samples: count(target.browser_ms_samples),
  }));
}

function table(
  ownerDocument: Document,
  caption: string,
  dataTable: string,
  columns: string[],
  rows: string[][],
): HTMLElement {
  const wrapper = node("div", undefined, "table-scroll capture-efficiency-table-scroll", ownerDocument);
  wrapper.tabIndex = 0;
  const element = node("table", undefined, "data-table capture-efficiency-table", ownerDocument);
  element.dataset.table = dataTable;
  element.append(node("caption", caption, undefined, ownerDocument));
  const head = node("thead", undefined, undefined, ownerDocument);
  const heading = node("tr", undefined, undefined, ownerDocument);
  columns.forEach((label) => {
    const cell = node("th", label, undefined, ownerDocument);
    cell.setAttribute("scope", "col");
    heading.append(cell);
  });
  head.append(heading);
  const body = node("tbody", undefined, undefined, ownerDocument);
  rows.forEach((values) => {
    const row = node("tr", undefined, undefined, ownerDocument);
    values.forEach((value, index) => {
      const cell = node(index === 0 ? "th" : "td", value, undefined, ownerDocument);
      if (index === 0) cell.setAttribute("scope", "row");
      row.append(cell);
    });
    body.append(row);
  });
  element.append(head, body);
  wrapper.append(element);
  return wrapper;
}

function describeReadiness(target: CaptureTargetSummary) {
  return target.wait_for_selector ? "Wait for CSS selector" : "DOM content loaded (default)";
}

function reserveReview(value: CaptureDurationSummary["reserve_review"] | undefined): string {
  if (value === "possible_overestimate") {
    return "Possible reserve overestimate. Measured p90 is at most half the configured reserve; review the accounting reserve, which remains unchanged.";
  }
  if (value === "possible_underestimate") {
    return "Possible reserve underestimate. Measured p90 exceeds the configured reserve; review the accounting reserve, which remains unchanged.";
  }
  if (value === "not_flagged") {
    return "Current measured samples do not indicate a possible reserve overestimate or underestimate.";
  }
  return "Not enough measured samples and coverage to assess the reserve.";
}

function measuredHeaderCoverage(summary: CaptureDurationSummary | undefined, measuredSamples: number) {
  if (typeof summary?.measured_header_coverage !== "number") return "No measured header data";
  return `${Math.round(summary.measured_header_coverage * 100)}% across ${measuredSamples} measured samples`;
}

function measuredRange(summary: CaptureDurationSummary | undefined, measuredSamples: number) {
  if (!measuredSamples) return "No measured samples";
  return `${formatRunTime(summary?.measured_p50_ms)} / ${formatRunTime(summary?.measured_p90_ms)}`;
}

function reserveEstimate(summary: CaptureDurationSummary | undefined) {
  if (!summary) return "No duration summary available";
  return `${count(summary.reserve_estimated_sample_count)} reserve-estimated samples · ${formatRunTime(summary.reserve_estimated_total_ms)} total · ${formatRunTime(summary.configured_reserve_ms)} configured reserve`;
}

function attemptSummary(summary: CaptureDurationSummary | undefined) {
  if (!summary) return "No attempt summary available";
  const failed = count(summary.failed_attempt_count);
  const retries = count(summary.retry_attempt_count);
  return `${count(summary.unknown_sample_count)} unknown · ${failed} failed ${failed === 1 ? "attempt" : "attempts"} · ${retries} ${retries === 1 ? "retry" : "retries"}`;
}

function durationRow(target: CaptureTargetSummary): string[] {
  const summary = target.duration_summary;
  const measuredSamples = count(summary?.measured_sample_count);
  return [
    target.name || target.display_url,
    String(measuredSamples),
    measuredRange(summary, measuredSamples),
    measuredHeaderCoverage(summary, measuredSamples),
    reserveEstimate(summary),
    attemptSummary(summary),
    describeReadiness(target),
    reserveReview(summary?.reserve_review),
  ];
}

function durationRows(targets: CaptureTargetSummary[]): string[][] {
  return targets.map(durationRow);
}

function scheduleRows(sites: CaptureSiteForecast[]): string[][] {
  return sites.map((site) => {
    const runtime = site.average_browser_ms === null
      ? "Runtime sample needed"
      : `${formatRunTime(site.average_browser_ms)} per capture (${site.runtime_source === "site-history" ? `${site.browser_ms_samples} site samples` : "fleet average"})`;
    const dailyEstimate = site.estimated_browser_ms_per_day === null
      ? "Unavailable until a runtime sample is recorded"
      : `${formatRunTime(site.estimated_browser_ms_per_day)} per day`;
    return [
      site.display_label,
      site.interval_seconds === null ? "Unavailable" : formatCaptureInterval(site.interval_seconds),
      site.captures_per_day?.toFixed(1) ?? "Unavailable",
      runtime,
      dailyEstimate,
    ];
  });
}

function recentOutcomeRows(efficiency: CaptureEfficiencySummary): string[][] {
  const recent = efficiency.last_30_days ?? {};
  const runTime = recent.browser_run_ms ?? {};
  const labelCount = (value: unknown, singular: string, plural = `${singular}s`) => {
    const amount = count(value);
    return `${amount} ${amount === 1 ? singular : plural}`;
  };
  return [
    ["Successful screenshots", labelCount(recent.successful_screenshots, "screenshot")],
    ["Unchanged HTTP-validator checks that skipped Browser Run", labelCount(recent.validator_unchanged, "check")],
    ["Successful older results not classified", labelCount(recent.successful_unclassified, "result")],
    ["Browser Run time measured from response headers", formatRunTime(runTime.response_header)],
    ["Browser Run time estimated using the configured reserve", formatRunTime(runTime.reserve)],
    ["Older Browser Run jobs not classified", labelCount(runTime.unclassified_jobs, "job")],
    ["JEV advisory assessments", labelCount(recent.jev_shadow_assessments, "assessment")],
    ["JEV defer suggestions", labelCount(recent.jev_candidate_deferrals, "suggestion")],
    ["JEV suggestions with changed screenshots", labelCount(recent.jev_candidate_changed, "screenshot")],
    ["JEV suggestions with unchanged screenshots", labelCount(recent.jev_candidate_unchanged, "screenshot")],
    ["JEV validator-only results", labelCount(recent.jev_candidate_validator_unchanged, "result")],
    ["JEV suggestions deferred by budget", labelCount(recent.jev_candidate_budget_deferred, "capture")],
    ["JEV suggestions with failed captures", labelCount(recent.jev_candidate_failed, "capture")],
    ["JEV suggestions without an observed outcome", labelCount(recent.jev_candidate_unobserved, "suggestion")],
    ["Schedule changes made by JEV", "None; suggestions are advisory"],
  ];
}

function renderAdvancedDetails(
  targets: CaptureTargetSummary[],
  forecast: DailyCaptureForecast,
  efficiency: CaptureEfficiencySummary,
  ownerDocument: Document,
): HTMLElement {
  const details = node("details", undefined, "capture-efficiency-advanced", ownerDocument);
  details.append(node("summary", "Advanced details", undefined, ownerDocument));
  details.append(node(
    "p",
    "Measured runtime comes from Browser Run response headers. Reserve-estimated runtime uses the configured fallback reserve when a response header is missing. p50 is the median; p90 is a duration that 90% of measured captures finish within. An HTTP validator (ETag or Last-Modified) is a change marker; a match can skip Browser Run without checking screenshot pixels. JEV (screenshot skip advice) is an advisory model and never changes schedules.",
    "capture-efficiency-advanced__explanation",
    ownerDocument,
  ));
  details.append(table(ownerDocument, "Per-site duration samples", "per-site-duration", [
    "Site", "Measured samples", "p50 / p90", "Measured header coverage", "Reserve-estimated samples / time",
    "Unknown / failed / retries", "Readiness", "Reserve review",
  ], durationRows(targets)));
  details.append(table(ownerDocument, "Current schedule estimates by site", "schedule-estimates", [
    "Site", "Interval", "Captures per day", "Runtime per capture", "Estimated Browser Run time",
  ], scheduleRows(forecast.sites)));
  details.append(table(ownerDocument, "Capture outcomes over the last 30 days", "capture-outcomes", [
    "Measure", "Count or time",
  ], recentOutcomeRows(efficiency)));
  return details;
}

/** Compose the Browser Run forecast and advanced diagnostics into the standalone module region. */
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

  const dailyUsage = efficiency.daily_usage ?? {};
  const forecast = renderCaptureUsageForecast(container, buildForecastTargets(targets), {
    accounted_ms: milliseconds(dailyUsage.accounted_ms),
    budget_ms: milliseconds(dailyUsage.budget_ms),
    free_plan_limit_ms: dailyUsage.free_plan_limit_ms === undefined
      ? CLOUDFLARE_FREE_BROWSER_DAILY_LIMIT_MS
      : milliseconds(dailyUsage.free_plan_limit_ms),
  });
  container.append(renderAdvancedDetails(targets, forecast, efficiency, ownerDocument));
  return forecast;
}
