import { fetchSource, type SourceConfig } from "./adapters.ts";
import type { DashboardSource } from "./model.ts";
import { renderDashboardPNG } from "./render.ts";
import { parseApiDashboardConfig, type ApiDashboardConfig } from "./config.ts";

export { DEFAULT_API_DASHBOARD_INTERVAL, MAX_API_DASHBOARD_SOURCES, parseApiDashboardConfig } from "./config.ts";
export type { ApiDashboardConfig } from "./config.ts";
export const MAX_API_DASHBOARD_COMPONENTS = 2_000;
export const API_SOURCE_MAX_AGE_MS = 15 * 60_000;

export async function loadDashboardSources(config: ApiDashboardConfig, allowedHosts: string, fetcher: typeof fetch = fetch, now = new Date(), previousSources: DashboardSource[] = []): Promise<DashboardSource[]> {
  const enabled = config.sources.filter((source) => source.enabled);
  const previous = new Map(previousSources.map((source) => [source.id, source]));
  const sources = [];
  for (let offset = 0; offset < enabled.length; offset += 4) {
    sources.push(...await Promise.all(enabled.slice(offset, offset + 4).map((source) => fetchSource(source, allowedHosts, fetcher, now, previous.get(source.id)))));
  }
  if (sources.reduce((sum, source) => sum + source.components.length, 0) > MAX_API_DASHBOARD_COMPONENTS) throw new Error("Dashboard exceeds the total component limit.");
  return sources;
}

export async function captureApiDashboard(configJson: string, allowedHosts: string, fetcher: typeof fetch = fetch, now = new Date()) {
  const config = parseApiDashboardConfig(JSON.parse(configJson));
  const fetchStarted = performance.now();
  const sources = await loadDashboardSources(config, allowedHosts, fetcher, now);
  const fetchDurationMs = Math.max(0, Math.round(performance.now() - fetchStarted));
  const available = sources.filter((source) => source.freshness === "fresh").length;
  if (available === 0) throw new Error("All dashboard sources are unavailable; no image was published.");
  const png = await renderDashboardPNG(sources, config.width, config.height);
  return { png, sources, fetchDurationMs, availableSources: available };
}
