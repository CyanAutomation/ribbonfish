import {
  calculateDailyCaptureForecast,
  type CaptureForecastTarget,
} from "../../src/capture-forecast.ts";
import { formatRunTime } from "./capture-presentation.ts";
import { formatCaptureInterval } from "./ui-utils.ts";

export interface DailyCaptureUsage {
  accounted_ms: number;
  budget_ms: number;
  free_plan_limit_ms: number;
}

function element<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
}

function safeMilliseconds(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function percentage(value: number, scale: number) {
  return Math.max(0, Math.min(100, (value / scale) * 100));
}

function marker(document: Document, value: number, scale: number, kind: string, label: string) {
  if (value <= 0) return null;
  const line = element(document, "span", undefined, `browser-usage-chart__marker browser-usage-chart__marker--${kind}`);
  line.dataset.quotaMarker = kind;
  line.style.left = `${percentage(value, scale)}%`;
  line.title = label;
  return line;
}

function chartRow(
  document: Document,
  label: string,
  valueMs: number,
  scaleMs: number,
  markers: Array<{ value: number; kind: string; label: string }>,
  siteSegments?: Array<{ capture_id: string; value_ms: number }>,
) {
  const row = element(document, "div", undefined, "browser-usage-chart__row");
  const heading = element(document, "div", undefined, "browser-usage-chart__heading");
  heading.append(element(document, "span", label));
  heading.append(element(document, "strong", formatRunTime(valueMs)));
  row.append(heading);

  const track = element(document, "div", undefined, "browser-usage-chart__track");
  track.setAttribute("role", "img");
  track.setAttribute("aria-label", `${label}: ${formatRunTime(valueMs)} on a scale ending at ${formatRunTime(scaleMs)}`);
  if (siteSegments) {
    const stack = element(document, "div", undefined, "browser-usage-chart__stack");
    stack.setAttribute("aria-hidden", "true");
    siteSegments.forEach((site, index) => {
      if (site.value_ms <= 0) return;
      const segment = element(document, "span", undefined, `browser-usage-chart__segment browser-usage-chart__segment--${index % 6}`);
      segment.style.width = `${percentage(site.value_ms, scaleMs)}%`;
      segment.dataset.captureId = site.capture_id;
      stack.append(segment);
    });
    track.append(stack);
  } else {
    const bar = element(document, "span", undefined, "browser-usage-chart__bar browser-usage-chart__bar--actual");
    bar.style.width = `${percentage(valueMs, scaleMs)}%`;
    track.append(bar);
  }

  markers.forEach(({ value, kind, label: markerLabel }) => {
    const line = marker(document, value, scaleMs, kind, markerLabel);
    if (line) track.append(line);
  });
  row.append(track);
  return row;
}

export function renderCaptureUsageForecast(
  container: HTMLElement,
  targets: CaptureForecastTarget[],
  dailyUsage: DailyCaptureUsage,
  intervalOverrides: ReadonlyMap<string, number> = new Map(),
) {
  const document = container.ownerDocument;
  const daily = {
    accounted: safeMilliseconds(dailyUsage.accounted_ms),
    budget: safeMilliseconds(dailyUsage.budget_ms),
    quota: safeMilliseconds(dailyUsage.free_plan_limit_ms),
  };
  const forecast = calculateDailyCaptureForecast(targets, intervalOverrides, {
    freePlanLimitMs: daily.quota,
    workerBudgetMs: daily.budget,
  });
  const forecastDisplayMs = forecast.total_estimated_ms ?? forecast.known_estimated_ms;
  const scaleMs = Math.max(daily.quota, daily.budget, daily.accounted, forecastDisplayMs, 1000);
  const markers = [
    { value: daily.budget, kind: "worker-budget", label: `Ribbonfish capture budget: ${formatRunTime(daily.budget)}` },
    { value: daily.quota, kind: "free-plan", label: `Cloudflare Free allowance: ${formatRunTime(daily.quota)}` },
  ];

  const section = element(document, "section", undefined, "browser-usage-forecast");
  section.setAttribute("aria-label", "Browser Run usage forecast");
  const metrics = element(document, "div", undefined, "browser-usage-forecast__metrics");
  const actualMetric = element(document, "div", undefined, "browser-usage-forecast__metric");
  actualMetric.append(element(document, "span", "Ribbonfish used today"));
  actualMetric.append(element(document, "strong", `${formatRunTime(daily.accounted)} of ${formatRunTime(daily.quota)}`));
  metrics.append(actualMetric);

  const forecastMetric = element(document, "div", undefined, "browser-usage-forecast__metric");
  forecastMetric.append(element(document, "span", "Forecast at current schedules"));
  const forecastTotal = element(document, "strong",
    forecast.total_estimated_ms === null ? "Waiting for runtime samples" : `${formatRunTime(forecast.total_estimated_ms)} / day`);
  forecastTotal.dataset.testid = "forecast-total";
  forecastMetric.append(forecastTotal);
  metrics.append(forecastMetric);
  section.append(metrics);

  const figure = element(document, "figure", undefined, "browser-usage-chart");
  figure.setAttribute("aria-label", "Daily Browser Run usage forecast");
  figure.append(element(document, "figcaption", "Daily Browser Run time", "browser-usage-chart__caption"));
  figure.append(chartRow(document, "Used today", daily.accounted, scaleMs, markers));
  figure.append(chartRow(
    document,
    forecast.total_estimated_ms === null ? "Known forecast portion" : "Forecast per day",
    forecastDisplayMs,
    scaleMs,
    markers,
    forecast.sites.map((site) => ({
      capture_id: site.capture_id,
      value_ms: site.estimated_browser_ms_per_day ?? 0,
    })),
  ));

  const axis = element(document, "div", undefined, "browser-usage-chart__axis");
  axis.append(element(document, "span", "0"));
  axis.append(element(document, "span", `Scale: ${formatRunTime(scaleMs)}`));
  figure.append(axis);
  section.append(figure);

  const legend = element(document, "ul", undefined, "browser-usage-forecast__legend");
  legend.append(element(document, "li", `Ribbonfish budget · ${formatRunTime(daily.budget)}`, "browser-usage-forecast__legend-item browser-usage-forecast__legend-item--worker"));
  legend.append(element(document, "li", `Cloudflare Free plan · ${formatRunTime(daily.quota)}`, "browser-usage-forecast__legend-item browser-usage-forecast__legend-item--free"));
  section.append(legend);

  const note = forecast.is_complete
    ? "Forecast uses recent successful capture runtimes and counts reviewed sites in the active playlist. Reserve-estimated runtimes may make it conservative."
    : "Forecast unavailable until at least one active capture completes. New sites use the active sites' measured average when one is available.";
  section.append(element(document, "p", note, "browser-usage-forecast__note"));
  section.append(element(document, "p",
    "The 10-minute Cloudflare account-wide allowance can also be used by other Browser Run workloads, which are not included in this Ribbonfish estimate.",
    "browser-usage-forecast__note"));

  if (forecast.sites.length) {
    const list = element(document, "ul", undefined, "browser-usage-forecast__sites");
    forecast.sites.forEach((site, index) => {
      const item = element(document, "li", undefined, "browser-usage-forecast__site");
      item.append(element(document, "span", undefined,
        `browser-usage-forecast__site-swatch browser-usage-chart__segment--${index % 6}`));
      item.append(element(document, "strong", site.display_label));
      const runtime = site.average_browser_ms === null ? "runtime sample needed" : `${formatRunTime(site.average_browser_ms)} per capture`;
      const dailyCost = site.estimated_browser_ms_per_day === null ? "daily estimate unavailable" : `${formatRunTime(site.estimated_browser_ms_per_day)} / day`;
      const provenance = site.runtime_source === "fleet-history"
        ? "fleet average"
        : site.runtime_source === "site-history" ? `${site.browser_ms_samples} site samples` : "no runtime history";
      item.append(element(document, "span",
        `${formatCaptureInterval(site.interval_seconds ?? 0)} · ${site.captures_per_day?.toFixed(1) ?? "—"} captures/day · ${runtime} · ${dailyCost} · ${provenance}`));
      list.append(item);
    });
    section.append(list);
  }

  container.replaceChildren(section);
  return forecast;
}
