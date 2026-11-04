type Playlist = { playlist_id?: string; revision_count?: number; active?: boolean | number; created_at?: number };
type CaptureSummary = {
  capture_id?: string;
  name?: string | null;
  display_url?: string;
  sha256?: string;
  last_error?: string | null;
  last_attempt_at?: number | null;
  last_success_at?: number | null;
  next_due_at?: number | null;
  job_status?: string | null;
  schedule_reviewed?: boolean | number;
  capture_interval_seconds?: number;
  viewport?: { width: number; height: number };
  wait_for_selector?: string | null;
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
export type FleetInsight = {
  key: string;
  title: string;
  severity: "action" | "review";
  evidence: string;
  updatedAt: number | null;
  action: { label: string; href: string };
};
type EnrollmentRequestSummary = { created_at?: number | null };
type HealthOutput = { connector?: string; error_code?: string; last_frame_age_seconds: number | null; display_id: string; status: string };
type HealthReport = { sync?: { last_success_age_seconds?: number | null; status?: string; applied_playlist_id?: string; applied_revision?: number }; agent_version: string; agent_uptime_seconds: number; startup_error_code?: string; outputs?: HealthOutput[]; host?: { uptime_seconds: number; temperature_millicelsius: number; memory_available_bytes: number; state_disk_free_bytes: number; load_1m: number } };
type HealthHistory = { events?: { metadata?: { health_status?: string; previous_health_status?: string }; received_at: number; event_type: string; error_code?: string }[]; samples?: unknown[] };

const AUDIT_EVENT_LABELS: Record<string, string> = {
  "asset.uploaded": "Uploaded playlist image",
  "capture.skip_once_applied": "Skipped one scheduled screenshot",
  "capture.skip_once_confirmed": "Confirmed one screenshot skip",
  "capture.interval_updated": "Updated screenshot interval",
  "capture.name_updated": "Updated capture site name",
  "capture.schedule_reviewed": "Reviewed screenshot schedule",
  "capture.site_created": "Added capture site",
  "capture.site_removed": "Removed capture site",
  "capture.site_restored": "Restored capture site",
  "device.credential_rotated": "Rotated device token",
  "device.deleted": "Deleted device",
  "device.disabled": "Disabled device",
  "device.enabled": "Enabled device",
  "enrollment_code.created": "Created enrollment code",
  "playlist.activated": "Activated playlist version",
  "playlist.deleted": "Deleted playlist",
  "playlist.revision_created": "Created playlist version",
  "development.bootstrap": "Created initial playlist",
};

export function createTransientNotice({
  duration = 5000,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  onExpire = () => {},
  nowFn = Date.now,
} = {}) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let remaining = duration;
  let startedAt: number | null = null;
  let active = false;
  const schedule = () => {
    startedAt = nowFn();
    timer = setTimeoutFn(() => {
      timer = null;
      remaining = 0;
      active = false;
      onExpire();
    }, remaining);
  };
  return {
    start() {
      if (timer !== null) clearTimeoutFn(timer);
      remaining = duration;
      active = true;
      schedule();
    },
    pause() {
      if (!active || timer === null) return;
      clearTimeoutFn(timer);
      timer = null;
      remaining = Math.max(0, remaining - Math.max(0, nowFn() - (startedAt ?? nowFn())));
    },
    resume() {
      if (!active || timer !== null) return;
      if (remaining === 0) {
        active = false;
        onExpire();
        return;
      }
      schedule();
    },
    clear() {
      if (timer !== null) clearTimeoutFn(timer);
      timer = null;
      remaining = duration;
      startedAt = null;
      active = false;
    },
  };
}

export function formatPlaylistState(active: unknown) {
  return active ? "Active" : "Ready to activate";
}

export function playlistDeleteActionStates(playlists: Playlist[]) {
  const records = Array.isArray(playlists) ? playlists : [];
  const groups = new Map<string, { count: number; versionCount: number; active: boolean; representative: Playlist | null }>();

  records.forEach((playlist) => {
    const playlistID = String(playlist?.playlist_id ?? "");
    if (!playlistID) return;
    let group = groups.get(playlistID);
    if (!group) {
      group = { count: 0, versionCount: 0, active: false, representative: null };
      groups.set(playlistID, group);
    }

    group.count += 1;
    group.versionCount = Math.max(group.versionCount, Number(playlist.revision_count) || 0, group.count);
    group.active ||= playlist.active === true || playlist.active === 1;

    const current = group.representative;
    const candidateActive = playlist.active === true || playlist.active === 1;
    const currentActive = current?.active === true || current?.active === 1;
    const preferCandidate = !current ||
      (currentActive && !candidateActive) ||
      (currentActive === candidateActive && (Number(playlist.created_at) || 0) > (Number(current.created_at) || 0));
    if (preferCandidate) group.representative = playlist;
  });

  return records.map((playlist) => {
    const group = groups.get(String(playlist?.playlist_id ?? ""));
    const versionCount = group?.versionCount ?? 0;
    const versionLabel = versionCount === 1 ? "version" : "versions";
    return {
      visible: Boolean(group && group.representative === playlist),
      disabled: Boolean(group?.active),
      versionCount,
      hint: group?.active
        ? `Activate another playlist first. Deleting removes all ${versionCount} saved ${versionLabel}.`
        : `Deleting removes all ${versionCount} saved ${versionLabel}.`,
    };
  });
}

export function formatScreenshotStatus(jobStatus: string | null, lastError: string | null, lastSuccessAt: number | null) {
  if (jobStatus === "running") return { label: "Screenshot in progress", tone: "warning" };
  if (jobStatus === "queued") return { label: "Screenshot queued", tone: "warning" };
  if (lastError) return { label: "Needs attention", tone: "warning" };
  if (lastSuccessAt) return { label: "Screenshot ready", tone: "success" };
  return { label: "Waiting for first screenshot", tone: "neutral" };
}

export function buildFleetInsights(overview: FleetOverview = {}, enrollmentRequests: EnrollmentRequestSummary[] = []) {
  const items: FleetInsight[] = [];
  const devices = Array.isArray(overview.devices) ? overview.devices : [];
  const enabledDevices = devices.filter((device) => device.enabled !== false && device.enabled !== 0);
  const activePlaylist = overview.active_playlist;

  if (!activePlaylist && enabledDevices.length) {
    items.push({
      key: "playlist",
      title: "No active playlist is assigned",
      severity: "action",
      evidence: `${enabledDevices.length} enabled ${enabledDevices.length === 1 ? "device is" : "devices are"} waiting for a playlist to be activated.`,
      updatedAt: null,
      action: { label: "Choose a playlist", href: "#playlist-section" },
    });
  }

  const reviewedDevices = enabledDevices.filter((device) =>
    ["degraded", "stale", "offline", "unknown"].includes(device.health?.status ?? "unknown") ||
    device.health?.sync_status === "failed" ||
    isPlaylistSyncUnknown(device, activePlaylist) ||
    (device.health?.sync_status !== "ok" && device.health?.sync_status !== "failed") ||
    isBehindActivePlaylist(device, activePlaylist),
  );
  if (reviewedDevices.length) {
    const statuses = new Map<string, number>();
    for (const device of reviewedDevices) {
      const status = device.health?.status ?? "unknown";
      if (["degraded", "stale", "offline", "unknown"].includes(status)) statuses.set(status, (statuses.get(status) ?? 0) + 1);
    }
    const offline = statuses.get("offline") ?? 0;
    const degraded = statuses.get("degraded") ?? 0;
    const stale = statuses.get("stale") ?? 0;
    const unknown = statuses.get("unknown") ?? 0;
    const failedSync = reviewedDevices.filter((device) => device.health?.sync_status === "failed").length;
    const syncUnknown = reviewedDevices.filter((device) => device.health?.sync_status !== "ok" && device.health?.sync_status !== "failed").length;
    const behind = reviewedDevices.filter((device) => isBehindActivePlaylist(device, activePlaylist)).length;
    const affected = formatAffectedLabels(reviewedDevices.map((device) => device.device_id));
    const evidence = [
      countLabel(offline, "offline device", "offline devices"),
      countLabel(degraded, "degraded device", "degraded devices"),
      countLabel(stale, "stale report"),
      countLabel(unknown, "unknown health status", "unknown health statuses"),
      countLabel(failedSync, "sync failure"),
      countLabel(syncUnknown, "sync status unavailable", "sync statuses unavailable"),
      countLabel(behind, "device behind the active playlist", "devices behind the active playlist"),
      affected ? `Affected devices: ${affected}` : "",
    ].filter(Boolean).join(" · ");
    items.push({
      key: "devices",
      title: `${reviewedDevices.length} ${reviewedDevices.length === 1 ? "device needs" : "devices need"} a health or sync review`,
      severity: offline || degraded || failedSync || behind ? "action" : "review",
      evidence,
      updatedAt: latestTimestamp(reviewedDevices.map((device) => device.health?.received_at)),
      action: { label: "Review devices", href: "#device-section" },
    });
  }

  const missingAssets = overview.asset_health?.missing ?? [];
  const integrityIssues = overview.asset_health?.integrity_issues ?? [];
  const assetIssues = [...missingAssets, ...integrityIssues];
  const uniqueAssets = new Set(assetIssues.map((asset, index) => asset.sha256 ?? `issue-${index}`));
  if (uniqueAssets.size) {
    items.push({
      key: "assets",
      title: `${uniqueAssets.size} active playlist ${uniqueAssets.size === 1 ? "asset has" : "assets have"} issues`,
      severity: "action",
      evidence: [countLabel(missingAssets.length, "missing asset"), countLabel(integrityIssues.length, "integrity issue")].filter(Boolean).join(" · "),
      updatedAt: latestTimestamp(assetIssues.map((asset) => asset.last_seen_at)),
      action: { label: "Review playlist assets", href: "#playlist-section" },
    });
  }

  const captureTargets = Array.isArray(overview.capture_targets) ? overview.capture_targets : [];
  const failedCaptures = captureTargets.filter((target) =>
    Boolean(target.last_error) && !["queued", "running"].includes(target.job_status ?? ""));
  if (failedCaptures.length) {
    const lastAttempt = latestTimestamp(failedCaptures.map((target) => target.last_attempt_at));
    const affected = formatAffectedLabels(failedCaptures.map((target) => target.name || target.display_url));
    items.push({
      key: "captures",
      title: `${failedCaptures.length} ${failedCaptures.length === 1 ? "screenshot capture failed" : "screenshot captures failed"}`,
      severity: "action",
      evidence: `${failedCaptures.length} ${failedCaptures.length === 1 ? "site has" : "sites have"} a failed latest capture${lastAttempt !== null ? ` · Latest failed attempt at ${formatTimestamp(lastAttempt)}` : ""}${affected ? ` · Affected sites: ${affected}` : ""}`,
      updatedAt: lastAttempt,
      action: { label: "Review capture sites", href: "#sites-section" },
    });
  }

  const unreviewedSchedules = captureTargets.filter((target) => target.schedule_reviewed === false || target.schedule_reviewed === 0);
  if (unreviewedSchedules.length) {
    const affected = formatAffectedLabels(unreviewedSchedules.map((target) => target.name || target.display_url));
    items.push({
      key: "schedules",
      title: `${unreviewedSchedules.length} ${unreviewedSchedules.length === 1 ? "capture schedule needs" : "capture schedules need"} review`,
      severity: "review",
      evidence: `${unreviewedSchedules.length} ${unreviewedSchedules.length === 1 ? "schedule has not been reviewed before adding its site to a playlist" : "schedules have not been reviewed before adding those sites to a playlist"}.${affected ? ` Affected sites: ${affected}.` : ""}`,
      updatedAt: null,
      action: { label: "Review schedules", href: "#sites-section" },
    });
  }

  if (enrollmentRequests.length) {
    const createdAt = latestTimestamp(enrollmentRequests.map((request) => request.created_at));
    items.push({
      key: "enrollments",
      title: `${enrollmentRequests.length} ${enrollmentRequests.length === 1 ? "device is" : "devices are"} waiting for approval`,
      severity: "review",
      evidence: `${countLabel(enrollmentRequests.length, "pending enrollment")} · Verify each device fingerprint before approving.`,
      updatedAt: createdAt,
      action: { label: "Review approvals", href: "#pending-enrollments-title" },
    });
  }
  return items;
}

function countLabel(count: number, singular: string, plural = `${singular}s`) {
  return count ? `${count} ${count === 1 ? singular : plural}` : "";
}

function latestTimestamp(values: unknown[]) {
  const timestamps = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return timestamps.length ? Math.max(...timestamps) : null;
}

function isBehindActivePlaylist(device: FleetDevice, activePlaylist: FleetOverview["active_playlist"]) {
  return Boolean(activePlaylist && device.health?.applied_playlist_id && device.health?.applied_revision !== undefined && device.health?.applied_revision !== null &&
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

export function formatCaptureInterval(seconds: number) {
  if (seconds >= 86400 && seconds % 86400 === 0) {
    const days = seconds / 86400;
    return `Every ${days} day${days === 1 ? "" : "s"}`;
  }
  if (seconds >= 3600 && seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return `Every ${hours} hour${hours === 1 ? "" : "s"}`;
  }
  if (seconds >= 60 && seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `Every ${minutes === 1 ? "minute" : `${minutes} minutes`}`;
  }
  return `Every ${seconds} second${seconds === 1 ? "" : "s"}`;
}

export function formatTimestamp(value: string | number | null | undefined, locale?: string) {
  if (value === null || value === undefined || value === "") return "Never seen";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  const formatted = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "UTC",
  }).format(date);
  return `${formatted} UTC`;
}

export function formatAuditEventType(eventType: string) {
  if (Object.hasOwn(AUDIT_EVENT_LABELS, eventType)) return AUDIT_EVENT_LABELS[eventType];
  const words = String(eventType ?? "Unknown event").replace(/[._]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function formatEnvironmentNotice(environment: string) {
  const production = environment === "production";
  return {
    production,
    label: production ? "Production" : "Development",
    heading: production ? "Production environment." : "Development environment.",
    detail: production
      ? "Your session is verified through Cloudflare Access."
      : "Administrator sign-in is not configured for this deployment.",
  };
}

export function formatActorLabel(actorID: unknown) {
  if (actorID === null || actorID === undefined || actorID === "") return "Unknown";
  if (String(actorID).toLowerCase() === "anonymous") return "Unauthenticated";
  return String(actorID);
}

export function compactIdentifier(value: unknown) {
  if (value === null || value === undefined || value === "") return "—";
  const identifier = String(value);
  if (identifier.length <= 24) return identifier;
  return `${identifier.slice(0, 10)}…${identifier.slice(-6)}`;
}

export function formatDeviceEnabledMessage(deviceID: string, enabled: boolean) {
  return `Device ${deviceID} is now ${enabled ? "enabled" : "disabled"}.`;
}

export function formatEnrollmentApprovalPrompt(request: { replaces_existing?: boolean; device_id: string; fingerprint: string }) {
  const replacement = request.replaces_existing
    ? ` This will replace the existing credentials for ${request.device_id}.`
    : "";
  return `Only approve ${request.device_id} if its physical display shows the full fingerprint ${request.fingerprint}.${replacement}`;
}

export function formatDeviceHealthDetails(result: { latest?: HealthReport | null; health_status: string; received_at: number }, history: HealthHistory = {}) {
  const report = result?.latest;
  if (!report) return { message: "This device has not reported health yet." };

  const sync = report.sync ?? {};
  const lastSync = sync.last_success_age_seconds == null
    ? "never"
    : `${formatAge(sync.last_success_age_seconds)} ago`;
  const summary = [
    `Fleet health ${result.health_status}.`,
    `Last report ${formatTimestamp(result.received_at)} · Agent ${report.agent_version} · Uptime ${formatAge(report.agent_uptime_seconds)}`,
    `Sync ${sync.status ?? "unknown"} · last success ${lastSync}${sync.applied_playlist_id ? ` · ${sync.applied_playlist_id} / ${sync.applied_revision ?? "revision unknown"}` : ""}`,
  ];
  if (report.startup_error_code) summary.push(`Startup issue: ${report.startup_error_code}`);

  const outputs = (report.outputs ?? []).map((output) => {
    const connector = output.connector ? ` (${output.connector})` : "";
    const issue = output.error_code ? ` · ${output.error_code}` : "";
    const lastFrame = output.last_frame_age_seconds === null
      ? "no successful frame yet"
      : `last frame ${formatAge(output.last_frame_age_seconds ?? NaN)} ago`;
    return `${output.display_id}${connector}: ${output.status} · ${lastFrame}${issue}`;
  });

  const host = [];
  if (report.host) {
    if (Number.isFinite(report.host.uptime_seconds)) host.push(`Host uptime ${formatAge(report.host.uptime_seconds)}`);
    if (Number.isFinite(report.host.temperature_millicelsius)) host.push(`Temperature ${(report.host.temperature_millicelsius / 1000).toFixed(1)}°C`);
    if (Number.isFinite(report.host.memory_available_bytes)) host.push(`Memory ${formatBytes(report.host.memory_available_bytes)} available`);
    if (Number.isFinite(report.host.state_disk_free_bytes)) host.push(`State disk ${formatBytes(report.host.state_disk_free_bytes)} free`);
    if (Number.isFinite(report.host.load_1m)) host.push(`1m load ${report.host.load_1m.toFixed(2)}`);
  }

  const events = (history.events ?? []).map((event) => {
    const status = event.metadata?.health_status ? ` · ${event.metadata.health_status}` : "";
    const transition = event.metadata?.previous_health_status
      ? ` (${event.metadata.previous_health_status} → ${event.metadata.health_status})`
      : "";
    return `${formatTimestamp(event.received_at)} · ${event.event_type}${status}${transition}${event.error_code ? ` · ${event.error_code}` : ""}`;
  });

  return {
    summary,
    outputs,
    host,
    events,
    sampleCount: history.samples?.length ?? 0,
  };
}

export function createRetryableLoadOnce() {
  let loaded = false;
  let pending: Promise<unknown> | null = null;
  return {
    get loaded() { return loaded; },
    load<T>(loader: () => T | Promise<T>): Promise<T | undefined> {
      if (loaded) return Promise.resolve(undefined);
      if (!pending) {
        pending = Promise.resolve()
          .then(loader)
          .then((value) => {
            loaded = true;
            return value;
          })
          .finally(() => { pending = null; });
      }
      return pending as Promise<T>;
    },
  };
}

function formatAge(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "unknown";
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = bytes;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${amount.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatAuditDetails(metadata: unknown, locale?: string) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  return Object.entries(metadata).map(([key, value]) => ({
    label: humanizeMetadataKey(key),
    value: formatMetadataValue(key, value, locale),
  }));
}

export async function confirmBeforeAction<T>(confirmFn: (message: string) => boolean | Promise<boolean>, message: string, action: () => T | Promise<T>) {
  const { confirmed } = await confirmAction(confirmFn, message, action);
  return confirmed;
}

export async function confirmAction<T>(confirmFn: (message: string) => boolean | Promise<boolean>, message: string, action: () => T | Promise<T>) {
  if (typeof confirmFn !== "function") throw new TypeError("A confirmation function is required");
  if (!(await confirmFn(message))) return { confirmed: false, result: undefined };
  return { confirmed: true, result: await action() };
}

function formatMetadataValue(key: string, value: unknown, locale?: string): string {
  if (value === null || value === undefined || value === "") return "—";
  if ((typeof value === "number" || typeof value === "string") && /(?:_at|_until|_expires)$/i.test(key)) {
    return formatTimestamp(value, locale);

  }
  if (Array.isArray(value)) return value.map((item) => formatMetadataValue(key, item, locale)).join(", ");
  if (typeof value === "object") {
    return Object.entries(value)
      .map(([childKey, childValue]) => `${humanizeMetadataKey(childKey)}: ${formatMetadataValue(childKey, childValue, locale)}`)
      .join("; ");
  }
  if (typeof value === "number") return new Intl.NumberFormat(locale).format(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function humanizeMetadataKey(key: string) {
  const words = String(key)
    .replace(/\basset_count\b/gi, "image count")
    .replace(/_/g, " ")
    .replace(/\brevision\b/gi, "version")
    .replace(/\bsha256\b/gi, "SHA-256")
    .replace(/\bid\b/gi, "ID")
    .replace(/\br2\b/gi, "R2");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Keep urgent capture problems visible without mutating the server's ordering. */
export function prioritizeCaptureTargets<T extends CaptureSummary>(targets: T[]) {
  const priority = (target: CaptureSummary) => target.last_error && !["queued", "running"].includes(target.job_status ?? "")
    ? 0 : target.schedule_reviewed === false || target.schedule_reviewed === 0 ? 1 : 2;
  return [...targets].sort((a, b) => priority(a) - priority(b));
}

export function summarizeCaptureErrors(targets: CaptureSummary[]) {
  const counts = new Map<string, number>();
  targets.forEach((target) => {
    if (target.last_error && !["queued", "running"].includes(target.job_status ?? "")) {
      counts.set(target.last_error, (counts.get(target.last_error) ?? 0) + 1);
    }
  });
  return [...counts].filter(([, count]) => count > 1).map(([message, count]) => ({ message, count }));
}
