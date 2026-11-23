import { getPlaylistSyncState } from "../../src/playlist-sync-state.ts";

interface DeviceHealthForReview {
  status?: string | null;
  sync_status?: string | null;
  applied_playlist_id?: string | null;
  applied_revision?: string | number | null;
}

interface DeviceForReview {
  enabled?: boolean;
  health?: DeviceHealthForReview | null;
}

interface ActivePlaylistForReview {
  playlist_id: string;
  revision: string | number;
  effective_revision?: string | number;
}

/** True when an enabled device needs an operator to inspect its health or playback state. */
export function deviceNeedsReview(
  device: DeviceForReview,
  activePlaylist: ActivePlaylistForReview | null | undefined,
): boolean {
  if (!device.enabled) return false;

  const health = device.health ?? {};
  const healthProblem = ["degraded", "stale", "offline", "unknown"].includes(health.status ?? "unknown");
  const syncProblem = health.sync_status !== "ok";
  const playlistSyncState = getPlaylistSyncState({
    enabled: device.enabled,
    applied_playlist_id: health.applied_playlist_id,
    applied_revision: health.applied_revision,
  }, activePlaylist);
  const playlistUnknown = playlistSyncState === "unreported";
  const playlistBehind = playlistSyncState === "behind";

  return healthProblem || syncProblem || playlistUnknown || playlistBehind;
}
