import { fetchSource, providerOf, type SourceConfig } from "./adapters.ts";
import type { DashboardSource } from "./model.ts";
import { renderDashboardPNG } from "./render.ts";

export const DEFAULT_API_DASHBOARD_INTERVAL = 300;
export const MAX_API_DASHBOARD_SOURCES = 30;
export const MAX_API_DASHBOARD_COMPONENTS = 2_000;
export const API_SOURCE_MAX_AGE_MS = 15 * 60_000;

export type ApiDashboardConfig = { sources: SourceConfig[]; width: number; height: number };

export function parseApiDashboardConfig(value: unknown): ApiDashboardConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Dashboard configuration must be an object.");
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.sources) || input.sources.length < 1 || input.sources.length > MAX_API_DASHBOARD_SOURCES) throw new Error("Dashboard must have between 1 and 30 sources.");
  const sources = input.sources.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid dashboard source.");
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || !providerOf(row.provider) || typeof row.display_name !== "string" || typeof row.hostname !== "string" || typeof row.enabled !== "boolean") throw new Error("Dashboard source requires a valid provider, id, display_name, hostname, and enabled.");
    return { id: row.id, provider: row.provider, display_name: row.display_name, hostname: row.hostname, enabled: row.enabled, ...(typeof row.slug === "string" ? { slug: row.slug } : {}) } as SourceConfig;
  });
  if (new Set(sources.map((source) => source.id)).size !== sources.length) throw new Error("Dashboard source IDs must be unique.");
  const width = input.width ?? 1920;
  const height = input.height ?? 1080;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || Number(width) < 640 || Number(width) > 3840 || Number(height) < 360 || Number(height) > 2160 || Number(width) * Number(height) > 3840 * 2160) throw new Error("Dashboard resolution is outside the supported range.");
  return { sources, width: Number(width), height: Number(height) };
}

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
