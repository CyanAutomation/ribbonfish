import { kumaHealth, parseTimestamp, statuspageHealth, type DashboardComponent, type DashboardIncident, type DashboardSource, type Provider } from "./model.ts";

export type SourceConfig = {
  id: string;
  provider: Provider;
  display_name: string;
  enabled: boolean;
  hostname: string;
  slug?: string;
};

const MAX_RESPONSE_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_MONITORS = 500;
const MAX_GROUPS = 40;
const MAX_HEARTBEAT_RECORDS = 5_000;

function record(value: unknown): Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function safeText(value: unknown, fallback = "Unknown", max = 180): string {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : fallback;
}

function allowedURL(config: SourceConfig, allowlist: string): URL {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/.test(config.id)) throw new Error("Invalid source ID.");
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(config.hostname)) throw new Error("Invalid source hostname.");
  const hosts = new Set(allowlist.split(",").map((host) => host.trim().toLowerCase()).filter(Boolean));
  const hostname = config.hostname.toLowerCase();
  const blockedSuffixes = [".localhost", ".local", ".internal", ".test", ".invalid", ".onion", ".arpa"];
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname) || !hostname.includes(".") || hostname === "localhost" || blockedSuffixes.some((suffix) => hostname.endsWith(suffix))) throw new Error("Status API hostname must be a public DNS hostname.");
  if (hosts.size > 0 && !hosts.has(hostname)) throw new Error("Source hostname is not on the configured API status host allowlist.");
  if (config.provider === "uptime-kuma" && (!config.slug || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(config.slug))) throw new Error("Invalid status-page slug.");
  return new URL(`https://${hostname}`);
}

async function getJSON(url: URL, fetcher: typeof fetch, etag?: string): Promise<{ value: any; etag: string | null; notModified: boolean }> {
  let response: Response;
  try {
    response = await fetcher(url, { method: "GET", redirect: "manual", headers: { Accept: "application/json", ...(etag ? { "If-None-Match": etag } : {}) }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch { throw new Error("Status API request failed or timed out."); }
  if (response.status === 304) return { value: null, etag: response.headers.get("ETag") ?? etag ?? null, notModified: true };
  if (response.status >= 300 && response.status < 400) throw new Error("Status API redirects are not followed.");
  if (!response.ok) throw new Error(`Status API returned HTTP ${response.status}.`);
  const type = response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase();
  if (type !== "application/json" && !type?.endsWith("+json")) throw new Error("Status API returned a non-JSON response.");
  const length = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new Error("Status API response is too large.");
  if (!response.body) throw new Error("Status API returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    size += item.value.byteLength;
    if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error("Status API response is too large."); }
    chunks.push(item.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return { value: JSON.parse(new TextDecoder().decode(bytes)), etag: response.headers.get("ETag"), notModified: false }; }
  catch { throw new Error("Status API returned malformed JSON."); }
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

function staleSource(config: SourceConfig, fetchedAt: string, error: unknown): DashboardSource {
  return { id: config.id, provider: config.provider, displayName: config.display_name.slice(0, 100), fetchedAt,
    freshness: "unavailable", status: "stale", statusDescription: "Status source unavailable", components: [], incidents: [], maintenance: [],
    error: error instanceof Error ? error.message.slice(0, 180) : "Status source unavailable." };
}

export async function fetchSource(config: SourceConfig, allowlist: string, fetcher: typeof fetch = fetch, now = new Date(), previous?: DashboardSource): Promise<DashboardSource> {
  if (!config.enabled) return { id: config.id, provider: config.provider, displayName: config.display_name, fetchedAt: now.toISOString(), freshness: "unavailable", status: "stale", statusDescription: "Source disabled", components: [], incidents: [], maintenance: [], error: "Source is disabled." };
  try {
    const base = allowedURL(config, allowlist);
    let components: DashboardComponent[];
    let incidents: DashboardIncident[];
    let maintenance: DashboardIncident[];
    let freshness: DashboardSource["freshness"] = "fresh";
    let status: DashboardSource["status"] = "unknown";
    let statusDescription = "Status not provided";
    let etag: string | null = null;
    if (config.provider === "uptime-kuma") {
      const slug = encodeURIComponent(config.slug!);
      const configURL = new URL(`/api/status-page/${slug}`, base);
      const heartbeatURL = new URL(`/api/status-page/heartbeat/${slug}`, base);
      const [statusResponse, heartbeatResponse] = await Promise.all([getJSON(configURL, fetcher), getJSON(heartbeatURL, fetcher)]);
      const statusData = statusResponse.value;
      const heartbeatData = heartbeatResponse.value;
      const pageConfig = record(record(statusData).config);
      if (pageConfig.published === false) throw new Error("Status page is not published.");
      const groups = Array.isArray(statusData?.publicGroupList) ? statusData.publicGroupList.slice(0, MAX_GROUPS).map((value: unknown, index: number) => ({ value: record(value), index })) : [];
      if (Array.isArray(statusData?.publicGroupList) && statusData.publicGroupList.length > MAX_GROUPS) throw new Error("Status page exceeds the group limit.");
      const heartbeatMap = record(heartbeatData?.heartbeatList);
      const heartbeatCount = Object.values(heartbeatMap).reduce((sum, value) => sum + (Array.isArray(value) ? value.length : 0), 0);
      if (heartbeatCount > MAX_HEARTBEAT_RECORDS) throw new Error("Status page exceeds the heartbeat limit.");
      const result: DashboardComponent[] = [];
      const orderedGroups = groups.sort((a: any, b: any) => Number(a.value.weight ?? a.index) - Number(b.value.weight ?? b.index));
      for (const [groupOrder, { value: group }] of orderedGroups.entries()) {
        const groupId = String(group.id ?? "").slice(0, 100);
        const groupName = safeText(group.name, "Unassigned group");
        const monitors = Array.isArray(group.monitorList) ? group.monitorList : [];
        for (const [componentOrder, monitorValue] of monitors.entries()) {
          if (result.length >= MAX_MONITORS) throw new Error("Status page exceeds the monitor limit.");
          const monitor = record(monitorValue);
          const history = Array.isArray(heartbeatMap[String(monitor.id)]) ? heartbeatMap[String(monitor.id)] : [];
          const latest = history.map(record).reduce((selected: any, beat: any) => {
            const timestamp = parseTimestamp(beat.time);
            return timestamp && (!selected || Date.parse(timestamp) > Date.parse(selected.time)) ? { ...beat, time: timestamp } : selected;
          }, null);
          result.push({ id: String(monitor.id ?? `monitor-${result.length}`).slice(0, 100), name: safeText(monitor.name),
            status: latest ? kumaHealth(latest.status) : "unknown",
            ...(typeof latest?.ping === "number" && Number.isFinite(latest.ping) && latest.ping >= 0 && latest.ping <= 600_000 ? { latencyMs: latest.ping } : {}),
            sampledAt: latest ? parseTimestamp(latest.time) : null, groupId: groupId || null, groupName, groupOrder, componentOrder });
        }
      }
      components = result;
      incidents = incidentList(statusData?.incidents);
      maintenance = incidentList(statusData?.maintenanceList);
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
      const sameSource = previous?.provider === config.provider && previous.hostname === config.hostname;
      const response = await getJSON(url, fetcher, sameSource ? previous?.etag : undefined);
      if (response.notModified) {
        if (!previous || !sameSource || previous.freshness !== "fresh") throw new Error("Status API returned 304 without a cached source.");
        return { ...previous, displayName: config.display_name, fetchedAt: now.toISOString(), etag: response.etag ?? previous.etag };
      }
      const data = response.value;
      if (!Array.isArray(data?.components) || data.components.length > MAX_MONITORS) throw new Error("Status API component list is missing or exceeds the limit.");
      const raw = data.components.map(record);
      const groupNames = new Map(raw.filter((row: any) => row.group === true).map((row: any) => [String(row.id), safeText(row.name)]));
      const componentOrderById = new Map(raw.map((row: any, index: number) => [String(row.id), index]));
      const groupOrderById = new Map(raw.filter((row: any) => row.group === true).map((row: any, index: number) => [String(row.id), index]));
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
      if (response.etag) etag = response.etag;
    }
    return { id: config.id, provider: config.provider, displayName: safeText(config.display_name), hostname: config.hostname, fetchedAt: now.toISOString(),
      freshness, status, statusDescription, ...(config.provider === "atlassian-statuspage" && typeof etag === "string" ? { etag } : {}), components, incidents, maintenance };
  } catch (error) { return staleSource(config, now.toISOString(), error); }
}

export function providerOf(value: unknown): value is Provider {
  return value === "uptime-kuma" || value === "atlassian-statuspage";
}

export function validateSourceConfig(config: SourceConfig, allowlist: string) {
  allowedURL(config, allowlist);
  if (!config.display_name.trim() || config.display_name.length > 100) throw new Error("Source display name must be between 1 and 100 characters.");
}
