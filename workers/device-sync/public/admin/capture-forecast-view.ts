import {
  calculateDailyCaptureForecast,
  type CaptureForecastTarget,
} from "../../src/capture-forecast.ts";
import { formatRunTime } from "./capture-presentation.ts";
import { metricCard, node, scaleMeter, type ScaleMeterMarker } from "./ui-primitives.ts";
import { formatCaptureInterval } from "./ui-utils.ts";

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
) {
  const meterMarkers: ScaleMeterMarker[] = markers.map(({ value, kind, label: markerLabel }) => ({
    label: markerLabel,
    value,
    valueLabel: markerLabel.split(": ").at(-1) ?? "",
    tone: kind === "worker-budget" ? "worker-budget" as const : "free-plan" as const,
    className: "browser-usage-chart__marker browser-usage-chart__marker--" + kind,
    quotaMarker: kind,
  }));
  return scaleMeter({
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
    className: "browser-usage-chart__row",
    captionClassName: "browser-usage-chart__heading",
    trackClassName: "browser-usage-chart__track",
    fillClassName: "browser-usage-chart__bar browser-usage-chart__bar--actual",
  });
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
    { value: daily.budget, kind: "worker-budget", label: "Ribbonfish capture budget: " + formatRunTime(daily.budget) },
    { value: daily.quota, kind: "free-plan", label: "Cloudflare Free allowance: " + formatRunTime(daily.quota) },
  ];

  const section = node("section", undefined, "browser-usage-forecast", document);
  section.setAttribute("aria-label", "Browser Run usage forecast");
  const metrics = node("div", undefined, "browser-usage-forecast__metrics", document);
  metrics.append(metricCard(
    "Ribbonfish used today",
    formatRunTime(daily.accounted) + " of " + formatRunTime(daily.quota),
    undefined,
    document,
  ));

  const forecastMetric = metricCard(
    "Forecast at current schedules",
    forecast.total_estimated_ms === null
      ? "Waiting for runtime samples"
      : formatRunTime(forecast.total_estimated_ms) + " / day",
    undefined,
    document,
  );
  const forecastTotal = forecastMetric.querySelector(".metric-card__value")!;
  forecastTotal.dataset.testid = "forecast-total";
  metrics.append(forecastMetric);
  section.append(metrics);

  const figure = node("figure", undefined, "browser-usage-chart", document);
  figure.setAttribute("aria-label", "Daily Browser Run usage forecast");
  figure.append(node("figcaption", "Daily Browser Run time", "browser-usage-chart__caption", document));
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

  const axis = node("div", undefined, "browser-usage-chart__axis", document);
  axis.append(node("span", "0", undefined, document));
  axis.append(node("span", "Scale: " + formatRunTime(scaleMs), undefined, document));
  figure.append(axis);
  section.append(figure);

  const legend = node("ul", undefined, "browser-usage-forecast__legend", document);
  legend.append(node("li", "Ribbonfish budget · " + formatRunTime(daily.budget),
    "browser-usage-forecast__legend-item browser-usage-forecast__legend-item--worker", document));
  legend.append(node("li", "Cloudflare Free plan · " + formatRunTime(daily.quota),
    "browser-usage-forecast__legend-item browser-usage-forecast__legend-item--free", document));
  section.append(legend);

  const note = forecast.is_complete
    ? "Forecast uses recent successful capture runtimes and counts reviewed sites in the active playlist. Reserve-estimated runtimes may make it conservative."
    : "Forecast unavailable until at least one active capture completes. New sites use the active sites' measured average when one is available.";
  section.append(node("p", note, "browser-usage-forecast__note", document));
  section.append(node("p",
    "The 10-minute Cloudflare account-wide allowance can also be used by other Browser Run workloads, which are not included in this Ribbonfish estimate.",
    "browser-usage-forecast__note", document));

  if (forecast.sites.length) {
    const list = node("ul", undefined, "browser-usage-forecast__sites", document);
    forecast.sites.forEach((site, index) => {
      const item = node("li", undefined, "browser-usage-forecast__site", document);
      item.append(node("span", undefined,
        "browser-usage-forecast__site-swatch browser-usage-chart__segment--" + (index % 6), document));
      item.append(node("strong", site.display_label, undefined, document));
      const runtime = site.average_browser_ms === null
        ? "runtime sample needed" : formatRunTime(site.average_browser_ms) + " per capture";
      const dailyCost = site.estimated_browser_ms_per_day === null
        ? "daily estimate unavailable" : formatRunTime(site.estimated_browser_ms_per_day) + " / day";
      const provenance = site.runtime_source === "fleet-history"
        ? "fleet average"
        : site.runtime_source === "site-history" ? site.browser_ms_samples + " site samples" : "no runtime history";
      item.append(node("span",
        formatCaptureInterval(site.interval_seconds ?? 0) + " · " +
        (site.captures_per_day?.toFixed(1) ?? "—") + " captures/day · " +
        runtime + " · " + dailyCost + " · " + provenance,
        undefined, document));
      list.append(item);
    });
    section.append(list);
  }

  container.replaceChildren(section);
  return forecast;
}
