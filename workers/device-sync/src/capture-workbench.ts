export interface CaptureHistoryEntry {
  captured_at: number;
  sha256: string | null;
}

export interface CaptureHistorySummary {
  recent_change_count: number;
  unchanged_capture_streak: number;
  recent_history: Array<{ captured_at: number; changed: boolean | null }>;
}

/** Reduce screenshot history to bounded change facts without exposing content hashes. */
export function summarizeCaptureHistory(rows: readonly CaptureHistoryEntry[]): CaptureHistorySummary {
  const recent = rows.slice(0, 10);
  const recentHistory = recent.map((item, index) => {
    const previous = recent[index + 1];
    return {
      captured_at: item.captured_at,
      changed: !previous || !item.sha256 || !previous.sha256 ? null : item.sha256 !== previous.sha256,
    };
  });
  let unchangedCaptureStreak = 0;
  if (recent[0]?.sha256) {
    for (let index = 1; index < recent.length; index += 1) {
      if (recent[index]?.sha256 !== recent[0].sha256) break;
      unchangedCaptureStreak += 1;
    }
  }
  return {
    recent_change_count: recentHistory.filter((item) => item.changed === true).length,
    unchanged_capture_streak: unchangedCaptureStreak,
    recent_history: recentHistory,
  };
}
