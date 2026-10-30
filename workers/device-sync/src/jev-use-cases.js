export const fleetAnalysisQuestions = Object.freeze({
  analysis_status: {
    type: "choice",
    instructions: "What overall attention level do the current Ribbonfish fleet and playlist signals warrant?",
    criteria: {
      routine: "No unusual signal needs operator attention",
      review: "One or more signals should be reviewed soon",
      urgent: "A current signal suggests prompt operator attention",
    },
  },
  focus: {
    type: "choice",
    instructions: "Which area should the operator inspect first based on the supplied signals?",
    criteria: {
      devices: "Device health, connectivity, or playlist sync",
      playlist: "Active playlist or available playlist versions",
      screenshots: "Scheduled screenshots, failures, or freshness",
      assets: "Missing or inconsistent playlist assets",
      none: "No specific area stands out",
    },
  },
  urgency: {
    type: "score",
    instructions: "Rate the operator attention urgency from routine to urgent using the supplied scale.",
    criteria: ["Routine", "Review", "Urgent"],
  },
});

export const captureAssessmentQuestions = Object.freeze({
  recommendation: {
    type: "choice",
    instructions: "Should the operator keep the next screenshot due, or consider skipping this single screenshot opportunity? Use recent content changes and freshness signals. Recommend skip_once only when multiple recent screenshots are unchanged, the current image is fresh, and there are no failures or active jobs. This is advisory and requires explicit human confirmation.",
    criteria: {
      capture_now: "Keep the scheduled capture; freshness, errors, or missing history argue against skipping",
      skip_once: "Consider skipping one screenshot opportunity; the current screenshot appears sufficiently fresh and signals show low risk",
    },
  },
  risk: {
    type: "score",
    instructions: "Rate the risk of skipping this one screenshot opportunity. Consider stale or missing screenshots, recent content changes, failures, and active jobs.",
    criteria: ["Low", "Moderate", "High"],
  },
});

export function buildFleetAnalysisState(overview) {
  const health = { healthy: 0, degraded: 0, stale: 0, offline: 0, unknown: 0, disabled: 0 };
  const agentStates = { ready: 0, starting: 0, degraded: 0, startup_failed: 0, stopping: 0, unknown: 0 };
  const syncStates = { ok: 0, failed: 0, unknown: 0 };
  const playlistSync = { current: 0, behind: 0, unknown: 0 };
  const active = overview?.active_playlist;
  for (const device of overview?.devices ?? []) {
    const status = device.enabled === false || device.enabled === 0 ? "disabled" : device.health?.status ?? "unknown";
    health[Object.hasOwn(health, status) ? status : "unknown"] += 1;
    if (device.enabled === false || device.enabled === 0) continue;
    const agentState = device.health?.reported_state ?? "unknown";
    agentStates[Object.hasOwn(agentStates, agentState) ? agentState : "unknown"] += 1;
    const syncStatus = device.health?.sync_status ?? "unknown";
    syncStates[Object.hasOwn(syncStates, syncStatus) ? syncStatus : "unknown"] += 1;
    if (!active || !device.health?.applied_playlist_id || !device.health?.applied_revision) playlistSync.unknown += 1;
    else if (device.health.applied_playlist_id === active.playlist_id && device.health.applied_revision === active.revision) playlistSync.current += 1;
    else playlistSync.behind += 1;
  }
  const captures = overview?.capture_targets ?? [];
  return JSON.stringify({
    devices: health,
    agent_states: agentStates,
    sync: syncStates,
    playlist: {
      active: Boolean(overview?.active_playlist),
      inactive_versions: (overview?.playlists ?? []).filter((playlist) => !playlist.active).length,
      device_sync: playlistSync,
    },
    assets: {
      missing_active: overview?.asset_health?.missing?.length ?? 0,
      integrity_issues: overview?.asset_health?.integrity_issues?.length ?? 0,
    },
    screenshots: {
      total: captures.length,
      queued_or_running: captures.filter((item) => item.job_status === "queued" || item.job_status === "running").length,
      with_recent_errors: captures.filter((item) => Boolean(item.last_error)).length,
    },
  });
}

export function buildCaptureAssessmentState(target, now = Date.now()) {
  const lastSuccess = Number.isFinite(target.last_success_at) ? target.last_success_at : null;
  const nextDue = Number.isFinite(target.next_due_at) ? target.next_due_at : now;
  const durations = (target.history ?? []).map((item) => item.browser_ms)
    .filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  const midpoint = Math.floor(durations.length / 2);
  const medianBrowserMs = durations.length
    ? durations.length % 2 ? durations[midpoint] : Math.round((durations[midpoint - 1] + durations[midpoint]) / 2)
    : null;
  const recentHashes = (target.history ?? []).slice(0, 10)
    .map((item) => typeof item.sha256 === "string" ? item.sha256 : null);
  let recentContentChangeCount = 0;
  for (let index = 1; index < recentHashes.length; index++) {
    if (recentHashes[index] && recentHashes[index - 1] && recentHashes[index] !== recentHashes[index - 1]) {
      recentContentChangeCount += 1;
    }
  }
  let unchangedCaptureStreak = 0;
  if (recentHashes[0]) {
    for (let index = 1; index < recentHashes.length && recentHashes[index] === recentHashes[0]; index++) {
      unchangedCaptureStreak += 1;
    }
  }
  return JSON.stringify({
    screenshot_age_seconds: lastSuccess === null ? null : Math.max(0, Math.floor((now - lastSuccess) / 1000)),
    configured_interval_seconds: Number.isSafeInteger(target.capture_interval_seconds) ? target.capture_interval_seconds : null,
    seconds_until_due: Math.max(0, Math.floor((nextDue - now) / 1000)),
    consecutive_failures: Number.isSafeInteger(target.failure_count) ? Math.max(0, target.failure_count) : 0,
    recent_job: ["queued", "running"].includes(target.job_status) ? target.job_status : "none",
    recent_error_present: Boolean(target.last_error),
    recent_capture_count: durations.length,
    median_browser_ms: medianBrowserMs,
    recent_content_change_count: recentContentChangeCount,
    unchanged_capture_streak: unchangedCaptureStreak,
  });
}
