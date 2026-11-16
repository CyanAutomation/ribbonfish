import type { DashboardSource, Health } from "./model.ts";

export const dashboardColors: Record<Health, string> = {
  operational: "#20c997", degraded: "#f6c453", down: "#ff647c", maintenance: "#a78bfa",
  pending: "#60a5fa", unknown: "#94a3b8", stale: "#fb923c",
};

export function healthOrder(health: Health): number {
  return ({ down: 0, degraded: 1, stale: 2, pending: 3, unknown: 4, maintenance: 5, operational: 6 })[health];
}

export function sourceHealth(source: DashboardSource): Health {
  if (source.disabled) return "unknown";
  if (source.freshness === "stale") return "stale";
  if (source.freshness === "unavailable") return "unknown";
  const leafStates = source.components.filter((item) => !item.isGroup).map((item) => item.status);
  if (leafStates.includes("down")) return "down";
  if (leafStates.includes("degraded")) return "degraded";
  if (leafStates.includes("maintenance")) return "maintenance";
  if (leafStates.includes("pending")) return "pending";
  if (leafStates.includes("stale")) return "stale";
  if (source.status !== "operational") return source.status;
  if (!leafStates.length || leafStates.includes("unknown")) return "unknown";
  return "operational";
}
