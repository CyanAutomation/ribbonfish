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

async function requestJSON(url: URL, fetcher: typeof fetch, previousCache: EndpointCacheMetadata | undefined, started: number, telemetry: FetchTelemetry): Promise<Response> {
  telemetry.requestCount += 1;
  try {
    return await fetcher(url, { method: "GET", redirect: "manual", headers: validatorHeaders(previousCache), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch { noteRequest(telemetry, started, undefined, 0, true); throw new StatusApiError("Status API request failed or timed out.", true); }
}

function notModifiedJSON(response: Response, previousCache: EndpointCacheMetadata | undefined, now: string, started: number, telemetry: FetchTelemetry): JSONResponse {
  noteRequest(telemetry, started, 304);
  const cacheControl = response.headers.get("Cache-Control") ?? previousCache?.cacheControl;
  const noStore = /(?:^|,)\s*no-store\b/i.test(cacheControl ?? "");
  const hasValidator = Boolean(previousCache?.etag || previousCache?.lastModified);
  const cache = previousCache && hasValidator && !noStore ? {
    ...previousCache,
    ...(!noStore && response.headers.get("ETag") ? { etag: response.headers.get("ETag")! } : {}),
    ...(!noStore && response.headers.get("Last-Modified") ? { lastModified: response.headers.get("Last-Modified")! } : {}),
    ...(cacheControl ? { cacheControl } : {}),
    revalidatedAt: now,
  } : null;
  return { value: null, notModified: true, status: 304, cache };
}

function validateJSONResponse(response: Response, started: number, telemetry: FetchTelemetry): void {
  const type = response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase();
  if (type !== "application/json" && !type?.endsWith("+json")) {
    noteRequest(telemetry, started, response.status, 0, true);
    throw new StatusApiError("Status API returned a non-JSON response.");
  }
  const length = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    noteRequest(telemetry, started, response.status, length, true);
    throw new StatusApiError("Status API response is too large.");
  }
  if (!response.body) {
    noteRequest(telemetry, started, response.status, 0, true);
    throw new StatusApiError("Status API returned an empty response.");
  }
}

async function readJSONResponseBody(response: Response, started: number, telemetry: FetchTelemetry): Promise<Uint8Array> {
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new StatusApiError("Status API response is too large.");
      }
      chunks.push(item.value);
    }
  } catch (error) {
    noteRequest(telemetry, started, response.status, size, true);
    if (error instanceof StatusApiError) throw error;
    throw new StatusApiError("Status API request failed or timed out.", true);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseJSONResponse(response: Response, bytes: Uint8Array, now: string, started: number, telemetry: FetchTelemetry): JSONResponse {
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    noteRequest(telemetry, started, response.status, bytes.byteLength);
    return { value, notModified: false, status: response.status, cache: freshCache(response, now) };
  } catch (error) {
    noteRequest(telemetry, started, response.status, bytes.byteLength, true);
    if (error instanceof StatusApiError) throw error;
    throw new Error("Status API returned malformed JSON.");
  }
}

async function getJSON(url: URL, fetcher: typeof fetch, previousCache: EndpointCacheMetadata | undefined, now: string, telemetry: FetchTelemetry): Promise<JSONResponse> {
  const started = performance.now();
  const response = await requestJSON(url, fetcher, previousCache, started, telemetry);
  if (response.status === 304) {
    return notModifiedJSON(response, previousCache, now, started, telemetry);
  }
  if (response.status >= 300 && response.status < 400) { noteRequest(telemetry, started, response.status, 0, true); throw new StatusApiError("Status API redirects are not followed."); }
  if (!response.ok) { noteRequest(telemetry, started, response.status); throw new StatusApiError(`Status API returned HTTP ${response.status}.`, response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500); }
  validateJSONResponse(response, started, telemetry);
  const bytes = await readJSONResponseBody(response, started, telemetry);
  return parseJSONResponse(response, bytes, now, started, telemetry);
}

function incidentList(values: unknown): DashboardIncident[] {
  if (!Array.isArray(values)) return [];
  return values.slice(0, 30).map((value, index) => {
    const row = record(value);
    return { id: safeText(row.id, `incident-${index}`, 100), name: safeText(row.name ?? row.title, "Untitled event"),
      status: safeText(row.status, "unknown", 40), impact: safeText(row.impact, "unknown", 40),
      updatedAt: parseTimestamp(row.updated_at ?? row.updatedAt), scheduledFor: parseTimestamp(row.scheduled_for) };
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

type SourceFetchContext = {
  config: SourceConfig;
  base: URL;
  key: string;
  fetchedAt: string;
  requestStats: FetchTelemetry;
  fetcher: typeof fetch;
  now: Date;
  previous?: DashboardSource;
  sameSource: boolean;
};
type FreshSourceData = Pick<DashboardSource, "status" | "statusDescription" | "components" | "incidents" | "maintenance"> &
  Partial<Pick<DashboardSource, "freshness" | "cache" | "groups" | "etag">>;

function freshSource(context: SourceFetchContext, data: FreshSourceData): DashboardSource {
  return {
    id: context.config.id,
    provider: context.config.provider,
    displayName: safeText(context.config.display_name),
    hostname: context.config.hostname,
    sourceKey: context.key,
    fetchedAt: context.fetchedAt,
    freshness: "fresh",
    requestStats: context.requestStats,
    ...data,
    ...(context.config.provider === "atlassian-statuspage" && data.cache?.summary?.etag
      ? { etag: data.cache.summary.etag }
      : {}),
  };
}

function hasCachedSource(previous: DashboardSource | undefined, cache: EndpointCacheMetadata | undefined): boolean {
  return Boolean(cache?.contentFetchedAt && Array.isArray(previous?.components));
}

function validateKumaStatusPage(value: unknown): Record<string, any> {
  const statusData = record(value);
  const pageConfig = record(statusData.config);
  const invalidConfig = Object.keys(pageConfig).length === 0 && statusData.config !== undefined &&
    (statusData.config === null || typeof statusData.config !== "object");
  if (!Array.isArray(statusData.publicGroupList) || !Object.hasOwn(statusData, "config") || invalidConfig) {
    throw new Error("Uptime Kuma status-page response has an unexpected schema.");
  }
  if (pageConfig.published === false) throw new Error("Status page is not published.");
  if (statusData.publicGroupList.length > MAX_GROUPS) throw new Error("Status page exceeds the group limit.");
  return statusData;
}

function orderedKumaGroups(statusData: Record<string, any>) {
  return statusData.publicGroupList.map((value: unknown, index: number) => ({ value: record(value), index }))
    .sort((a: any, b: any) => Number(a.value.weight ?? a.index) - Number(b.value.weight ?? b.index));
}

function normalizeKumaGroups(groups: Array<{ value: Record<string, any>; index: number }>): DashboardGroup[] {
  return groups.map(({ value }, order) => ({
    id: String(value.id ?? "").slice(0, 100), name: safeText(value.name, "Unassigned group"), order,
  }));
}

function kumaMonitorDefinitions(groups: Array<{ value: Record<string, any>; index: number }>): DashboardComponent[] {
  const definitions: DashboardComponent[] = [];
  for (const [groupOrder, { value: group }] of groups.entries()) {
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
  return definitions;
}

function kumaDefinitions(response: JSONResponse, previous?: DashboardSource): { definitions: DashboardComponent[]; groups: DashboardGroup[] } {
  if (response.notModified) {
    return {
      definitions: (previous?.components ?? []).map((component) => ({ ...component })),
      groups: previous?.groups ?? [],
    };
  }
  const statusData = validateKumaStatusPage(response.value);
  const groups = orderedKumaGroups(statusData);
  return { definitions: kumaMonitorDefinitions(groups), groups: normalizeKumaGroups(groups) };
}

function kumaHeartbeatMap(response: JSONResponse, previous?: DashboardSource): Record<string, any> {
  if (response.notModified) return Object.fromEntries((previous?.components ?? []).map((component) => [component.id, component]));
  const heartbeatData = record(response.value);
  if (!heartbeatData.heartbeatList || typeof heartbeatData.heartbeatList !== "object" || Array.isArray(heartbeatData.heartbeatList)) {
    throw new Error("Uptime Kuma heartbeat response has an unexpected schema.");
  }
  return record(heartbeatData.heartbeatList);
}

function assertKumaHeartbeatLimit(heartbeatMap: Record<string, any>): void {
  const count = Object.values(heartbeatMap).reduce((sum, value) => sum + (Array.isArray(value) ? value.length : 0), 0);
  if (count > MAX_HEARTBEAT_RECORDS) {
    throw new Error(`Kuma status page returned ${count.toLocaleString("en-US")} heartbeat records; dashboard limit is ${MAX_HEARTBEAT_RECORDS.toLocaleString("en-US")}. Reduce monitor history or count.`);
  }
}

function cachedKumaComponent(definition: DashboardComponent, previousByID: Map<string, DashboardComponent>): DashboardComponent {
  const saved = previousByID.get(definition.id);
  return { ...definition, ...(saved ? { status: saved.status, sampledAt: saved.sampledAt,
    ...(saved.statusChangedAt ? { statusChangedAt: saved.statusChangedAt } : {}), ...(saved.history ? { history: saved.history } : {}),
    ...(saved.latencyMs !== undefined ? { latencyMs: saved.latencyMs } : {}) } : {}) };
}

function kumaHeartbeatRecords(values: unknown): Array<{ beat: Record<string, any>; at: string }> {
  return (Array.isArray(values) ? values : [])
    .map(record).map((beat: any) => ({ beat, at: parseTimestamp(beat.time) }))
    .filter((item): item is { beat: Record<string, any>; at: string } => item.at !== null)
    .sort((a: any, b: any) => Date.parse(a.at) - Date.parse(b.at));
}

function kumaStatusChangedAt(records: Array<{ beat: Record<string, any>; at: string }>, latestStatus: string | undefined) {
  let currentRunStart = records.length - 1;
  while (currentRunStart > 0 && kumaHealth(records[currentRunStart - 1].beat.status) === latestStatus) currentRunStart -= 1;
  return currentRunStart > 0 ? records[currentRunStart].at : undefined;
}

function kumaHeartbeatHistory(records: Array<{ beat: Record<string, any>; at: string }>) {
  return records.map((item) => ({ at: item.at, status: kumaHealth(item.beat.status) }));
}

function freshKumaComponent(definition: DashboardComponent, heartbeatMap: Record<string, any>): DashboardComponent {
  const records = kumaHeartbeatRecords(heartbeatMap[definition.id]);
  const latest = records.at(-1);
  const latestStatus = latest ? kumaHealth(latest.beat.status) : undefined;
  const statusChangedAt = kumaStatusChangedAt(records, latestStatus);
  const history = kumaHeartbeatHistory(records);
  const ping = latest?.beat.ping;
  return { ...definition, status: latest ? latestStatus! : "unknown",
    ...(typeof ping === "number" && Number.isFinite(ping) && ping >= 0 && ping <= 600_000 ? { latencyMs: ping } : {}),
    sampledAt: latest?.at ?? null,
    ...(statusChangedAt ? { statusChangedAt } : {}),
    ...(history.length ? { history } : {}) };
}

function kumaComponent(
  definition: DashboardComponent,
  heartbeatMap: Record<string, any>,
  heartbeatNotModified: boolean,
  previousByID: Map<string, DashboardComponent>,
): DashboardComponent {
  return heartbeatNotModified
    ? cachedKumaComponent(definition, previousByID)
    : freshKumaComponent(definition, heartbeatMap);
}

function kumaHealthStatus(components: DashboardComponent[]): DashboardSource["status"] {
  const states = components.filter((component) => !component.isGroup).map((component) => component.status);
  if (states.includes("down")) return "down";
  if (states.includes("degraded")) return "degraded";
  if (states.includes("maintenance")) return "maintenance";
  if (states.includes("pending")) return "pending";
  return states.length && states.every((state) => state === "operational") ? "operational" : "unknown";
}

function markStaleKumaHeartbeats(components: DashboardComponent[], now: Date): { components: DashboardComponent[]; stale: boolean } {
  const isStale = (component: DashboardComponent) => Boolean(component.sampledAt && now.getTime() - Date.parse(component.sampledAt) > 15 * 60_000);
  const stale = components.some(isStale);
  return { components: stale ? components.map((component) => isStale(component) ? { ...component, status: "stale" } : component) : components, stale };
}

async function fetchKumaResponses(context: SourceFetchContext): Promise<{ statusResponse: JSONResponse; heartbeatResponse: JSONResponse }> {
  const { config, base, fetchedAt, fetcher, requestStats, previous, sameSource } = context;
  const slug = encodeURIComponent(config.slug!);
  const cachedPage = sameSource ? previous?.cache?.statusPage : undefined;
  const cachedHeartbeat = sameSource ? previous?.cache?.heartbeat : undefined;
  const [statusResponse, heartbeatResponse] = await Promise.all([
    getJSON(new URL(`/api/status-page/${slug}`, base), fetcher, cachedPage, fetchedAt, requestStats),
    getJSON(new URL(`/api/status-page/heartbeat/${slug}`, base), fetcher, cachedHeartbeat, fetchedAt, requestStats),
  ]);
  if (statusResponse.notModified && (!statusResponse.cache || !hasCachedSource(previous, cachedPage))) {
    throw new Error("Uptime Kuma status-page endpoint returned 304 without cached configuration.");
  }
  if (heartbeatResponse.notModified && (!heartbeatResponse.cache || !hasCachedSource(previous, cachedHeartbeat))) {
    throw new Error("Uptime Kuma heartbeat endpoint returned 304 without cached heartbeat data.");
  }
  return { statusResponse, heartbeatResponse };
}

async function fetchKumaSource(context: SourceFetchContext): Promise<DashboardSource> {
  const { previous, now } = context;
  const { statusResponse, heartbeatResponse } = await fetchKumaResponses(context);
  const normalized = kumaDefinitions(statusResponse, previous);
  const heartbeatMap = kumaHeartbeatMap(heartbeatResponse, previous);
  assertKumaHeartbeatLimit(heartbeatMap);
  const previousByID = new Map((previous?.components ?? []).map((component) => [component.id, component]));
  const components = normalized.definitions.map((definition) => kumaComponent(definition, heartbeatMap, heartbeatResponse.notModified, previousByID));
  const aged = markStaleKumaHeartbeats(components, now);
  const statusData = statusResponse.notModified ? null : record(statusResponse.value);
  return freshSource(context, {
    freshness: aged.stale ? "stale" : "fresh",
    status: aged.stale ? "stale" : kumaHealthStatus(components),
    statusDescription: "Latest monitor heartbeats",
    cache: { statusPage: statusResponse.cache ?? undefined, heartbeat: heartbeatResponse.cache ?? undefined },
    components: aged.components,
    groups: normalized.groups,
    incidents: statusResponse.notModified ? previous?.incidents ?? [] : incidentList(statusData?.incidents),
    maintenance: statusResponse.notModified ? previous?.maintenance ?? [] : incidentList(statusData?.maintenanceList),
  });
}

function statuspageSummaryData(value: any): Omit<FreshSourceData, "freshness" | "cache" | "etag"> {
  if (!Array.isArray(value?.components) || value.components.length > MAX_MONITORS) {
    throw new Error("Status API component list is missing or exceeds the limit.");
  }
  const raw = value.components.map(record);
  const groupNames = new Map(raw.filter((row: any) => row.group === true).map((row: any) => [String(row.id), safeText(row.name)]));
  const componentOrderById = new Map(raw.map((row: any, index: number) => [String(row.id), index]));
  const groupOrderById = new Map(raw.filter((row: any) => row.group === true).map((row: any, index: number) => [String(row.id), index]));
  const groups = raw.filter((row: any) => row.group === true).map((row: any, order: number) => ({ id: safeText(row.id, `group-${order}`, 100), name: safeText(row.name), order }));
  const components = raw.map((row: any, componentOrder: number) => ({ id: safeText(row.id, "unknown", 100), name: safeText(row.name),
    status: statuspageHealth(row.status), sampledAt: parseTimestamp(row.updated_at),
    groupId: typeof row.group_id === "string" ? row.group_id : null,
    groupName: typeof row.group_id === "string" ? groupNames.get(row.group_id) ?? null : null,
    groupOrder: typeof row.group_id === "string" ? groupOrderById.get(row.group_id) ?? componentOrderById.get(row.group_id) : componentOrder,
    componentOrder,
    ...(row.group === true ? { isGroup: true } : {}) }));
  return {
    groups,
    components,
    incidents: incidentList(value?.incidents),
    maintenance: incidentList(value?.scheduled_maintenances),
    status: statuspageHealth(value?.status?.indicator),
    statusDescription: safeText(value?.status?.description, "Status API summary"),
  };
}

function previousStatuspageCache(context: SourceFetchContext): EndpointCacheMetadata | undefined {
  const saved = context.sameSource ? context.previous?.cache?.summary : undefined;
  if (saved || !context.sameSource || !context.previous?.etag) return saved;
  return { etag: context.previous.etag, contentFetchedAt: context.previous.fetchedAt };
}

async function fetchStatuspageSource(context: SourceFetchContext): Promise<DashboardSource> {
  const previousCache = previousStatuspageCache(context);
  const response = await getJSON(new URL("/api/v2/summary.json", context.base), context.fetcher, previousCache, context.fetchedAt, context.requestStats);
  if (response.notModified) {
    if (!context.previous || !context.sameSource || !response.cache || !previousCache?.contentFetchedAt || !Array.isArray(context.previous.components)) {
      throw new Error("Status API returned 304 without a cached source.");
    }
    return {
      ...context.previous,
      displayName: context.config.display_name,
      sourceKey: context.key,
      fetchedAt: context.fetchedAt,
      requestStats: context.requestStats,
      cache: { summary: response.cache },
      etag: response.cache.etag ?? context.previous.etag,
    };
  }
  return freshSource(context, {
    ...statuspageSummaryData(response.value),
    cache: { summary: response.cache ?? undefined },
  });
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
    const context: SourceFetchContext = { config, base, key, fetchedAt, requestStats, fetcher, now, previous, sameSource };
    return config.provider === "uptime-kuma" ? await fetchKumaSource(context) : await fetchStatuspageSource(context);
  } catch (error) {
    return staleSource(config, fetchedAt, error, requestStats);
  }
}

export function validateSourceConfig(config: SourceConfig, allowlist: string) {
  allowedURL(config, allowlist);
}
