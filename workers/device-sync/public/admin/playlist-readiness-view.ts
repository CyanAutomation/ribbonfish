import { node } from "./ui-primitives.ts";
import {
  parsePlaylistReadinessAction,
  renderPlaylistReadinessA2ui,
} from "./playlist-readiness-a2ui.ts";
import type { A2uiUserAction } from "./fleet-overview.ts";

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

export function renderPlaylistReadiness(
  readiness: PlaylistReadinessViewData,
  options: PlaylistReadinessViewOptions = {},
) {
  const ownerDocument = options.ownerDocument ?? document;
  const panel = node("div", undefined, "playlist-readiness", ownerDocument);
  const onAction = options.onAssess
    ? (action: A2uiUserAction) => parsePlaylistReadinessAction(action, readiness) ? options.onAssess?.() : undefined
    : undefined;
  renderPlaylistReadinessA2ui(panel, readiness, onAction);
  return panel;
}
