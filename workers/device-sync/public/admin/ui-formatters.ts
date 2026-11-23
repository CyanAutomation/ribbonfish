import { formatTimestamp } from "./admin-formatters.ts";

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
type JevAnswerDisplay = { type?: string; choice?: string; score?: number; legend?: Record<string, string> };

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

export function formatJevAnswerLabel(key: string) {
  return key.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function describeJevAnswer(key: string, answer: JevAnswerDisplay, durationReview?: string): string | null {
  if (key === "duration_review") {
    if (durationReview === "review_overestimate") {
      return "Measured p90 is at most half the configured reserve. Review the accounting reserve for possible overestimation; no setting was changed.";
    }
    if (durationReview === "review_underestimate") {
      return "Measured p90 exceeds the configured reserve. Review the accounting reserve for possible underestimation; no setting was changed.";
    }
    if (durationReview === "insufficient_data") {
      return "There is not enough measured timing evidence to recommend a reserve review.";
    }
    return "Keep the current accounting reserve based on the available timing evidence.";
  }
  if (answer.type === "choice" && typeof answer.choice === "string") {
    return `Recommendation: ${answer.choice.replaceAll("_", " ")}`;
  }
  if (answer.type === "score") {
    const level = answer.legend?.[String(Math.round(answer.score ?? Number.NaN))];
    if (typeof level === "string") return `${formatJevAnswerLabel(key)}: ${level}`;
  }
  return null;
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
    detail: production ? "" : "Administrator sign-in is not configured for this deployment.",
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

export function formatAuditDetails(metadata: unknown, locale?: string) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];
  return Object.entries(metadata).map(([key, value]) => ({
    label: humanizeMetadataKey(key),
    value: formatMetadataValue(key, value, locale),
  }));
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
  return targets.toSorted((a, b) => priority(a) - priority(b));
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
