import {
  calculateDailyCaptureForecast,
  type CaptureForecastTarget,
} from "../../src/capture-forecast.ts";
import { formatRunTime } from "./capture-presentation.ts";
import { node, scaleMeter, type ScaleMeterMarker } from "./ui-primitives.ts";

export interface DailyCaptureUsage {
  accounted_ms: number;
  budget_ms: number;
  free_plan_limit_ms: number;
}

function safeMilliseconds(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function chartRow(
  document: Document,
  label: string,
  valueMs: number,
  scaleMs: number,
  markers: Array<{ value: number; kind: string; label: string }>,
  siteSegments?: Array<{ capture_id: string; value_ms: number }>,
  valueTestID?: string,
) {
  const row = node("div", undefined, "browser-usage-chart__row", document);
  const meterMarkers: ScaleMeterMarker[] = markers.map(({ value, kind, label: markerLabel }) => ({
    label: markerLabel,
    value,
    valueLabel: markerLabel.split(": ").at(-1) ?? "",
    tone: kind === "worker-budget" ? "worker-budget" as const : "free-plan" as const,
    className: "browser-usage-chart__marker browser-usage-chart__marker--" + kind,
    quotaMarker: kind,
  }));
  const meter = scaleMeter({
    label,
    value: valueMs,
    valueLabel: formatRunTime(valueMs),
    max: scaleMs,
    maxLabel: formatRunTime(scaleMs),
    fillTone: siteSegments ? "forecast" : "brand",
    markers: meterMarkers,
    segments: siteSegments?.map((site, index) => ({
      value: site.value_ms,
      captureId: site.capture_id,
      className: "browser-usage-chart__segment--" + (index % 6),
    })),
    ownerDocument: document,
    captionClassName: "browser-usage-chart__heading",
    trackClassName: "browser-usage-chart__track",
    fillClassName: "browser-usage-chart__bar browser-usage-chart__bar--actual",
  });
  const axis = node("div", undefined, "browser-usage-chart__axis", document);
  axis.append(
    node("span", "0", undefined, document),
    node("span", "Scale: " + formatRunTime(scaleMs), undefined, document),
  );
  if (valueTestID) {
    const value = meter.querySelector<HTMLElement>(".scale-meter__value");
    if (value) value.dataset.testid = valueTestID;
  }
  row.append(meter, axis);
  return row;
}

function forecastBudgetNote(forecast: ReturnType<typeof calculateDailyCaptureForecast>, budgetMs: number) {
  const budget = formatRunTime(budgetMs);
  if (!forecast.sites.length) {
    return `No reviewed screenshot sites are active in the playlist, so there is no schedule forecast to compare with the Ribbonfish daily budget of ${budget}.`;
  }
  if (!forecast.is_complete) {
    const sitesNeedingSamples = forecast.sites.filter((site) => site.estimated_browser_ms_per_day === null).length;
    return `The current schedule forecast is incomplete: ${formatRunTime(forecast.known_estimated_ms)} is estimated so far, and ${sitesNeedingSamples} active ${sitesNeedingSamples === 1 ? "site still needs" : "sites still need"} a runtime sample. We cannot confirm whether it will stay within the Ribbonfish daily budget of ${budget}.`;
  }
  const total = forecast.total_estimated_ms ?? 0;
  if (total <= budgetMs) {
    return `Current schedules are forecast to stay within the Ribbonfish daily budget of ${budget} (estimated use: ${formatRunTime(total)} per day).`;
  }
  return `Current schedules are forecast to exceed the Ribbonfish daily budget of ${budget} by ${formatRunTime(total - budgetMs)} (estimated use: ${formatRunTime(total)} per day).`;
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
  const usageScaleMs = Math.max(1000, Math.ceil(Math.max(daily.quota, daily.budget) * 1.1));
  const forecastScaleMs = Math.max(daily.quota, daily.budget, daily.accounted, forecastDisplayMs, 1000);
  const markers = [
    { value: daily.budget, kind: "worker-budget", label: "Ribbonfish capture budget: " + formatRunTime(daily.budget) },
    { value: daily.quota, kind: "free-plan", label: "Cloudflare Free allowance: " + formatRunTime(daily.quota) },
  ];

  const section = node("section", undefined, "browser-usage-forecast", document);
  section.setAttribute("aria-label", "Browser Run usage forecast");
  const summary = node("div", undefined, "capture-efficiency-summary", document);
  summary.append(node(
    "h3",
    `${formatRunTime(daily.accounted)} of ${formatRunTime(daily.quota)} Browser Run minutes used today`,
    undefined,
    document,
  ));
  summary.append(node("p", forecastBudgetNote(forecast, daily.budget), "browser-usage-budget-note", document));
  section.append(summary);

  const figure = node("figure", undefined, "browser-usage-chart", document);
  figure.setAttribute("aria-label", "Daily Browser Run usage forecast");
  figure.append(node("figcaption", "Daily Browser Run time", "browser-usage-chart__caption", document));
  figure.append(chartRow(document, "Used today", daily.accounted, usageScaleMs, markers));
  figure.append(chartRow(
    document,
    !forecast.sites.length
      ? "No reviewed active sites"
      : forecast.total_estimated_ms === null ? "Known forecast portion" : "Forecast per day",
    forecastDisplayMs,
    forecastScaleMs,
    markers,
    forecast.sites.map((site) => ({
      capture_id: site.capture_id,
      value_ms: site.estimated_browser_ms_per_day ?? 0,
    })),
    "forecast-total",
  ));
  section.append(figure);

  const legend = node("ul", undefined, "browser-usage-forecast__legend", document);
  legend.append(node("li", "Ribbonfish budget · " + formatRunTime(daily.budget),
    "browser-usage-forecast__legend-item browser-usage-forecast__legend-item--worker", document));
  legend.append(node("li", "Cloudflare Free plan · " + formatRunTime(daily.quota),
    "browser-usage-forecast__legend-item browser-usage-forecast__legend-item--free", document));
  section.append(legend);

  if (forecast.sites.length) {
    const note = forecast.is_complete
      ? "Forecast uses recent successful capture runtimes for reviewed sites in the active playlist. Reserve-estimated runtimes may make it conservative."
      : "Forecasts need a runtime sample from an active capture. New sites use the active sites' measured average when one is available.";
    section.append(node("p", note, "browser-usage-forecast__note", document));
  }
  section.append(node("p",
    "The 10-minute Cloudflare account-wide allowance can also be used by other Browser Run workloads, which are not included in this Ribbonfish estimate.",
    "browser-usage-forecast__note", document));

  container.replaceChildren(section);
  return forecast;
}
