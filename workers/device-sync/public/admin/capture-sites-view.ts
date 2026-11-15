import { api } from "./api.ts";
import { requiredElement, requiredElements } from "./dom.ts";
import { formatCaptureObservation } from "./capture-presentation.ts";
import {
  actionDisclosure,
  beginButtonBusy,
  button,
  createFormField,
  createSettingsGroup,
  node,
  statusBadge,
} from "./ui-primitives.ts";
import { createActionGroup } from "./ui-components.ts";
import { formatTimestamp } from "./admin-formatters.ts";
import {
  compactIdentifier,
  confirmBeforeAction,
  formatCaptureInterval,
  formatScreenshotStatus,
  prioritizeCaptureTargets,
  summarizeCaptureErrors,
} from "./ui-utils.ts";

type CaptureTargetRendererOptions = {
  getCaptureIntervalOptions: () => Array<{ label: string; value: number }>;
  filterCaptureTargets: () => void;
  showMessage: (message: string, isError?: boolean, section?: string) => void;
  refresh: () => Promise<unknown>;
  showConfirmDialog: (options: any) => Promise<boolean>;
  renderJevDecision: (decision: any, title: string, options: any) => Node;
};

export function createCaptureTargetRenderer(options: CaptureTargetRendererOptions) {
  const { showMessage, refresh, showConfirmDialog, renderJevDecision, getCaptureIntervalOptions } = options;
  const state = { openCaptureID: null as string | null };
  return function renderCaptureTargets(targets: any[], decisions: any[] = []) {


  const decisionByTarget = new Map(decisions.map((decision) => [decision.capture_id, decision]));
  const container = requiredElement(document, "#capture-target-list");
  container.replaceChildren();
  if (!targets.length) {
    container.append(node("p", "No capture sites yet. Add a site above to configure its screenshot schedule.", "muted"));
    return;
  }
  const repeatedErrors = summarizeCaptureErrors(targets);
  if (repeatedErrors.length) {
    const summary = node("section", undefined, "alert alert--warning capture-issues");
    summary.append(node("h3", "Shared screenshot issues"));
    const list = node("ul");
    repeatedErrors.forEach(({ message, count }) => list.append(node("li", `${count} sites: ${message}`)));
    summary.append(list);
    container.append(summary);
  }
  prioritizeCaptureTargets(targets).forEach((target) => {
    container.append(renderCaptureTargetCard(target, repeatedErrors, decisionByTarget, container, state, options));
  });
  options.filterCaptureTargets();

  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}


type CaptureRendererState = { openCaptureID: string | null };

function renderCaptureTargetCard(
  target: any,
  repeatedErrors: Array<{ message: string; count: number }>,
  decisionByTarget: Map<string, any>,
  container: HTMLElement,
  state: CaptureRendererState,
  options: CaptureTargetRendererOptions,
) {
  const siteName = target.name || target.display_url;
  const card = node("article", undefined, "capture-target");
  card.dataset.search = `${target.name ?? ""} ${target.display_url}`.toLocaleLowerCase();
  card.dataset.filter = target.last_error || !target.schedule_reviewed || !target.last_success_at ? "attention" : "ready";
  const preview = node("img", undefined, "capture-target__preview");
  preview.src = `/admin/api/assets/${target.sha256}`;
  preview.alt = `Latest screenshot or placeholder image for ${target.display_url}`;
  preview.loading = "lazy";
  preview.decoding = "async";
  preview.addEventListener("error", () => { preview.hidden = true; }, { once: true });

  const content = node("div", undefined, "capture-target__content");
  content.append(renderCaptureTargetSummary(target, siteName, repeatedErrors));
  content.append(renderCaptureTargetDetails(
    target, siteName, decisionByTarget.get(target.capture_id), container, state, options,
  ));
  card.append(preview, content);
  return card;
}

function renderCaptureTargetSummary(target: any, siteName: string, repeatedErrors: Array<{ message: string; count: number }>) {
  const content = node("div");
  const heading = node("div", undefined, "capture-target__heading");
  heading.append(node("h3", siteName));
  const screenshotStatus = formatScreenshotStatus(target.job_status, target.last_error, target.last_success_at);
  heading.append(statusBadge(screenshotStatus.label, screenshotStatus.tone));
  if (!target.schedule_reviewed) heading.append(statusBadge("Schedule review needed", "warning"));
  content.append(heading);
  content.append(node("p", target.last_success_at
    ? `Last successful capture ${formatTimestamp(target.last_success_at)}`
    : "No screenshot is ready yet.", "muted"));
  content.append(node("p", `${formatCaptureInterval(target.capture_interval_seconds)} · ${target.viewport.width} × ${target.viewport.height} px`, "muted"));
  if (target.last_error && !repeatedErrors.some((issue) => issue.message === target.last_error)) {
    content.append(node("p", `Screenshot error: ${target.last_error}`, "capture-target__error error-title"));
  }
  return content;
}

function renderCaptureTargetDetails(
  target: any,
  siteName: string,
  backgroundDecision: any,
  container: HTMLElement,
  state: CaptureRendererState,
  options: CaptureTargetRendererOptions,
) {
  const detail = node("details", undefined, "capture-target__panel");
  detail.open = state.openCaptureID === target.capture_id;
  detail.addEventListener("toggle", () => {
    if (detail.open) {
      state.openCaptureID = target.capture_id;
      for (const other of requiredElements<HTMLDetailsElement>(container, ".capture-target__panel[open]")) {
        if (other !== detail) other.open = false;
      }
    } else if (state.openCaptureID === target.capture_id) state.openCaptureID = null;
  });
  detail.append(node("summary", "View details"));
  const detailContent = node("div", undefined, "capture-target__panel-content");
  detailContent.append(node("p", target.display_url, "capture-target__url muted"));
  detailContent.append(createSiteNameSection(target, options));

  const schedule = createScheduleSettings(target, options);
  const readiness = createReadinessSettings(target, options);
  if (target.last_error) detailContent.append(node("p", `Screenshot error: ${target.last_error}`, "error-title"));
  if (Number.isSafeInteger(target.next_due_at)) {
    detailContent.append(node("p", `Next screenshot ${formatTimestamp(target.next_due_at)}`, "muted"));
  }
  const assessmentSummary = formatBackgroundAssessment(backgroundDecision);
  if (assessmentSummary) schedule.dataset.assessment = assessmentSummary;
  detailContent.append(schedule, readiness);

  const capture = createScreenshotAction(target, options);
  const remove = createRemoveSiteAction(target, options);
  const assessment = createAssessmentDisclosure(target, assessmentSummary, options);
  detailContent.prepend(createActionGroup([capture, actionDisclosure(`More actions for ${siteName}`, [remove])], {
    label: `Actions for capture site ${siteName}`,
    className: "action-row",
    ownerDocument: document,
  }));
  detailContent.append(assessment);
  detail.append(detailContent);
  return detail;
}

function createSiteNameSection(target: any, options: CaptureTargetRendererOptions) {
  const section = createSettingsGroup("Site name", {
    headingLevel: "h4",
    className: "capture-detail-section",
    description: "Give this capture site a short label used in lists and forecasts.",
    ownerDocument: document,
  });
  const input = node("input", undefined, "field-control");
  input.type = "text";
  input.maxLength = 120;
  input.value = target.name ?? "";
  input.dataset.siteName = "true";
  const save = button("Save name", "secondary");
  const feedback = createInlineFeedback();
  const field = createFormField("Name (optional)", input, { description: "Up to 120 characters.", ownerDocument: document });
  save.addEventListener("click", async () => {
    const finishBusy = beginButtonBusy(save, "Saving name…", feedback);
    try {
      await api(`/admin/api/captures/${encodeURIComponent(target.capture_id)}/name`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: input.value }),
      });
      options.showMessage("Site name updated.", false, "sites");
      await options.refresh();
    } catch (error) { options.showMessage(errorMessage(error), true, "sites"); }
    finally { finishBusy(); }
  });
  section.content.append(field.element, save, feedback);
  return section.element;
}

function createScheduleSettings(target: any, options: CaptureTargetRendererOptions) {
  const metadata = node("details", undefined, "capture-target__details");
  metadata.append(node("summary", "Schedule and settings"));
  metadata.append(node("p", `${formatCaptureInterval(target.capture_interval_seconds)} · ${target.viewport.width} × ${target.viewport.height} px`, "muted"));
  metadata.append(node("p", "This schedule is shared by every playlist that uses this page at the same screenshot size.", "field-hint"));
  const select = node("select");
  select.className = "field-control";
  for (const option of options.getCaptureIntervalOptions()) {
    const item = node("option", option.label);
    item.value = String(option.value);
    item.selected = option.value === target.capture_interval_seconds;
    select.append(item);
  }
  const field = createFormField("Screenshot interval", select, {
    description: "This schedule is shared by playlists using the same site and screenshot size.",
    ownerDocument: document,
  });
  const save = button(target.schedule_reviewed ? "Save screenshot schedule" : "Confirm schedule", "secondary");
  const feedback = createInlineFeedback();
  save.addEventListener("click", async () => {
    const finishBusy = beginButtonBusy(save, "Saving schedule…", feedback);
    try {
      await api(`/admin/api/captures/${encodeURIComponent(target.capture_id)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capture_interval_seconds: Number(select.value) }),
      });
      options.showMessage(target.schedule_reviewed
        ? "Screenshot schedule updated."
        : "Screenshot schedule reviewed. This site can now be added to playlists.", false, "sites");
      await options.refresh();
    } catch (error) { options.showMessage(errorMessage(error), true, "sites"); }
    finally { finishBusy(); }
  });
  metadata.append(field.element, save, feedback);
  return metadata;
}

function createReadinessSettings(target: any, options: CaptureTargetRendererOptions) {
  const advanced = node("details", undefined, "capture-target__details");
  advanced.append(node("summary", "Advanced readiness settings"));
  const input = node("input");
  input.type = "text";
  input.maxLength = 256;
  input.className = "field-control";
  input.value = target.wait_for_selector ?? "";
  const field = createFormField("Wait for CSS selector", input, {
    description: "Optional. Capture waits for this element after page load. Leave blank to use the default readiness behavior.",
    ownerDocument: document,
  });
  const save = button("Save readiness setting", "secondary");
  const feedback = createInlineFeedback();
  save.addEventListener("click", async () => {
    const finishBusy = beginButtonBusy(save, "Saving readiness…", feedback);
    try {
      await api(`/admin/api/captures/${encodeURIComponent(target.capture_id)}/readiness`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wait_for_selector: input.value }),
      });
      options.showMessage("Capture readiness updated. The screenshot schedule is unchanged.", false, "sites");
      await options.refresh();
    } catch (error) { options.showMessage(errorMessage(error), true, "sites"); }
    finally { finishBusy(); }
  });
  advanced.append(field.element, save, feedback);
  return advanced;
}

function createInlineFeedback() {
  const feedback = node("p", undefined, "inline-feedback");
  feedback.hidden = true;
  feedback.setAttribute("role", "status");
  feedback.setAttribute("aria-live", "polite");
  return feedback;
}

function formatBackgroundAssessment(decision: any) {
  if (!decision) return "";
  const suggestion = decision.action === "defer_once" ? "A later capture could be suitable"
    : decision.action === "error" ? "Assessment unavailable" : "Keep the scheduled capture";
  const durationSuggestion = decision.duration_review === "review_overestimate"
    ? " JEV recommends an operator review for a possible reserve overestimate; no settings were changed."
    : decision.duration_review === "review_underestimate"
      ? " JEV recommends an operator review for a possible reserve underestimate; no settings were changed."
      : "";
  return `Background assessment ${formatTimestamp(decision.assessed_at)} for ${formatTimestamp(decision.due_at)}: ${suggestion}. ${decision.reason} ${formatCaptureObservation(decision)}${durationSuggestion} The schedule was unchanged.`;
}

function createScreenshotAction(target: any, options: CaptureTargetRendererOptions) {
  const capture = button("Take screenshot now", "secondary");
  capture.addEventListener("click", async () => {
    capture.disabled = true;
    try {
      const result = await api(`/admin/api/captures/${encodeURIComponent(target.capture_id)}/run`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      });
      const status = result.status === "running" ? "has started" : "is queued";
      options.showMessage(`Screenshot job ${compactIdentifier(result.job_id)} ${status}.`, false, "sites");
      await options.refresh();
    } catch (error) { options.showMessage(errorMessage(error), true, "sites"); }
    finally { capture.disabled = false; }
  });
  return capture;
}

function createRemoveSiteAction(target: any, options: CaptureTargetRendererOptions) {
  const remove = button("Remove capture site", "danger");
  remove.addEventListener("click", async () => {
    const description = `Remove ${target.display_url} from managed capture sites? Future screenshots will stop. Existing playlist versions will keep their last saved image.`;
    try {
      const confirmed = await confirmBeforeAction(
        (text) => options.showConfirmDialog({
          title: "Remove capture site?", description: text, confirmLabel: "Remove site", destructive: true,
        }),
        description,
        () => api(`/admin/api/captures/${encodeURIComponent(target.capture_id)}`, { method: "DELETE" }),
      );
      if (!confirmed) return;
      options.showMessage(`${target.display_url} was removed. Future screenshots have stopped.`, false, "sites");
      await options.refresh();
    } catch (error) { options.showMessage(errorMessage(error), true, "sites"); }
  });
  return remove;
}

function createAssessmentDisclosure(target: any, assessmentSummary: string, options: CaptureTargetRendererOptions) {
  const disclosure = node("details", undefined, "capture-target__assessment");
  disclosure.append(node("summary", "Assess screenshot schedule"));
  if (assessmentSummary) disclosure.append(node("p", assessmentSummary, "muted"));
  const assess = button("Run advisory assessment", "secondary");
  const assessment = node("div", undefined, "jev-result-slot");
  assess.addEventListener("click", async () => {
    assess.disabled = true;
    assessment.setAttribute("aria-busy", "true");
    assessment.replaceChildren(node("p", "Assessing current screenshot signals…", "muted"));
    try {
      const decision = await api("/admin/api/jev/capture-assessment", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capture_id: target.capture_id }),
      });
      assessment.removeAttribute("aria-busy");
      assessment.replaceChildren(options.renderJevDecision(decision, "Screenshot skip assessment", { captureID: target.capture_id }));
    } catch (error) {
      assessment.removeAttribute("aria-busy");
      assessment.replaceChildren(node("p", errorMessage(error), "error-title"));
    } finally { assess.disabled = false; }
  });
  disclosure.append(assess, assessment);
  return disclosure;
}
