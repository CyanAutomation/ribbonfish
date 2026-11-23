import { formatRunTime } from "./capture-presentation.ts";
import { renderA2uiMessages, type A2uiUserAction } from "./fleet-overview.ts";

const SURFACE_ID = "captureWorkbench";
const CATALOG_ID = "https://ribbonfish.dev/a2ui/catalogs/management-v2.json";

export interface CaptureWorkbenchSite {
  capture_id: string;
  name?: string | null;
  display_url?: string;
  next_due_at?: number | null;
  last_success_at?: number | null;
  screenshot_age_seconds?: number | null;
  recent_change_count?: number;
  unchanged_capture_streak?: number;
  recent_history?: Array<{ captured_at: number; changed: boolean | null }>;
  duration_summary?: {
    total_samples?: number;
    measured_sample_count?: number;
    reserve_estimated_sample_count?: number;
    measured_p50_ms?: number | null;
    measured_p90_ms?: number | null;
    reserve_estimated_p50_ms?: number | null;
    reserve_estimated_p90_ms?: number | null;
    failed_attempt_count?: number;
    retry_attempt_count?: number;
  } | null;
}

export interface CaptureWorkbenchDecision {
  action?: string;
  reason?: string;
  duration_review?: string;
  suggestion?: string;
  risk?: { score: number; label: string; confidence?: number } | null;
  observed_result?: string | null;
  observed_at?: number | null;
  skip_eligibility?: { eligible?: boolean; due_at?: number | null; reason?: string };
}

export type CaptureWorkbenchActionResult = { kind: "assess" } | { kind: "confirm_skip_once"; due_at: number };

/** Recheck action context in the view layer before any management request is sent. */
export function parseCaptureWorkbenchAction(
  action: A2uiUserAction,
  site: CaptureWorkbenchSite,
  decision?: CaptureWorkbenchDecision,
): CaptureWorkbenchActionResult | null {
  if (!action || !action.context || action.context.capture_id !== site.capture_id) return null;
  const keys = Object.keys(action.context);
  if (action.name === "assess_capture" && action.sourceComponentId === "assessButton" &&
    keys.length === 1 && keys[0] === "capture_id") return { kind: "assess" };
  const dueAt = action.context.due_at;
  if (action.name === "confirm_skip_once" && action.sourceComponentId === "confirmSkipButton" &&
    keys.length === 2 && keys.includes("capture_id") && keys.includes("due_at") &&
    Number.isSafeInteger(dueAt) && decision?.suggestion === "skip_once" &&
    decision.skip_eligibility?.eligible === true && dueAt === decision.skip_eligibility.due_at) {
    return { kind: "confirm_skip_once", due_at: dueAt as number };
  }
  return null;
}

export interface CaptureWorkbenchA2uiMessage {
  version: "1.0";
  createSurface: {
    surfaceId: string;
    catalogId: string;
    sendDataModel: false;
    components: Array<Record<string, unknown>>;
    dataModel: Record<string, unknown>;
  };
}

function binding(path: string) {
  return { "@path": path };
}

function valueText(id: string, path: string, variant: "caption" | "body" = "caption") {
  return { id, component: "Text", variant, text: binding(path) };
}

function card(id: string, child: string) {
  return { id, component: "Card", child };
}

function column(id: string, children: string[]) {
  return { id, component: "Column", children };
}

function button(id: string, textId: string, event: string, context: Record<string, unknown>) {
  return {
    id,
    component: "Button",
    child: textId,
    action: { event: { name: event, context } },
  };
}

function formatAge(seconds: number | null | undefined) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "No successful screenshot yet";
  return formatRunTime(seconds * 1000);
}

function formatDuration(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? formatRunTime(value) : "Unavailable";
}

function formatHistory(site: CaptureWorkbenchSite) {
  const entries = site.recent_history ?? [];
  if (!entries.length) return "No screenshot change history recorded.";
  return entries.map(({ captured_at, changed }) => {
    const timestamp = new Date(captured_at).toLocaleString();
    return `${timestamp}: ${changed === true ? "content changed" : changed === false ? "unchanged" : "change unknown"}`;
  }).join(" · ");
}

function formatDecision(decision: CaptureWorkbenchDecision | undefined) {
  if (!decision) return {
    suggestion: "No scheduled JEV assessment recorded.",
    risk: "Risk unavailable",
    reason: "",
    outcome: "No outcome recorded",
    durationReview: "No JEV reserve review suggestion.",
  };
  const suggestion = decision.suggestion === "skip_once" ? "JEV suggested considering one skip"
    : decision.suggestion === "capture_now" ? "JEV suggested keeping the scheduled capture"
      : decision.action === "error" ? "JEV assessment unavailable" : "JEV suggested keeping the scheduled capture";
  const risk = decision.risk ? `${decision.risk.label} skip risk` : "Risk unavailable";
  const outcome = decision.observed_result
    ? `Observed outcome: ${decision.observed_result}${Number.isSafeInteger(decision.observed_at) ? ` at ${new Date(decision.observed_at!).toLocaleString()}` : ""}`
    : "Outcome not observed yet";
  const durationReview = decision.duration_review === "review_overestimate" ? "JEV suggests reviewing a possible Browser Run reserve overestimate."
    : decision.duration_review === "review_underestimate" ? "JEV suggests reviewing a possible Browser Run reserve underestimate."
      : "No JEV reserve review suggestion.";
  return { suggestion, risk, reason: decision.reason ?? "", outcome, durationReview };
}

export function createCaptureWorkbenchA2uiMessage(
  site: CaptureWorkbenchSite,
  decision?: CaptureWorkbenchDecision,
): CaptureWorkbenchA2uiMessage {
  const duration = site.duration_summary;
  const assessment = formatDecision(decision);
  const components: Array<Record<string, unknown>> = [
    column("root", ["siteCard", "durationCard", "historyCard", "decisionCard", "assessButton"]),
    card("siteCard", "siteContent"),
    column("siteContent", ["siteTitle", "siteDue", "siteAge", "siteChanges"]),
    valueText("siteTitle", "/site/title", "body"),
    valueText("siteDue", "/site/next_due"),
    valueText("siteAge", "/site/screenshot_age"),
    valueText("siteChanges", "/site/change_summary"),
    card("durationCard", "durationContent"),
    column("durationContent", ["durationTitle", "durationMeasured", "durationEstimated", "durationFailures"]),
    valueText("durationTitle", "/duration/title", "body"),
    valueText("durationMeasured", "/duration/measured"),
    valueText("durationEstimated", "/duration/estimated"),
    valueText("durationFailures", "/duration/failures"),
    card("historyCard", "historyContent"),
    column("historyContent", ["historyTitle", "historyItems"]),
    valueText("historyTitle", "/history/title", "body"),
    valueText("historyItems", "/history/items"),
    card("decisionCard", "decisionContent"),
    column("decisionContent", ["decisionTitle", "decisionSuggestion", "decisionRisk", "decisionDurationReview", "decisionReason", "decisionOutcome"]),
    valueText("decisionTitle", "/decision/title", "body"),
    valueText("decisionSuggestion", "/decision/suggestion"),
    valueText("decisionRisk", "/decision/risk"),
    valueText("decisionDurationReview", "/decision/duration_review"),
    valueText("decisionReason", "/decision/reason"),
    valueText("decisionOutcome", "/decision/outcome"),
    valueText("assessButtonText", "/actions/assess_label"),
    button("assessButton", "assessButtonText", "assess_capture", { capture_id: site.capture_id }),
  ];
  if (decision?.suggestion === "skip_once" && decision.skip_eligibility?.eligible === true &&
    Number.isSafeInteger(decision.skip_eligibility.due_at)) {
    (components[0]?.children as string[] | undefined)?.push("confirmSkipButton");
    components.push(
      valueText("confirmSkipButtonText", "/actions/skip_label"),
      button("confirmSkipButton", "confirmSkipButtonText", "confirm_skip_once", {
        capture_id: site.capture_id,
        due_at: decision.skip_eligibility.due_at,
      }),
    );
  }

  return {
    version: "1.0",
    createSurface: {
      surfaceId: SURFACE_ID,
      catalogId: CATALOG_ID,
      sendDataModel: false,
      components,
      dataModel: {
        capture_id: site.capture_id,
        skip_eligible: decision?.suggestion === "skip_once" && decision.skip_eligibility?.eligible === true,
        skip_due_at: decision?.skip_eligibility?.due_at ?? null,
        site: {
          title: site.name || site.display_url || "Screenshot site",
          next_due: Number.isSafeInteger(site.next_due_at) ? `Next due ${new Date(site.next_due_at!).toLocaleString()}` : "Next due unavailable",
          screenshot_age: `Screenshot age: ${formatAge(site.screenshot_age_seconds)}`,
          change_summary: `${site.recent_change_count ?? 0} recent content changes · ${site.unchanged_capture_streak ?? 0} unchanged captures in a row`,
        },
        duration: {
          title: "Browser Run duration evidence",
          measured: `Measured: p50 ${formatDuration(duration?.measured_p50_ms)} · p90 ${formatDuration(duration?.measured_p90_ms)} · ${duration?.measured_sample_count ?? 0} samples`,
          estimated: `Estimated reserve duration: p50 ${formatDuration(duration?.reserve_estimated_p50_ms)} · p90 ${formatDuration(duration?.reserve_estimated_p90_ms)} · ${duration?.reserve_estimated_sample_count ?? 0} samples; estimates are not measured runtimes`,
          failures: `Failures ${duration?.failed_attempt_count ?? 0} · retries ${duration?.retry_attempt_count ?? 0} · ${duration?.total_samples ?? 0} attempts`,
        },
        history: { title: "Recent screenshot change history", items: formatHistory(site) },
        decision: {
          title: "Latest scheduled JEV assessment",
          suggestion: assessment.suggestion,
          risk: assessment.risk,
          duration_review: assessment.durationReview,
          reason: assessment.reason,
          outcome: assessment.outcome,
        },
        actions: { assess_label: "Assess current screenshot signals", skip_label: "Confirm one-time skip" },
      },
    },
  };
}

export function renderCaptureWorkbenchA2ui(
  container: HTMLElement,
  site: CaptureWorkbenchSite,
  decision?: CaptureWorkbenchDecision,
  onAction?: (action: A2uiUserAction) => void | Promise<void>,
) {
  renderCaptureWorkbenchA2uiMessage(container, site, createCaptureWorkbenchA2uiMessage(site, decision), onAction);
}

export function renderCaptureWorkbenchA2uiMessage(
  container: HTMLElement,
  site: CaptureWorkbenchSite,
  message: CaptureWorkbenchA2uiMessage,
  onAction?: (action: A2uiUserAction) => void | Promise<void>,
) {
  if (message.createSurface?.dataModel?.capture_id !== site.capture_id) {
    throw new Error("A2UI capture workbench must be rendered from the supplied target");
  }
  renderA2uiMessages(container, [message], { surfaceId: SURFACE_ID, onAction });
}
