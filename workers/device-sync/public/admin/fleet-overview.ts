import { CLOUDFLARE_FREE_BROWSER_DAILY_LIMIT_MS } from "../../src/capture-forecast.ts";
import { formatRunTime } from "./capture-presentation.ts";
import { node } from "./ui-primitives.ts";

type FleetOverviewData = {
  capture_targets?: Array<{
    capture_type?: string;
    last_error?: string | null;
    last_success_at?: number | null;
    schedule_reviewed?: boolean | number;
  }>;
  devices?: Array<{
    enabled?: boolean | number;
    health?: {
      status?: string;
      applied_playlist_id?: string | null;
      applied_revision?: string | number | null;
    } | null;
  }>;
  active_playlist?: { playlist_id?: string; revision?: string | number } | null;
  capture_efficiency?: {
    daily_usage?: {
      accounted_ms?: number;
      budget_ms?: number;
      free_plan_limit_ms?: number;
    };
  } | null;
};

type EnrollmentRequest = { request_id?: string };

function validMilliseconds(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isBehindActivePlaylist(device: NonNullable<FleetOverviewData["devices"]>[number], active: FleetOverviewData["active_playlist"]) {
  const health = device.health;
  if (!active || !health?.applied_playlist_id || health.applied_revision === undefined || health.applied_revision === null) return false;
  return health.applied_playlist_id !== active.playlist_id || String(health.applied_revision) !== String(active.revision);
}

function buildOverviewMetrics(overview: FleetOverviewData, enrollmentRequests: EnrollmentRequest[]) {
  const targets = (overview.capture_targets ?? []).filter((target) => target.capture_type !== "api-dashboard");
  const sitesNeedingAttention = targets.filter((target) =>
    Boolean(target.last_error) || target.schedule_reviewed === false || target.schedule_reviewed === 0 || !target.last_success_at).length;
  const devicesOfflineOrBehind = (overview.devices ?? []).filter((device) =>
    device.enabled !== false && device.enabled !== 0 &&
    (device.health?.status === "offline" || isBehindActivePlaylist(device, overview.active_playlist))).length;
  const dailyUsage = overview.capture_efficiency?.daily_usage;
  const budgetMs = validMilliseconds(dailyUsage?.budget_ms)
    ? dailyUsage.budget_ms
    : validMilliseconds(dailyUsage?.free_plan_limit_ms)
      ? dailyUsage.free_plan_limit_ms
      : CLOUDFLARE_FREE_BROWSER_DAILY_LIMIT_MS;
  const browserRunUsage = validMilliseconds(dailyUsage?.accounted_ms)
    ? `${formatRunTime(dailyUsage.accounted_ms)} / ${formatRunTime(budgetMs)}`
    : "Unavailable";

  return [
    { label: "Sites needing attention", value: String(sitesNeedingAttention), detail: "Review screenshot sites", href: "#sites-section" },
    { label: "Devices offline or behind", value: String(devicesOfflineOrBehind), detail: "Check device health and playlist sync", href: "#device-section" },
    { label: "Pending approvals", value: String(enrollmentRequests.length), detail: "Verify device fingerprints", href: "#pending-enrollments-title" },
    { label: "Browser Run used today", value: browserRunUsage, detail: "Used / configured daily budget", href: "#capture-efficiency-section" },
  ];
}

export function renderFleetOverviewMetrics(
  container: HTMLElement,
  overview: FleetOverviewData = {},
  enrollmentRequests: EnrollmentRequest[] = [],
) {
  const document = container.ownerDocument;
  const metrics = buildOverviewMetrics(overview, enrollmentRequests);
  container.replaceChildren(...metrics.map(({ label, value, detail, href }) => {
    const link = node("a", undefined, "overview-metric", document) as HTMLAnchorElement;
    link.href = href;
    link.append(
      node("span", label, "overview-metric__label", document),
      node("strong", value, "overview-metric__value", document),
      node("span", detail, "overview-metric__detail", document),
    );
    return link;
  }));
}
