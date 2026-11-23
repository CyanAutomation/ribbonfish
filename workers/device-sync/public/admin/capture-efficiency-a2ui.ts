import type { CaptureDurationSummary } from "../../src/capture-duration.ts";
import { formatRunTime } from "./capture-presentation.ts";
import {
  a2uiColumn,
  a2uiMetricCardComponents,
  type ManagementA2uiComponent,
} from "./a2ui-components.ts";
import { renderA2uiMessages } from "./fleet-overview.ts";

const SURFACE_ID = "captureEfficiency";
const CATALOG_ID = "https://ribbonfish.dev/a2ui/catalogs/management-v2.json";

type CountSummary = Partial<Record<string, number | null | undefined>>;

export interface CaptureEfficiencyA2uiTarget {
  capture_type?: string;
  duration_summary?: Pick<CaptureDurationSummary, "reserve_review"> | null;
}

export interface CaptureEfficiencyA2uiSummary {
  last_30_days?: {
    browser_run_ms?: { response_header?: number | null; reserve?: number | null };
    jev_shadow_assessments?: number | null;
    jev_candidate_deferrals?: number | null;
    jev_candidate_changed?: number | null;
    jev_candidate_unchanged?: number | null;
    jev_candidate_validator_unchanged?: number | null;
    jev_candidate_failed?: number | null;
    jev_candidate_budget_deferred?: number | null;
    jev_candidate_unobserved?: number | null;
    jev_candidate_quality_reviews?: CountSummary;
    screenshot_quality_reviews?: CountSummary;
  };
}

export interface CaptureEfficiencyA2uiMetric {
  label: string;
  value: string;
  detail: string;
}

export interface CaptureEfficiencyA2uiMessage {
  version: "1.0";
  createSurface: {
    surfaceId: string;
    catalogId: string;
    sendDataModel: false;
    components: ManagementA2uiComponent[];
    dataModel: { metrics: CaptureEfficiencyA2uiMetric[] };
  };
}

const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;

function buildMetrics(targets: readonly CaptureEfficiencyA2uiTarget[], summary: CaptureEfficiencyA2uiSummary): CaptureEfficiencyA2uiMetric[] {
  const recent = summary.last_30_days ?? {};
  const browserRun = recent.browser_run_ms ?? {};
  const candidateReviews = recent.jev_candidate_quality_reviews ?? {};
  const screenshotReviews = recent.screenshot_quality_reviews ?? {};
  const reviewedTotal = count(candidateReviews.total) ||
    count(candidateReviews.complete) + count(candidateReviews.incomplete) + count(candidateReviews.uncertain);
  const reserveReviewCounts = targets.reduce((counts, target) => {
    if (target.capture_type === "api-dashboard") return counts;
    const state = target.duration_summary?.reserve_review;
    if (state === "possible_overestimate") counts.overestimate += 1;
    else if (state === "possible_underestimate") counts.underestimate += 1;
    else if (state === "not_flagged") counts.notFlagged += 1;
    else counts.insufficient += 1;
    return counts;
  }, { overestimate: 0, underestimate: 0, insufficient: 0, notFlagged: 0 });

  return [
    {
      label: "Browser Run time sources",
      value: `Measured ${formatRunTime(browserRun.response_header)} · reserve-estimated ${formatRunTime(browserRun.reserve)}`,
      detail: "Last 30 days. Measured and reserve-estimated time are reported separately.",
    },
    {
      label: "JEV capture advice",
      value: `${count(recent.jev_shadow_assessments)} assessments · ${count(recent.jev_candidate_deferrals)} skip suggestions`,
      detail: `Changed ${count(recent.jev_candidate_changed)} · unchanged ${count(recent.jev_candidate_unchanged)} · validator-only ${count(recent.jev_candidate_validator_unchanged)} · failed ${count(recent.jev_candidate_failed)} · budget-deferred ${count(recent.jev_candidate_budget_deferred)} · unobserved ${count(recent.jev_candidate_unobserved)}. Schedule changes: none.`,
    },
    {
      label: "Reviewed JEV suggestions",
      value: reviewedTotal
        ? `${reviewedTotal} reviewed screenshot${reviewedTotal === 1 ? "" : "s"}`
        : "No reviewed screenshots from JEV skip suggestions yet",
      detail: `Complete ${count(candidateReviews.complete)} · incomplete ${count(candidateReviews.incomplete)} · uncertain ${count(candidateReviews.uncertain)}. These labels belong to screenshots captured for a JEV skip suggestion.`,
    },
    {
      label: "Screenshot quality reviews",
      value: `Complete ${count(screenshotReviews.complete)} · incomplete ${count(screenshotReviews.incomplete)} · uncertain ${count(screenshotReviews.uncertain)}`,
      detail: "Human reviews recorded in the last 30 days.",
    },
    {
      label: "Reserve review cues",
      value: `${reserveReviewCounts.overestimate} possible overestimate · ${reserveReviewCounts.underestimate} possible underestimate`,
      detail: `${reserveReviewCounts.insufficient} ${reserveReviewCounts.insufficient === 1 ? "site needs" : "sites need"} more measured data; ${reserveReviewCounts.notFlagged} ${reserveReviewCounts.notFlagged === 1 ? "site is" : "sites are"} not flagged. Cues do not change settings.`,
    },
  ];
}

function buildComponents(metricCount: number): ManagementA2uiComponent[] {
  const ids = ["runtime", "jev", "reviewedJev", "screenshotReviews", "reserve"];
  const components: ManagementA2uiComponent[] = [
    a2uiColumn("root", ids.slice(0, metricCount).map((id) => `${id}Card`)),
  ];
  ids.slice(0, metricCount).forEach((id, index) => {
    components.push(...a2uiMetricCardComponents(id, index));
  });
  return components;
}

export function createCaptureEfficiencyA2uiMessage(
  targets: readonly CaptureEfficiencyA2uiTarget[] = [],
  summary: CaptureEfficiencyA2uiSummary = {},
): CaptureEfficiencyA2uiMessage {
  const metrics = buildMetrics(targets, summary);
  return {
    version: "1.0",
    createSurface: {
      surfaceId: SURFACE_ID,
      catalogId: CATALOG_ID,
      sendDataModel: false,
      components: buildComponents(metrics.length),
      dataModel: { metrics },
    },
  };
}

export function renderCaptureEfficiencyA2ui(
  container: HTMLElement,
  targets: readonly CaptureEfficiencyA2uiTarget[] = [],
  summary: CaptureEfficiencyA2uiSummary = {},
) {
  renderCaptureEfficiencyA2uiMessage(container, createCaptureEfficiencyA2uiMessage(targets, summary));
}

export function renderCaptureEfficiencyA2uiMessage(container: HTMLElement, message: CaptureEfficiencyA2uiMessage) {
  renderA2uiMessages(container, [message], { surfaceId: SURFACE_ID });
}
