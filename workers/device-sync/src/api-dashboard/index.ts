import { fetchSource, type SourceConfig } from "./adapters.ts";
import type { DashboardSource } from "./model.ts";
import { parseApiDashboardConfig, type ApiDashboardConfig } from "./config.ts";

export { parseApiDashboardConfig } from "./config.ts";
export type { ApiDashboardConfig } from "./config.ts";
const MAX_API_DASHBOARD_COMPONENTS = 2_000;

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
