export interface CaptureObservation {
  observed_result?: string | null;
  observed_delay_ms?: number | null;
}

export interface JevCaptureOutcomeMetrics {
  jev_shadow_assessments?: number | null;
  jev_candidate_deferrals?: number | null;
  jev_candidate_changed?: number | null;
  jev_candidate_unchanged?: number | null;
  jev_candidate_validator_unchanged?: number | null;
  jev_candidate_budget_deferred?: number | null;
  jev_candidate_failed?: number | null;
  jev_candidate_unobserved?: number | null;
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

export function formatJevCaptureOutcomeSummary(metrics: JevCaptureOutcomeMetrics = {}) {
  const count = (value: number | null | undefined) => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
  const label = (value: number, singular: string, plural = `${singular}s`) => `${value} ${value === 1 ? singular : plural}`;
  const assessments = count(metrics.jev_shadow_assessments);
  const deferrals = count(metrics.jev_candidate_deferrals);

  return `Scheduled JEV made ${label(assessments, "shadow assessment")}. Among ${label(deferrals, "defer suggestion")}: ` +
    `${label(count(metrics.jev_candidate_changed), "changed screenshot")}, ` +
    `${label(count(metrics.jev_candidate_unchanged), "unchanged screenshot")}, ` +
    `${label(count(metrics.jev_candidate_validator_unchanged), "validator-only result")}, ` +
    `${label(count(metrics.jev_candidate_budget_deferred), "budget deferral")}, ` +
    `${label(count(metrics.jev_candidate_failed), "failed capture")}, ` +
    `${label(count(metrics.jev_candidate_unobserved), "unobserved outcome")}. Schedules were unchanged.`;
}
