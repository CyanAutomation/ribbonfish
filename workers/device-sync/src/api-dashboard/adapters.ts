import type { SourceConfig } from "./config.ts";
import { sourceConfigErrors } from "./config.ts";
import { kumaHealth, parseTimestamp, statuspageHealth, type ApiSourceRequestStats, type DashboardComponent, type DashboardGroup, type DashboardIncident, type DashboardSource, type EndpointCacheMetadata, type Provider } from "./model.ts";

export type { SourceConfig } from "./config.ts";

const MAX_RESPONSE_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_MONITORS = 500;
const MAX_GROUPS = 40;
const MAX_HEARTBEAT_RECORDS = 8_000;

type FetchTelemetry = ApiSourceRequestStats;
type JSONResponse = { value: any; cache: EndpointCacheMetadata | null; notModified: boolean; status: number };

class StatusApiError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable = false) {
    super(message);
    this.name = "StatusApiError";
    this.retryable = retryable;
  }
}

function record(value: unknown): Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function safeText(value: unknown, fallback = "Unknown", max = 180): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : fallback;
}

function sourceKey(config: SourceConfig): string {
  return `${config.provider}|${config.hostname.toLowerCase()}|${config.provider === "uptime-kuma" ? config.slug ?? "" : ""}`;
}

function allowedURL(config: SourceConfig, allowlist: string): URL {
  const errors = sourceConfigErrors(config);
  if (errors.id) throw new Error("Invalid source ID.");
  if (errors.hostname) throw new Error("Status API hostname is invalid or uses a reserved suffix.");
  if (errors.display_name) throw new Error("Source display name must be between 1 and 100 characters.");
  if (errors.slug) throw new Error("Invalid status-page slug.");
  const hosts = new Set(allowlist.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean));
  const hostname = config.hostname.toLowerCase();
  if (hosts.size > 0 && !hosts.has(hostname)) throw new Error("Source hostname is not on the configured API status host allowlist.");
  return new URL(`https://${hostname}`);
}

function freshCache(response: Response, now: string): EndpointCacheMetadata {
  const cacheControl = response.headers.get("Cache-Control") ?? undefined;
  const noStore = /(?:^|,)\s*no-store\b/i.test(cacheControl ?? "");
  return {
    ...(!noStore && response.headers.get("ETag") ? { etag: response.headers.get("ETag")! } : {}),
    ...(!noStore && response.headers.get("Last-Modified") ? { lastModified: response.headers.get("Last-Modified")! } : {}),
    ...(cacheControl ? { cacheControl } : {}),
    contentFetchedAt: now,
  };
}

function validatorHeaders(cache?: EndpointCacheMetadata): HeadersInit {
  if (!cache || /(?:^|,)\s*no-store\b/i.test(cache.cacheControl ?? "")) return { Accept: "application/json" };
  return { Accept: "application/json", ...(cache.etag ? { "If-None-Match": cache.etag } : {}), ...(cache.lastModified ? { "If-Modified-Since": cache.lastModified } : {}) };
}

function noteRequest(telemetry: FetchTelemetry, started: number, status?: number, bytes = 0, failed = false): void {
  telemetry.durationMs += Math.max(0, Math.round(performance.now() - started));
  if (status !== undefined) {
    if (status === 304) telemetry.notModifiedCount += 1;
    else if (status >= 400) failed = true;
  }
  if (failed) telemetry.failedRequestCount += 1;
  telemetry.responseBytes += bytes;
}

async function getJSON(url: URL, fetcher: typeof fetch, previousCache: EndpointCacheMetadata | undefined, now: string, telemetry: FetchTelemetry): Promise<JSONResponse> {
  const started = performance.now();
  telemetry.requestCount += 1;
  let response: Response;
  try {
    response = await fetcher(url, { method: "GET", redirect: "manual", headers: validatorHeaders(previousCache), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch { noteRequest(telemetry, started, undefined, 0, true); throw new StatusApiError("Status API request failed or timed out.", true); }
  if (response.status === 304) {
    noteRequest(telemetry, started, 304);
    const cacheControl = response.headers.get("Cache-Control") ?? previousCache?.cacheControl;
    const noStore = /(?:^|,)\s*no-store\b/i.test(cacheControl ?? "");
    const hasValidator = Boolean(previousCache?.etag || previousCache?.lastModified);
    return { value: null, notModified: true, status: 304, cache: previousCache && hasValidator && !noStore ? {
      ...previousCache,
      ...(!noStore && response.headers.get("ETag") ? { etag: response.headers.get("ETag")! } : {}),
      ...(!noStore && response.headers.get("Last-Modified") ? { lastModified: response.headers.get("Last-Modified")! } : {}),
      ...(cacheControl ? { cacheControl } : {}),
      revalidatedAt: now,
    } : null };
  }
  if (response.status >= 300 && response.status < 400) { noteRequest(telemetry, started, response.status, 0, true); throw new StatusApiError("Status API redirects are not followed."); }
  if (!response.ok) { noteRequest(telemetry, started, response.status); throw new StatusApiError(`Status API returned HTTP ${response.status}.`, response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500); }
  const type = response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase();
  if (type !== "application/json" && !type?.endsWith("+json")) { noteRequest(telemetry, started, response.status, 0, true); throw new StatusApiError("Status API returned a non-JSON response."); }
  const length = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) { noteRequest(telemetry, started, response.status, length, true); throw new StatusApiError("Status API response is too large."); }
  if (!response.body) { noteRequest(telemetry, started, response.status, 0, true); throw new StatusApiError("Status API returned an empty response."); }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new StatusApiError("Status API response is too large."); }
      chunks.push(item.value);
    }
  } catch (error) {
    noteRequest(telemetry, started, response.status, size, true);
    if (error instanceof StatusApiError) throw error;
    throw new StatusApiError("Status API request failed or timed out.", true);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    noteRequest(telemetry, started, response.status, size);
    return { value, notModified: false, status: response.status, cache: freshCache(response, now) };
  } catch (error) {
    noteRequest(telemetry, started, response.status, size, true);
    if (error instanceof StatusApiError) throw error;
    throw new Error("Status API returned malformed JSON.");
  }
}

function incidentList(values: unknown): DashboardIncident[] {
  if (!Array.isArray(values)) return [];
  return values.slice(0, 30).map((value, index) => {
    const row = record(value);
    return { id: safeText(row.id, `incident-${index}`, 100), name: safeText(row.name ?? row.title, "Untitled event"),
      status: safeText(row.status, "unknown", 40), impact: safeText(row.impact, "unknown", 40),
      updatedAt: parseTimestamp(row.updated_at ?? row.updatedAt ?? row.scheduled_for) };
  });
}

function emptyRequestStats(): FetchTelemetry { return { requestCount: 0, notModifiedCount: 0, failedRequestCount: 0, responseBytes: 0, durationMs: 0 }; }

function staleSource(config: SourceConfig, fetchedAt: string, error: unknown, requestStats: FetchTelemetry): DashboardSource {
  return { id: config.id, provider: config.provider, displayName: config.display_name.slice(0, 100), fetchedAt,
    freshness: "unavailable", status: "stale", statusDescription: "Status source unavailable", components: [], incidents: [], maintenance: [],
    sourceKey: sourceKey(config), requestStats,
    ...(error instanceof StatusApiError && error.retryable ? { retryableError: true } : {}),
    error: error instanceof Error ? error.message.slice(0, 180) : "Status source unavailable." };
}

export async function fetchSource(config: SourceConfig, allowlist: string, fetcher: typeof fetch = fetch, now = new Date(), previous?: DashboardSource): Promise<DashboardSource> {
  const fetchedAt = now.toISOString();
  if (!config.enabled) return { id: config.id, provider: config.provider, displayName: config.display_name, fetchedAt, freshness: "unavailable", disabled: true, status: "unknown", statusDescription: "Source disabled", components: [], incidents: [], maintenance: [], requestStats: emptyRequestStats() };
  const requestStats = emptyRequestStats();
  try {
    const base = allowedURL(config, allowlist);
    const key = sourceKey(config);
    const sameSource = previous?.provider === config.provider && previous.hostname?.toLowerCase() === config.hostname.toLowerCase() &&
      (previous.sourceKey ? previous.sourceKey === key : config.provider === "atlassian-statuspage");
    let components: DashboardComponent[];
    let incidents: DashboardIncident[];
    let maintenance: DashboardIncident[];
    let freshness: DashboardSource["freshness"] = "fresh";
    let status: DashboardSource["status"] = "unknown";
    let statusDescription = "Status not provided";
    let cache: DashboardSource["cache"];
    let sourceGroups: DashboardGroup[] | undefined;
    if (config.provider === "uptime-kuma") {
      const slug = encodeURIComponent(config.slug!);
      const configURL = new URL(`/api/status-page/${slug}`, base);
      const heartbeatURL = new URL(`/api/status-page/heartbeat/${slug}`, base);
      const cachedPage = sameSource ? previous?.cache?.statusPage : undefined;
      const cachedHeartbeat = sameSource ? previous?.cache?.heartbeat : undefined;
      const [statusResponse, heartbeatResponse] = await Promise.all([
        getJSON(configURL, fetcher, cachedPage, fetchedAt, requestStats),
        getJSON(heartbeatURL, fetcher, cachedHeartbeat, fetchedAt, requestStats),
      ]);
      const previousHasPage = sameSource && Boolean(cachedPage?.contentFetchedAt) && Array.isArray(previous?.components);
      const previousHasHeartbeat = sameSource && Boolean(cachedHeartbeat?.contentFetchedAt) && Array.isArray(previous?.components);
      if (statusResponse.notModified && (!statusResponse.cache || !previousHasPage)) throw new Error("Uptime Kuma status-page endpoint returned 304 without cached configuration.");
      if (heartbeatResponse.notModified && (!heartbeatResponse.cache || !previousHasHeartbeat)) throw new Error("Uptime Kuma heartbeat endpoint returned 304 without cached heartbeat data.");

      let definitions: DashboardComponent[];
      if (statusResponse.notModified) {
        definitions = (previous?.components ?? []).map((component) => ({ ...component }));
        sourceGroups = previous?.groups ?? [];
      } else {
        const statusData = record(statusResponse.value);
        const pageConfig = record(statusData.config);
        if (!Array.isArray(statusData.publicGroupList) || !Object.hasOwn(statusData, "config") || (Object.keys(pageConfig).length === 0 && statusData.config !== undefined && (statusData.config === null || typeof statusData.config !== "object"))) throw new Error("Uptime Kuma status-page response has an unexpected schema.");
        if (pageConfig.published === false) throw new Error("Status page is not published.");
        if (statusData.publicGroupList.length > MAX_GROUPS) throw new Error("Status page exceeds the group limit.");
        definitions = [];
        const groups = statusData.publicGroupList.map((value: unknown, index: number) => ({ value: record(value), index }));
        const orderedGroups = groups.sort((a: any, b: any) => Number(a.value.weight ?? a.index) - Number(b.value.weight ?? b.index));
        sourceGroups = orderedGroups.map(({ value, index }: { value: Record<string, any>; index: number }, order: number) => ({
          id: String(value.id ?? "").slice(0, 100), name: safeText(value.name, "Unassigned group"), order,
        }));
        for (const [groupOrder, { value: group }] of orderedGroups.entries()) {
          const groupId = String(group.id ?? "").slice(0, 100);
          const groupName = safeText(group.name, "Unassigned group");
          const monitors = Array.isArray(group.monitorList) ? group.monitorList : [];
          for (const [componentOrder, monitorValue] of monitors.entries()) {
            if (definitions.length >= MAX_MONITORS) throw new Error("Status page exceeds the monitor limit.");
            const monitor = record(monitorValue);
            definitions.push({ id: String(monitor.id ?? `monitor-${definitions.length}`).slice(0, 100), name: safeText(monitor.name),
              status: "unknown", sampledAt: null, groupId: groupId || null, groupName, groupOrder, componentOrder });
          }
        }
      }

      let heartbeatMap: Record<string, any> = {};
      if (heartbeatResponse.notModified) {
        heartbeatMap = Object.fromEntries((previous?.components ?? []).map((component) => [component.id, component]));
      } else {
        const heartbeatData = record(heartbeatResponse.value);
        if (!heartbeatData.heartbeatList || typeof heartbeatData.heartbeatList !== "object" || Array.isArray(heartbeatData.heartbeatList)) throw new Error("Uptime Kuma heartbeat response has an unexpected schema.");
        heartbeatMap = record(heartbeatData.heartbeatList);
      }
      const heartbeatCount = Object.values(heartbeatMap).reduce((sum, value) => sum + (Array.isArray(value) ? value.length : 0), 0);
      if (heartbeatCount > MAX_HEARTBEAT_RECORDS) {
        throw new Error(`Kuma status page returned ${heartbeatCount.toLocaleString("en-US")} heartbeat records; dashboard limit is ${MAX_HEARTBEAT_RECORDS.toLocaleString("en-US")}. Reduce monitor history or count.`);
      }
      const priorByID = new Map((previous?.components ?? []).map((component) => [component.id, component]));
      components = definitions.map((definition) => {
        if (heartbeatResponse.notModified) {
          const saved = priorByID.get(definition.id);
          return { ...definition, ...(saved ? { status: saved.status, sampledAt: saved.sampledAt, ...(saved.latencyMs !== undefined ? { latencyMs: saved.latencyMs } : {}) } : {}) };
        }
        const history = Array.isArray(heartbeatMap[definition.id]) ? heartbeatMap[definition.id] : [];
        const latest = history.map(record).reduce((selected: any, beat: any) => {
          const timestamp = parseTimestamp(beat.time);
          return timestamp && (!selected || Date.parse(timestamp) > Date.parse(selected.time)) ? { ...beat, time: timestamp } : selected;
        }, null);
        return { ...definition, status: latest ? kumaHealth(latest.status) : "unknown",
          ...(typeof latest?.ping === "number" && Number.isFinite(latest.ping) && latest.ping >= 0 && latest.ping <= 600_000 ? { latencyMs: latest.ping } : {}),
          sampledAt: latest ? parseTimestamp(latest.time) : null };
      });
      const statusData = statusResponse.notModified ? null : record(statusResponse.value);
      incidents = statusResponse.notModified ? previous?.incidents ?? [] : incidentList(statusData?.incidents);
      maintenance = statusResponse.notModified ? previous?.maintenance ?? [] : incidentList(statusData?.maintenanceList);
      cache = { statusPage: statusResponse.cache ?? undefined, heartbeat: heartbeatResponse.cache ?? undefined };
      const heartbeatStale = components.some((component) => component.sampledAt && now.getTime() - Date.parse(component.sampledAt) > 15 * 60_000);
      if (heartbeatStale) {
        components = components.map((component) => component.sampledAt && now.getTime() - Date.parse(component.sampledAt) > 15 * 60_000 ? { ...component, status: "stale" } : component);
      }
      const states = components.filter((component) => !component.isGroup).map((component) => component.status);
      status = states.includes("down") ? "down" : states.includes("degraded") ? "degraded" : heartbeatStale ? "stale" : states.includes("maintenance") ? "maintenance" : states.includes("pending") ? "pending" : states.length && states.every((state) => state === "operational") ? "operational" : "unknown";
      statusDescription = "Latest monitor heartbeats";
      if (heartbeatStale) freshness = "stale";
    } else {
      const url = new URL("/api/v2/summary.json", base);
      let previousCache = sameSource ? previous?.cache?.summary : undefined;
      if (sameSource && !previousCache && previous?.etag) previousCache = { etag: previous.etag, contentFetchedAt: previous.fetchedAt };
      const response = await getJSON(url, fetcher, previousCache, fetchedAt, requestStats);
      if (response.notModified) {
        if (!previous || !sameSource || !response.cache || !previousCache?.contentFetchedAt || !Array.isArray(previous.components)) throw new Error("Status API returned 304 without a cached source.");
        requestStats.durationMs = Math.max(0, requestStats.durationMs);
        return { ...previous, displayName: config.display_name, sourceKey: key, fetchedAt, requestStats, cache: { summary: response.cache }, etag: response.cache.etag ?? previous.etag };
      }
      const data = response.value;
      if (!Array.isArray(data?.components) || data.components.length > MAX_MONITORS) throw new Error("Status API component list is missing or exceeds the limit.");
      const raw = data.components.map(record);
      const groupNames = new Map(raw.filter((row: any) => row.group === true).map((row: any) => [String(row.id), safeText(row.name)]));
      const componentOrderById = new Map(raw.map((row: any, index: number) => [String(row.id), index]));
      const groupOrderById = new Map(raw.filter((row: any) => row.group === true).map((row: any, index: number) => [String(row.id), index]));
      sourceGroups = raw.filter((row: any) => row.group === true).map((row: any, order: number) => ({ id: safeText(row.id, `group-${order}`, 100), name: safeText(row.name), order }));
      components = raw.map((row: any, componentOrder: number) => ({ id: safeText(row.id, "unknown", 100), name: safeText(row.name),
        status: statuspageHealth(row.status), sampledAt: parseTimestamp(row.updated_at),
        groupId: typeof row.group_id === "string" ? row.group_id : null,
        groupName: typeof row.group_id === "string" ? groupNames.get(row.group_id) ?? null : null,
        groupOrder: typeof row.group_id === "string" ? groupOrderById.get(row.group_id) ?? componentOrderById.get(row.group_id) : componentOrder,
        componentOrder,
        ...(row.group === true ? { isGroup: true } : {}) }));
      incidents = incidentList(data?.incidents);
      maintenance = incidentList(data?.scheduled_maintenances);
      status = statuspageHealth(data?.status?.indicator);
      statusDescription = safeText(data?.status?.description, "Status API summary");
      cache = { summary: response.cache ?? undefined };
    }
    const source: DashboardSource = { id: config.id, provider: config.provider, displayName: safeText(config.display_name), hostname: config.hostname, sourceKey: sourceKey(config), fetchedAt,
      freshness, status, statusDescription, ...(cache ? { cache } : {}), ...(config.provider === "atlassian-statuspage" && cache?.summary?.etag ? { etag: cache.summary.etag } : {}),
      requestStats, components, ...(sourceGroups ? { groups: sourceGroups } : {}), incidents, maintenance };
    return source;
  } catch (error) { return staleSource(config, fetchedAt, error, requestStats); }
}

export function providerOf(value: unknown): value is Provider {
  return value === "uptime-kuma" || value === "atlassian-statuspage";
}

export function validateSourceConfig(config: SourceConfig, allowlist: string) {
  allowedURL(config, allowlist);
}
