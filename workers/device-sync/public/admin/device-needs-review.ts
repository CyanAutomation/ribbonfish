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
  const playlistUnknown = Boolean(activePlaylist && (
    !health.applied_playlist_id || health.applied_revision === null || health.applied_revision === undefined
  ));
  const playlistBehind = Boolean(activePlaylist && health.applied_playlist_id &&
    health.applied_revision !== null && health.applied_revision !== undefined &&
    (health.applied_playlist_id !== activePlaylist.playlist_id ||
      String(health.applied_revision) !== String(activePlaylist.revision)));

  return healthProblem || syncProblem || playlistUnknown || playlistBehind;
}
