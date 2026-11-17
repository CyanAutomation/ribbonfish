import { formatTimestamp } from "./admin-formatters.ts";

type CaptureSummary = {
  name?: string | null;
  display_url?: string;
  last_error?: string | null;
  last_attempt_at?: number | null;
  job_status?: string | null;
  schedule_reviewed?: boolean | number;
};
type FleetDevice = {
  device_id?: string;
  enabled?: boolean | number;
  health?: {
    status?: string;
    sync_status?: string;
    applied_playlist_id?: string | null;
    applied_revision?: string | number | null;
    received_at?: number | null;
  } | null;
};
type FleetOverview = {
  active_playlist?: { playlist_id?: string; revision?: string | number } | null;
  devices?: FleetDevice[];
  asset_health?: { missing?: { sha256?: string; last_seen_at?: number }[]; integrity_issues?: { sha256?: string; last_seen_at?: number }[] };
  capture_targets?: CaptureSummary[];
};
type CaptureTargetSummary = NonNullable<FleetOverview["capture_targets"]>[number];
type FleetInsight = {
  key: string;
  title: string;
  severity: "action" | "review";
  evidence: string;
  updatedAt: number | null;
  action: { label: string; href: string };
};
type EnrollmentRequestSummary = { created_at?: number | null };

export function buildFleetInsights(overview: FleetOverview = {}, enrollmentRequests: EnrollmentRequestSummary[] = []) {
  const devices = Array.isArray(overview.devices) ? overview.devices : [];
  const enabledDevices = devices.filter((device) => device.enabled !== false && device.enabled !== 0);
  const activePlaylist = overview.active_playlist;
  const captureTargets = Array.isArray(overview.capture_targets) ? overview.capture_targets : [];

  return [
    missingPlaylistInsight(enabledDevices, activePlaylist),
    deviceReviewInsight(enabledDevices, activePlaylist),
    assetHealthInsight(overview),
    failedCaptureInsight(captureTargets),
    unreviewedScheduleInsight(captureTargets),
    pendingEnrollmentInsight(enrollmentRequests),
  ].filter((item): item is FleetInsight => item !== null);
}

function missingPlaylistInsight(enabledDevices: FleetDevice[], activePlaylist: FleetOverview["active_playlist"]): FleetInsight | null {
  if (activePlaylist || !enabledDevices.length) return null;
  return {
    key: "playlist",
    title: "No active playlist is assigned",
    severity: "action",
    evidence: `${enabledDevices.length} enabled ${enabledDevices.length === 1 ? "device is" : "devices are"} waiting for a playlist to be activated.`,
    updatedAt: null,
    action: { label: "Choose a playlist", href: "#playlist-section" },
  };
}

function deviceReviewInsight(enabledDevices: FleetDevice[], activePlaylist: FleetOverview["active_playlist"]): FleetInsight | null {
  const reviewedDevices = enabledDevices.filter((device) =>
    ["degraded", "stale", "offline", "unknown"].includes(device.health?.status ?? "unknown") ||
    device.health?.sync_status === "failed" ||
    isPlaylistSyncUnknown(device, activePlaylist) ||
    (device.health?.sync_status !== "ok" && device.health?.sync_status !== "failed") ||
    isBehindActivePlaylist(device, activePlaylist),
  );
  if (!reviewedDevices.length) return null;
  const counts = deviceReviewCounts(reviewedDevices, activePlaylist);
  const affected = formatAffectedLabels(reviewedDevices.map((device) => device.device_id));
  const evidence = [
    countLabel(counts.offline, "offline device", "offline devices"),
    countLabel(counts.degraded, "degraded device", "degraded devices"),
    countLabel(counts.stale, "stale report"),
    countLabel(counts.unknown, "unknown health status", "unknown health statuses"),
    countLabel(counts.failedSync, "sync failure"),
    countLabel(counts.syncUnknown, "sync status unavailable", "sync statuses unavailable"),
    countLabel(counts.behind, "device behind the active playlist", "devices behind the active playlist"),
    affected ? `Affected devices: ${affected}` : "",
  ].filter(Boolean).join(" · ");
  return {
    key: "devices",
    title: `${reviewedDevices.length} ${reviewedDevices.length === 1 ? "device needs" : "devices need"} a health or sync review`,
    severity: counts.offline || counts.degraded || counts.failedSync || counts.behind ? "action" : "review",
    evidence,
    updatedAt: latestTimestamp(reviewedDevices.map((device) => device.health?.received_at)),
    action: { label: "Review devices", href: "#device-section" },
  };
}

function deviceReviewCounts(devices: FleetDevice[], activePlaylist: FleetOverview["active_playlist"]) {
  const statuses = new Map<string, number>();
  for (const device of devices) {
    const status = device.health?.status ?? "unknown";
    if (["degraded", "stale", "offline", "unknown"].includes(status)) statuses.set(status, (statuses.get(status) ?? 0) + 1);
  }
  return {
    offline: statuses.get("offline") ?? 0,
    degraded: statuses.get("degraded") ?? 0,
    stale: statuses.get("stale") ?? 0,
    unknown: statuses.get("unknown") ?? 0,
    failedSync: devices.filter((device) => device.health?.sync_status === "failed").length,
    syncUnknown: devices.filter((device) => device.health?.sync_status !== "ok" && device.health?.sync_status !== "failed").length,
    behind: devices.filter((device) => isBehindActivePlaylist(device, activePlaylist)).length,
  };
}

function assetHealthInsight(overview: FleetOverview): FleetInsight | null {
  const missingAssets = overview.asset_health?.missing ?? [];
  const integrityIssues = overview.asset_health?.integrity_issues ?? [];
  const assetIssues = [...missingAssets, ...integrityIssues];
  const uniqueAssets = new Set(assetIssues.map((asset, index) => asset.sha256 ?? `issue-${index}`));
  if (!uniqueAssets.size) return null;
  return {
    key: "assets",
    title: `${uniqueAssets.size} active playlist ${uniqueAssets.size === 1 ? "asset has" : "assets have"} issues`,
    severity: "action",
    evidence: [countLabel(missingAssets.length, "missing asset"), countLabel(integrityIssues.length, "integrity issue")].filter(Boolean).join(" · "),
    updatedAt: latestTimestamp(assetIssues.map((asset) => asset.last_seen_at)),
    action: { label: "Review playlist assets", href: "#playlist-section" },
  };
}

function failedCaptureInsight(captureTargets: CaptureTargetSummary[]): FleetInsight | null {
  const failedCaptures = captureTargets.filter((target) =>
    Boolean(target.last_error) && !["queued", "running"].includes(target.job_status ?? ""));
  if (!failedCaptures.length) return null;
  const lastAttempt = latestTimestamp(failedCaptures.map((target) => target.last_attempt_at));
  const affected = formatAffectedLabels(failedCaptures.map((target) => target.name || target.display_url));
  return {
    key: "captures",
    title: `${failedCaptures.length} ${failedCaptures.length === 1 ? "screenshot capture failed" : "screenshot captures failed"}`,
    severity: "action",
    evidence: `${failedCaptures.length} ${failedCaptures.length === 1 ? "site has" : "sites have"} a failed latest capture${lastAttempt !== null ? ` · Latest failed attempt at ${formatTimestamp(lastAttempt)}` : ""}${affected ? ` · Affected sites: ${affected}` : ""}`,
    updatedAt: lastAttempt,
    action: { label: "Review capture sites", href: "#sites-section" },
  };
}

function unreviewedScheduleInsight(captureTargets: CaptureTargetSummary[]): FleetInsight | null {
  const unreviewedSchedules = captureTargets.filter((target) => target.schedule_reviewed === false || target.schedule_reviewed === 0);
  if (!unreviewedSchedules.length) return null;
  const affected = formatAffectedLabels(unreviewedSchedules.map((target) => target.name || target.display_url));
  return {
    key: "schedules",
    title: `${unreviewedSchedules.length} ${unreviewedSchedules.length === 1 ? "capture schedule needs" : "capture schedules need"} review`,
    severity: "review",
    evidence: `${unreviewedSchedules.length} ${unreviewedSchedules.length === 1 ? "schedule has not been reviewed before adding its site to a playlist" : "schedules have not been reviewed before adding those sites to a playlist"}.${affected ? ` Affected sites: ${affected}.` : ""}`,
    updatedAt: null,
    action: { label: "Review schedules", href: "#sites-section" },
  };
}

function pendingEnrollmentInsight(enrollmentRequests: EnrollmentRequestSummary[]): FleetInsight | null {
  if (!enrollmentRequests.length) return null;
  const createdAt = latestTimestamp(enrollmentRequests.map((request) => request.created_at));
  return {
    key: "enrollments",
    title: `${enrollmentRequests.length} ${enrollmentRequests.length === 1 ? "device is" : "devices are"} waiting for approval`,
    severity: "review",
    evidence: `${countLabel(enrollmentRequests.length, "pending enrollment")} · Verify each device fingerprint before approving.`,
    updatedAt: createdAt,
    action: { label: "Review approvals", href: "#pending-enrollments-title" },
  };
}

function countLabel(count: number, singular: string, plural = `${singular}s`) {
  return count ? `${count} ${count === 1 ? singular : plural}` : "";
}

function latestTimestamp(values: unknown[]) {
  const timestamps = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return timestamps.length ? Math.max(...timestamps) : null;
}

function isBehindActivePlaylist(device: FleetDevice, activePlaylist: FleetOverview["active_playlist"]) {
  return Boolean(activePlaylist && activePlaylist.revision !== undefined && activePlaylist.revision !== null &&
    device.health?.applied_playlist_id && device.health?.applied_revision !== undefined && device.health?.applied_revision !== null &&
    (device.health.applied_playlist_id !== activePlaylist.playlist_id || String(device.health.applied_revision) !== String(activePlaylist.revision)));
}

function isPlaylistSyncUnknown(device: FleetDevice, activePlaylist: FleetOverview["active_playlist"]) {
  return Boolean(activePlaylist && (!device.health?.applied_playlist_id || device.health?.applied_revision === undefined || device.health.applied_revision === null));
}

function formatAffectedLabels(labels: unknown[]) {
  const normalized = labels.filter((label): label is string => typeof label === "string" && Boolean(label.trim())).map((label) => label.trim());
  const visible = normalized.slice(0, 3);
  if (normalized.length > visible.length) visible.push(`+${normalized.length - visible.length} more`);
  return visible.join(", ");
}
