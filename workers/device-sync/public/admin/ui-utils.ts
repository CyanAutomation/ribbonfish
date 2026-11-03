type Playlist = { playlist_id?: string; revision_count?: number; active?: boolean | number; created_at?: number };
type CaptureSummary = { last_error?: string | null; job_status?: string; schedule_reviewed?: boolean | number };
type FleetOverview = { devices?: { enabled?: boolean | number; health?: { status?: string } }[]; asset_health?: { missing?: { sha256?: string }[]; integrity_issues?: { sha256?: string }[] }; capture_targets?: CaptureSummary[] };
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

export function summarizeFleetAttention(overview: FleetOverview = {}, enrollmentRequests: unknown[] = []) {
  const items = [];
  const devices = Array.isArray(overview.devices) ? overview.devices : [];
  const healthReviewCount = devices.filter((device) => {
    if (device.enabled === false || device.enabled === 0) return false;
    return ["degraded", "stale", "offline", "unknown"].includes(device.health?.status ?? "unknown");
  }).length;
  const assetIssues = [
    ...(overview.asset_health?.missing ?? []),
    ...(overview.asset_health?.integrity_issues ?? []),
  ];
  const uniqueAssetIssues = new Set(assetIssues.map((asset, index) => asset.sha256 ?? `issue-${index}`));
  const failedCaptures = (overview.capture_targets ?? []).filter((target) =>
    Boolean(target.last_error) && !["queued", "running"].includes(target.job_status ?? "")).length;

  if (enrollmentRequests.length) {
    items.push({
      key: "enrollments",
      count: enrollmentRequests.length,
      singular: "device awaiting approval",
      plural: "devices awaiting approval",
      href: "#pending-enrollments-title",
    });
  }
  if (healthReviewCount) {
    items.push({
      key: "devices",
      count: healthReviewCount,
      singular: "device needing health review",
      plural: "devices needing health review",
      href: "#device-section",
    });
  }
  if (uniqueAssetIssues.size) {
    items.push({
      key: "assets",
      count: uniqueAssetIssues.size,
      singular: "image availability issue",
      plural: "image availability issues",
      href: "#asset-health",
    });
  }
  if (failedCaptures) {
    items.push({
      key: "captures",
      count: failedCaptures,
      singular: "screenshot needing attention",
      plural: "screenshots needing attention",
      href: "#sites-section",
    });
  }
  return items;
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
    load(loader: () => unknown) {
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
      return pending;
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
