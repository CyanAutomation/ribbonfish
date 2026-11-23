export type PlaylistReadinessStatus = "ready" | "review" | "blocked";
import { getPlaylistSyncState, type PlaylistSyncState as SharedPlaylistSyncState } from "./playlist-sync-state.ts";

type ReadinessSyncState = Extract<SharedPlaylistSyncState, "in_sync" | "behind" | "unreported">;

export interface PlaylistReadinessInput {
  revision: { playlist_id: string; revision: string; effective_revision?: string };
  assets: Array<{ position: number; present: boolean }>;
  captures: Array<{
    capture_id: string;
    fresh: boolean;
    enabled: boolean;
    schedule_reviewed: boolean;
    asset_present: boolean;
  }>;
  devices: Array<{
    device_id: string;
    enabled: boolean;
    applied_playlist_id: string | null;
    applied_revision: string | number | null;
  }>;
}

export interface PlaylistReadinessResult {
  revision: { playlist_id: string; revision: string; effective_revision?: string };
  status: PlaylistReadinessStatus;
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
  items: Array<{ label: string; status: "ready" | "missing" | "stale" | "disabled" | "review" }>;
  devices_to_update: Array<{ device_id: string; sync_status: ReadinessSyncState }>;
}

/** Deterministic readiness checks are authoritative; JEV can only annotate them. */
export function assessPlaylistReadiness(input: PlaylistReadinessInput): PlaylistReadinessResult {
  const missingAssets = input.assets.filter((asset) => !asset.present).length +
    input.captures.filter((capture) => !capture.asset_present).length;
  const staleCaptures = input.captures.filter((capture) => capture.enabled && !capture.fresh).length;
  const disabledCaptures = input.captures.filter((capture) => !capture.enabled).length;
  const unreviewedSchedules = input.captures.filter((capture) => !capture.schedule_reviewed && capture.enabled).length;
  const devicesToUpdate = input.devices.flatMap((device) => {
    if (!device.enabled) return [];
    const syncState = getPlaylistSyncState(device, input.revision);
    if (syncState === "in_sync" || syncState === "no_active_revision" || syncState === "disabled") return [];
    return [{ device_id: device.device_id, sync_status: syncState }];
  });
  const blockers = [
    ...(missingAssets ? ["missing_assets"] : []),
    ...(disabledCaptures ? ["disabled_captures"] : []),
  ];
  const warnings = [
    ...(staleCaptures ? ["stale_captures"] : []),
    ...(unreviewedSchedules ? ["unreviewed_schedules"] : []),
  ];
  const items = [
    ...input.assets.map((asset, index) => ({
      label: `Image ${index + 1}`,
      status: asset.present ? "ready" as const : "missing" as const,
    })),
    ...input.captures.map((capture, index) => ({
      label: `Capture ${index + 1}`,
      status: !capture.enabled ? "disabled" as const
        : !capture.asset_present ? "missing" as const
          : !capture.fresh ? "stale" as const
            : !capture.schedule_reviewed ? "review" as const : "ready" as const,
    })),
  ];

  return {
    revision: input.revision,
    status: blockers.length ? "blocked" : warnings.length ? "review" : "ready",
    summary: {
      total_items: input.assets.length + input.captures.length,
      total_captures: input.captures.length,
      fresh_captures: input.captures.filter((capture) => capture.fresh).length,
      missing_assets: missingAssets,
      stale_captures: staleCaptures,
      disabled_captures: disabledCaptures,
      unreviewed_schedules: unreviewedSchedules,
      devices_to_update: devicesToUpdate.length,
    },
    blockers,
    warnings,
    items,
    devices_to_update: devicesToUpdate,
  };
}
