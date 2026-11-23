export type PlaylistSyncState = "in_sync" | "behind" | "unreported" | "no_active_revision" | "disabled";

export interface PlaylistSyncDevice {
  enabled?: boolean | number;
  applied_playlist_id?: string | null;
  applied_revision?: string | number | null;
}

export interface PlaylistSyncTarget {
  playlist_id?: string | null;
  revision?: string | number | null;
  effective_revision?: string | number | null;
}

/** Compare a device report with the exact revision delivered to agents when available. */
export function getPlaylistSyncState(
  device: PlaylistSyncDevice,
  active: PlaylistSyncTarget | null | undefined,
): PlaylistSyncState {
  if (device.enabled === false || device.enabled === 0) return "disabled";

  const expectedRevision = active?.effective_revision ?? active?.revision;
  if (!active?.playlist_id || expectedRevision === undefined || expectedRevision === null) return "no_active_revision";
  if (!device.applied_playlist_id || device.applied_revision === undefined || device.applied_revision === null) {
    return "unreported";
  }

  return device.applied_playlist_id === active.playlist_id && String(device.applied_revision) === String(expectedRevision)
    ? "in_sync"
    : "behind";
}
