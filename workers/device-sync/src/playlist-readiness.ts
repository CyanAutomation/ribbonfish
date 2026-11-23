export type PlaylistReadinessStatus = "ready" | "review" | "blocked";
export type PlaylistSyncState = "in_sync" | "behind" | "unreported";

export interface PlaylistReadinessInput {
  revision: { playlist_id: string; revision: string };
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
  revision: { playlist_id: string; revision: string };
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
  devices_to_update: Array<{ device_id: string; sync_status: PlaylistSyncState }>;
}

/** Deterministic readiness checks are authoritative; JEV can only annotate them. */
export function assessPlaylistReadiness(input: PlaylistReadinessInput): PlaylistReadinessResult {
  const missingAssets = input.assets.filter((asset) => !asset.present).length +
    input.captures.filter((capture) => !capture.asset_present).length;
  const staleCaptures = input.captures.filter((capture) => !capture.fresh).length;
  const disabledCaptures = input.captures.filter((capture) => !capture.enabled).length;
  const unreviewedSchedules = input.captures.filter((capture) => !capture.schedule_reviewed && capture.enabled).length;
  const devicesToUpdate = input.devices.filter((device) => device.enabled && !(
    device.applied_playlist_id === input.revision.playlist_id &&
    device.applied_revision !== null && String(device.applied_revision) === input.revision.revision
  )).map((device) => ({
    device_id: device.device_id,
    sync_status: !device.applied_playlist_id || device.applied_revision === null ? "unreported" as const : "behind" as const,
  }));
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
