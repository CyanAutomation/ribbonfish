export interface CaptureObservation {
  observed_result?: string | null;
  observed_delay_ms?: number | null;
}

export function formatRunTime(milliseconds: unknown) {
  const seconds = Math.max(0, Math.round((Number(milliseconds) || 0) / 1000));
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function formatCaptureObservation(decision: CaptureObservation) {
  const delay = Number.isFinite(decision.observed_delay_ms)
    ? ` ${formatRunTime(decision.observed_delay_ms)} after due time.` : "";
  switch (decision.observed_result) {
    case "changed": return `The scheduled screenshot changed content.${delay}`;
    case "unchanged": return `The scheduled screenshot matched the previous image.${delay}`;
    case "validator_unchanged": return "HTTP validators indicated no change; no screenshot was taken to verify the image.";
    case "failed": return `The scheduled screenshot failed.${delay}`;
    case "budget_deferred": return "Browser Run budget delayed the scheduled screenshot; no content result is available yet.";
    default: return "The scheduled screenshot outcome has not been recorded yet.";
  }
}
