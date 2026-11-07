export type Provider = "uptime-kuma" | "atlassian-statuspage";
export type Health = "operational" | "degraded" | "down" | "maintenance" | "pending" | "unknown" | "stale";

export interface DashboardIncident {
  id: string;
  name: string;
  status: string;
  impact: string;
  updatedAt: string | null;
  scheduledFor?: string | null;
}

export interface EndpointCacheMetadata {
  etag?: string;
  lastModified?: string;
  cacheControl?: string;
  contentFetchedAt: string;
  revalidatedAt?: string;
}

export interface ApiSourceRequestStats {
  requestCount: number;
  notModifiedCount: number;
  failedRequestCount: number;
  responseBytes: number;
  durationMs: number;
}

export interface DashboardComponent {
  id: string;
  name: string;
  status: Health;
  latencyMs?: number;
  sampledAt: string | null;
  statusChangedAt?: string;
  history?: Array<{ at: string; status: Health }>;
  groupId: string | null;
  groupName: string | null;
  groupOrder?: number;
  componentOrder?: number;
  isGroup?: boolean;
}

export interface DashboardGroup {
  id: string;
  name: string;
  order: number;
}

export interface DashboardSource {
  id: string;
  provider: Provider;
  displayName: string;
  hostname?: string;
  sourceKey?: string;
  fetchedAt: string;
  freshness: "fresh" | "stale" | "unavailable";
  disabled?: boolean;
  status: Health;
  statusDescription: string;
  etag?: string;
  cache?: {
    summary?: EndpointCacheMetadata;
    statusPage?: EndpointCacheMetadata;
    heartbeat?: EndpointCacheMetadata;
  };
  requestStats?: ApiSourceRequestStats;
  components: DashboardComponent[];
  groups?: DashboardGroup[];
  incidents: DashboardIncident[];
  maintenance: DashboardIncident[];
  error?: string;
  retryableError?: boolean;
}

export const healthLabel: Record<Health, string> = {
  operational: "Operational", degraded: "Degraded", down: "Down", maintenance: "Maintenance",
  pending: "Pending", unknown: "Unknown", stale: "Unavailable / stale",
};

export function kumaHealth(value: unknown): Health {
  if (value === 1 || value === "up") return "operational";
  if (value === 2 || value === "pending") return "pending";
  if (value === 3 || value === "maintenance") return "maintenance";
  if (value === 0 || value === "down") return "down";
  if (value === "degraded") return "degraded";
  return "unknown";
}

export function statuspageHealth(value: unknown): Health {
  switch (value) {
    case "operational": return "operational";
    case "degraded_performance":
    case "under_maintenance": return value === "under_maintenance" ? "maintenance" : "degraded";
    case "partial_outage": return "degraded";
    case "major_outage": return "down";
    case "none": return "operational";
    case "minor": return "degraded";
    case "major": return "down";
    case "critical": return "down";
    case "maintenance": return "maintenance";
    default: return "unknown";
  }
}

export function parseTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

export function overallHealth(sources: DashboardSource[]): Health {
  const activeSources = sources.filter((source) => !source.disabled);
  const states = activeSources.flatMap((source) => [source.status, ...source.components.filter((component) => !component.isGroup).map((component) => component.status)]);
  if (activeSources.some((source) => source.freshness !== "fresh")) return "stale";
  if (states.includes("down")) return "down";
  if (states.includes("degraded")) return "degraded";
  if (states.includes("maintenance")) return "maintenance";
  if (states.includes("pending")) return "pending";
  if (!states.length || states.includes("unknown")) return "unknown";
  return "operational";
}
