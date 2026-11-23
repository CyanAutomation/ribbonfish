import {
  a2uiBadge,
  a2uiButton,
  a2uiCard,
  a2uiColumn,
  a2uiText,
  type ManagementA2uiComponent,
} from "./a2ui-components.ts";
import { renderA2uiMessages, type A2uiUserAction } from "./fleet-overview.ts";
import type { PlaylistReadinessViewData } from "./playlist-readiness-view.ts";

const SURFACE_ID = "playlistReadiness";
const CATALOG_ID = "https://ribbonfish.dev/a2ui/catalogs/management-v2.json";
const MAX_LIST_ENTRIES = 12;
const MAX_LABEL_LENGTH = 180;

export interface PlaylistReadinessA2uiMessage {
  version: "1.0";
  createSurface: {
    surfaceId: string;
    catalogId: string;
    sendDataModel: false;
    components: ManagementA2uiComponent[];
    dataModel: Record<string, unknown>;
  };
}

function validPlaylistID(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
}

function statusLabel(status: string) {
  return status === "ready" ? "Ready" : status === "blocked" ? "Blocked" : "Needs review";
}

function statusTone(status: string): "success" | "warning" | "error" {
  return status === "ready" ? "success" : status === "blocked" ? "error" : "warning";
}

function humanize(value: string) {
  return value.replaceAll("_", " ");
}

function boundedList(values: string[], empty: string): string {
  if (!values.length) return empty;
  const visible = values.slice(0, MAX_LIST_ENTRIES).map((value) => value.slice(0, MAX_LABEL_LENGTH));
  const remainder = values.length - visible.length;
  return remainder ? `${visible.join(" · ")} · and ${remainder} more` : visible.join(" · ");
}

function readinessItems(readiness: PlaylistReadinessViewData) {
  const items = readiness.items ?? [];
  if (!items.length) return "This revision has no assets or capture sites.";
  return boundedList(items.map((item) => `${item.label}: ${humanize(item.status)}`), "No revision items.");
}

function readinessDevices(readiness: PlaylistReadinessViewData) {
  const devices = readiness.devices_to_update ?? [];
  if (!devices.length) return "No enabled devices need this revision.";
  return boundedList(devices.map((device) => `${device.device_id}: ${humanize(device.sync_status)}`), "No devices to update.");
}

function assessmentSummary(readiness: PlaylistReadinessViewData) {
  const latest = readiness.latest_assessment;
  if (!latest) return {
    summary: "No JEV shadow assessment recorded for this revision.",
    details: "Run an assessment for an advisory comparison with deterministic readiness checks.",
  };
  const choice = latest.answers?.assessment?.choice;
  const risk = latest.answers?.risk?.label;
  const outcome = latest.observed_outcome ? `Observed outcome: ${humanize(latest.observed_outcome)}.` : "No observed outcome yet.";
  const details = [
    `Deterministic status at assessment: ${statusLabel(latest.deterministic_status ?? "review")}.`,
    risk ? `${humanize(risk)} risk.` : "JEV risk unavailable.",
    outcome,
  ].join(" ");
  return { summary: choice ? `JEV assessment: ${humanize(choice)}.` : "JEV returned no typed assessment.", details };
}

export function createPlaylistReadinessA2uiMessage(readiness: PlaylistReadinessViewData): PlaylistReadinessA2uiMessage {
  const summary = readiness.summary;
  const hasRevision = validPlaylistID(readiness.revision?.playlist_id) && validPlaylistID(readiness.revision?.revision);
  const components: ManagementA2uiComponent[] = [
    a2uiColumn("root", ["statusCard", "summaryCard", "issuesCard", "itemsCard", "devicesCard", "assessmentCard"]),
    a2uiCard("statusCard", "statusContent"),
    a2uiColumn("statusContent", ["readinessTitle", "readinessBadge", "revisionText"]),
    a2uiText("readinessTitle", "/status/title", "body"),
    a2uiBadge("readinessBadge", "/status/label", statusTone(readiness.status)),
    a2uiText("revisionText", "/status/revision"),
    a2uiCard("summaryCard", "summaryContent"),
    a2uiColumn("summaryContent", ["summaryTitle", "summaryItems"]),
    a2uiText("summaryTitle", "/summary/title", "body"),
    a2uiText("summaryItems", "/summary/items"),
    a2uiCard("issuesCard", "issuesContent"),
    a2uiColumn("issuesContent", ["issuesTitle", "blockersText", "warningsText"]),
    a2uiText("issuesTitle", "/issues/title", "body"),
    a2uiText("blockersText", "/issues/blockers"),
    a2uiText("warningsText", "/issues/warnings"),
    a2uiCard("itemsCard", "itemsContent"),
    a2uiColumn("itemsContent", ["itemsTitle", "itemsText"]),
    a2uiText("itemsTitle", "/items/title", "body"),
    a2uiText("itemsText", "/items/summary"),
    a2uiCard("devicesCard", "devicesContent"),
    a2uiColumn("devicesContent", ["devicesTitle", "devicesText"]),
    a2uiText("devicesTitle", "/devices/title", "body"),
    a2uiText("devicesText", "/devices/summary"),
    a2uiCard("assessmentCard", "assessmentContent"),
    a2uiColumn("assessmentContent", ["assessmentTitle", "assessmentSummary", "assessmentDetails", ...(hasRevision ? ["assessReadinessButton"] : [])]),
    a2uiText("assessmentTitle", "/assessment/title", "body"),
    a2uiText("assessmentSummary", "/assessment/summary"),
    a2uiText("assessmentDetails", "/assessment/details"),
  ];
  if (hasRevision) {
    components.push(
      a2uiText("assessReadinessButtonText", "/actions/assess_label"),
      a2uiButton("assessReadinessButton", "assessReadinessButtonText", "assess_readiness", {
        playlist_id: readiness.revision!.playlist_id!,
        revision: readiness.revision!.revision!,
      }),
    );
  }
  const assessment = assessmentSummary(readiness);
  const blockers = (readiness.blockers ?? []).map(humanize);
  const warnings = (readiness.warnings ?? []).map(humanize);
  const freshCaptures = Math.max(0, Math.min(summary.total_captures, summary.fresh_captures));

  return {
    version: "1.0",
    createSurface: {
      surfaceId: SURFACE_ID,
      catalogId: CATALOG_ID,
      sendDataModel: false,
      components,
      dataModel: {
        playlist_id: hasRevision ? readiness.revision!.playlist_id : null,
        revision: hasRevision ? readiness.revision!.revision : null,
        status: {
          title: "Playlist readiness",
          label: statusLabel(readiness.status),
          revision: hasRevision ? `${readiness.revision!.playlist_id} · revision ${readiness.revision!.revision}` : "Revision unavailable",
        },
        summary: {
          title: `Revision contents · ${summary.total_items} items`,
          items: `Fresh captures ${freshCaptures} / ${summary.total_captures} · Missing assets ${summary.missing_assets} · Stale captures ${summary.stale_captures} · Disabled captures ${summary.disabled_captures} · Schedules to review ${summary.unreviewed_schedules} · Devices to update ${summary.devices_to_update}`,
        },
        issues: {
          title: "Deterministic checks",
          blockers: blockers.length ? `Activation blockers: ${boundedList(blockers, "None")}` : "Activation blockers: none",
          warnings: warnings.length ? `Review before activation: ${boundedList(warnings, "None")}` : "Review before activation: none",
        },
        items: { title: "Revision items", summary: readinessItems(readiness) },
        devices: { title: "Devices that would receive this revision", summary: readinessDevices(readiness) },
        assessment: {
          title: "JEV shadow assessment · advisory only",
          summary: assessment.summary,
          details: assessment.details,
        },
        actions: { assess_label: "Run JEV shadow assessment" },
      },
    },
  };
}

export function parsePlaylistReadinessAction(action: A2uiUserAction, readiness: PlaylistReadinessViewData): boolean {
  const context = action?.context;
  const playlistID = readiness.revision?.playlist_id;
  const revision = readiness.revision?.revision;
  return Boolean(action && action.name === "assess_readiness" && action.sourceComponentId === "assessReadinessButton" &&
    validPlaylistID(playlistID) && validPlaylistID(revision) && context &&
    Object.keys(context).length === 2 && context.playlist_id === playlistID && context.revision === revision);
}

export function renderPlaylistReadinessA2ui(
  container: HTMLElement,
  readiness: PlaylistReadinessViewData,
  onAction?: (action: A2uiUserAction) => void | Promise<void>,
  message = createPlaylistReadinessA2uiMessage(readiness),
) {
  const data = message.createSurface?.dataModel;
  if (data?.playlist_id !== (readiness.revision?.playlist_id ?? null) || data?.revision !== (readiness.revision?.revision ?? null)) {
    throw new Error("A2UI playlist readiness must be rendered from the supplied revision");
  }
  container.setAttribute("role", "region");
  container.setAttribute("aria-label", "Playlist readiness");
  renderA2uiMessages(container, [message], { surfaceId: SURFACE_ID, onAction });
}
