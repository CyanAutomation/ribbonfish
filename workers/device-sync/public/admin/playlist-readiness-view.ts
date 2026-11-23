import { createMetricGrid, inlineCode, node, statusBadge } from "./ui-primitives.ts";
import { createPlaylistSyncStatus } from "./ui-components.ts";

export type PlaylistReadinessViewData = {
  revision?: { playlist_id?: string; revision?: string; effective_revision?: string };
  status: "ready" | "review" | "blocked" | string;
  summary: {
    total_items: number;
    total_captures: number;
    fresh_captures: number;
    missing_assets: number;
    stale_captures: number;
    disabled_captures: number;
    unreviewed_schedules: number;
    devices_to_update: number;
  };
  blockers: string[];
  warnings: string[];
  items: Array<{ label: string; status: string }>;
  devices_to_update: Array<{ device_id: string; sync_status: string }>;
  latest_assessment: null | {
    assessed_at?: number;
    deterministic_status?: string;
    answers?: {
      assessment?: { choice?: string; confidence?: number | null } | null;
      risk?: { label?: string; confidence?: number | null } | null;
    };
    observed_outcome?: string | null;
  };
};

export type PlaylistReadinessViewOptions = {
  ownerDocument?: Document;
  onAssess?: () => void | Promise<void>;
};

function readinessLabel(status: string) {
  return status === "ready" ? "Ready" : status === "blocked" ? "Blocked" : "Needs review";
}

function statusTone(status: string) {
  return status === "ready" ? "success" : status === "blocked" ? "error" : "warning";
}

function humanize(value: string) {
  return value.replaceAll("_", " ");
}

function formatTime(value: unknown, ownerDocument: Document) {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value).toLocaleString(ownerDocument.defaultView?.navigator.language)
    : "Time unavailable";
}

export function renderPlaylistReadiness(
  readiness: PlaylistReadinessViewData,
  options: PlaylistReadinessViewOptions = {},
) {
  const ownerDocument = options.ownerDocument ?? document;
  const panel = node("section", undefined, "playlist-readiness", ownerDocument);
  panel.setAttribute("aria-label", "Playlist readiness");

  const heading = node("div", undefined, "playlist-readiness__heading", ownerDocument);
  const title = node("h3", "Playlist readiness", undefined, ownerDocument);
  heading.append(title, statusBadge(readinessLabel(readiness.status), statusTone(readiness.status), ownerDocument));
  if (readiness.revision?.playlist_id && readiness.revision.revision) {
    heading.append(node("p", `${readiness.revision.playlist_id} · revision ${readiness.revision.revision}`, "muted", ownerDocument));
  }
  panel.append(heading);

  const fresh = Math.max(0, Math.min(readiness.summary.total_captures, readiness.summary.fresh_captures));
  panel.append(createMetricGrid([
    { label: "Fresh captures", value: `${fresh} / ${readiness.summary.total_captures}` },
    { label: "Missing assets", value: readiness.summary.missing_assets },
    { label: "Schedules to review", value: readiness.summary.unreviewed_schedules },
    { label: "Devices to update", value: readiness.summary.devices_to_update },
  ], { className: "playlist-readiness__metrics", ownerDocument }));

  if (readiness.blockers.length || readiness.warnings.length) {
    const issues = node("div", undefined, readiness.blockers.length ? "alert alert--error" : "alert alert--warning", ownerDocument);
    issues.setAttribute("role", readiness.blockers.length ? "alert" : "status");
    if (readiness.blockers.length) {
      issues.append(node("strong", "Activation blockers", undefined, ownerDocument));
      issues.append(node("p", readiness.blockers.map(humanize).join(", "), undefined, ownerDocument));
    }
    if (readiness.warnings.length) {
      issues.append(node("strong", "Review before activation", undefined, ownerDocument));
      issues.append(node("p", readiness.warnings.map(humanize).join(", "), undefined, ownerDocument));
    }
    panel.append(issues);
  } else {
    panel.append(node("p", "Deterministic checks found no missing assets, disabled capture items, stale captures, or unreviewed schedules.", "muted", ownerDocument));
  }

  const checks = node("section", undefined, "playlist-readiness__section", ownerDocument);
  checks.append(node("h4", `Revision contents (${readiness.summary.total_items})`, undefined, ownerDocument));
  if (readiness.items.length) {
    const list = node("ul", undefined, "playlist-readiness__items", ownerDocument);
    readiness.items.forEach((item) => {
      const row = node("li", undefined, undefined, ownerDocument);
      row.append(node("span", item.label, undefined, ownerDocument), statusBadge(humanize(item.status), item.status === "ready" ? "success" : item.status === "missing" || item.status === "disabled" ? "error" : "warning", ownerDocument));
      list.append(row);
    });
    checks.append(list);
  } else checks.append(node("p", "This revision has no assets or capture sites.", "muted", ownerDocument));
  panel.append(checks);

  const recipients = node("section", undefined, "playlist-readiness__section", ownerDocument);
  recipients.append(node("h4", "Devices that would receive this revision", undefined, ownerDocument));
  if (readiness.devices_to_update.length) {
    const list = node("ul", undefined, "playlist-readiness__devices", ownerDocument);
    readiness.devices_to_update.forEach((device) => {
      const row = node("li", undefined, undefined, ownerDocument);
      row.append(inlineCode(device.device_id, { ownerDocument }), createPlaylistSyncStatus({
        state: device.sync_status as "behind" | "unreported",
        ownerDocument,
      }));
      list.append(row);
    });
    recipients.append(list);
  } else recipients.append(node("p", "No enabled devices need this revision.", "muted", ownerDocument));
  panel.append(recipients);

  const assessment = node("section", undefined, "playlist-readiness__assessment", ownerDocument);
  assessment.append(node("h4", "JEV shadow assessment", undefined, ownerDocument));
  assessment.append(node("p", "Advisory only. Deterministic checks and server-side activation validation remain authoritative.", "muted", ownerDocument));
  if (readiness.latest_assessment) {
    const choice = readiness.latest_assessment.answers?.assessment?.choice;
    const risk = readiness.latest_assessment.answers?.risk?.label;
    const answer = node("p", `JEV: ${choice ? humanize(choice) : "No typed result"}${risk ? ` · ${risk} risk` : ""}`, undefined, ownerDocument);
    assessment.append(answer);
    assessment.append(node("p", `Deterministic status at assessment: ${readinessLabel(readiness.latest_assessment.deterministic_status ?? "review")}.`, "muted", ownerDocument));
    if (readiness.latest_assessment.observed_outcome) {
      assessment.append(node("p", `Observed outcome: ${humanize(readiness.latest_assessment.observed_outcome)}.`, "muted", ownerDocument));
    }
    if (typeof readiness.latest_assessment.assessed_at === "number") {
      assessment.append(node("p", `Assessed ${formatTime(readiness.latest_assessment.assessed_at, ownerDocument)}.`, "muted", ownerDocument));
    }
  } else assessment.append(node("p", "No JEV shadow assessment recorded for this revision.", "muted", ownerDocument));
  if (options.onAssess) {
    const assess = ownerDocument.createElement("button");
    assess.type = "button";
    assess.className = "button button--secondary";
    assess.textContent = "Run JEV shadow assessment";
    assess.addEventListener("click", async () => {
      if (assess.disabled) return;
      assess.disabled = true;
      assess.textContent = "Assessing readiness…";
      try {
        await options.onAssess?.();
      } finally {
        assess.disabled = false;
        assess.textContent = "Run JEV shadow assessment";
      }
    });
    assessment.append(assess);
  }
  panel.append(assessment);
  return panel;
}
