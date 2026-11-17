import { api } from "./api.ts";
import { requiredElement, requiredElements } from "./dom.ts";
import { formatCaptureObservation } from "./capture-presentation.ts";
import { beginButtonBusy, button, node, statusBadge } from "./ui-primitives.ts";
import { formatTimestamp } from "./admin-formatters.ts";
import {
  compactIdentifier,
  confirmBeforeAction,
  formatCaptureInterval,
  formatScreenshotStatus,
  prioritizeCaptureTargets,
} from "./ui-utils.ts";

const CAPTURE_SITE_VIEW_STORAGE_KEY = "ribbonfish.capture-sites.view";

type CaptureTargetRendererOptions = {
  getCaptureIntervalOptions: () => Array<{ label: string; value: number }>;
  filterCaptureTargets: () => void;
  showMessage: (message: string, isError?: boolean, section?: string) => void;
  refresh: () => Promise<unknown>;
  showConfirmDialog: (options: any) => Promise<boolean>;
  renderJevDecision: (decision: any, title: string, options: any) => Node;
};

type SiteView = "cards" | "list";

type EditableSiteSettings = {
  name: string;
  interval: number;
  selector: string;
  reviewed: boolean;
};

type CaptureRendererState = {
  view: SiteView;
  currentTarget: any | null;
  baseline: EditableSiteSettings | null;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function readPreferredView(): SiteView {
  try {
    return window.localStorage.getItem(CAPTURE_SITE_VIEW_STORAGE_KEY) === "list" ? "list" : "cards";
  } catch {
    return "cards";
  }
}

function storePreferredView(view: SiteView) {
  try {
    window.localStorage.setItem(CAPTURE_SITE_VIEW_STORAGE_KEY, view);
  } catch {
    // Storage can be disabled by browser privacy settings; the current view still works.
  }
}

function targetNeedsAttention(target: any) {
  return Boolean(target.last_error) || !target.schedule_reviewed || !target.last_success_at;
}

function captureTargetName(target: any) {
  return target.name || target.display_url;
}

function captureTargetStatus(target: any) {
  if (!target.schedule_reviewed) return { label: "Schedule review needed", tone: "warning" };
  return formatScreenshotStatus(target.job_status, target.last_error, target.last_success_at);
}

function lastSuccessfulCapture(target: any) {
  return target.last_success_at
    ? `Last successful capture ${formatTimestamp(target.last_success_at)}`
    : "No successful capture yet";
}

export function createCaptureTargetRenderer(options: CaptureTargetRendererOptions) {
  const dialog = requiredElement<HTMLDialogElement>(document, "#capture-site-dialog");
  const dialogTitle = requiredElement<HTMLHeadingElement>(dialog, "#capture-site-dialog-title");
  const addButton = requiredElement<HTMLButtonElement>(document, "#add-capture-site");
  const addForm = requiredElement<HTMLFormElement>(dialog, "#capture-site-form");
  const editForm = requiredElement<HTMLFormElement>(dialog, "#capture-site-edit-form");
  const editName = requiredElement<HTMLInputElement>(editForm, "[name=name]");
  const editInterval = requiredElement<HTMLSelectElement>(editForm, "[name=capture_interval_seconds]");
  const editSelector = requiredElement<HTMLInputElement>(editForm, "[name=wait_for_selector]");
  const editSave = requiredElement<HTMLButtonElement>(editForm, "[data-save-site-changes]");
  const scheduleNote = requiredElement<HTMLElement>(editForm, "#capture-site-schedule-note");
  const assessmentResult = requiredElement<HTMLElement>(dialog, "#capture-site-assessment-result");
  const assessmentContent = requiredElement<HTMLElement>(dialog, "#capture-site-assessment-content");
  const viewToggle = requiredElement<HTMLElement>(document, "#capture-site-view-toggle");
  const state: CaptureRendererState = { view: readPreferredView(), currentTarget: null, baseline: null };
  let currentTargets: any[] = [];
  let currentDecisions: any[] = [];

  function showDialog() {
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }

  function closeDialog() {
    if (!dialog.open) return;
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  }

  function setDialogMode(isEditing: boolean) {
    addForm.hidden = isEditing;
    editForm.hidden = !isEditing;
  }

  function updateEditSaveState() {
    const baseline = state.baseline;
    const target = state.currentTarget;
    if (!baseline || !target) return;
    const changed = editName.value !== baseline.name ||
      Number(editInterval.value) !== baseline.interval ||
      editSelector.value !== baseline.selector;
    editSave.disabled = !changed && baseline.reviewed;
    editSave.textContent = baseline.reviewed ? "Save changes" : "Confirm schedule";
  }

  function openSiteEditor(target: any | null, decision?: any, runAssessment = false) {
    const isEditing = target !== null;
    state.currentTarget = target;
    state.baseline = target ? {
      name: target.name ?? "",
      interval: Number(target.capture_interval_seconds),
      selector: target.wait_for_selector ?? "",
      reviewed: Boolean(target.schedule_reviewed),
    } : null;
    dialogTitle.textContent = target ? `Edit ${captureTargetName(target)}` : "Add a site";
    setDialogMode(isEditing);
    assessmentResult.hidden = true;
    assessmentContent.replaceChildren();

    if (target) {
      editName.value = state.baseline!.name;
      editInterval.replaceChildren(...options.getCaptureIntervalOptions().map(({ label, value }) => {
        const option = node("option", label);
        (option as HTMLOptionElement).value = String(value);
        (option as HTMLOptionElement).selected = value === state.baseline!.interval;
        return option;
      }));
      if (![...editInterval.options].some((option) => option.value === String(state.baseline!.interval))) {
        const option = node("option", formatCaptureInterval(state.baseline!.interval)) as HTMLOptionElement;
        option.value = String(state.baseline!.interval);
        option.selected = true;
        editInterval.append(option);
      }
      editSelector.value = state.baseline!.selector;
      scheduleNote.hidden = state.baseline!.reviewed;
      updateEditSaveState();

      const backgroundSummary = formatBackgroundAssessment(decision);
      if (backgroundSummary) {
        assessmentResult.hidden = false;
        assessmentContent.append(node("p", backgroundSummary, "muted"));
      }
    } else {
      addForm.reset();
      requiredElement<HTMLElement>(dialog, "#capture-site-feedback").hidden = true;
    }

    showDialog();
    if (target && runAssessment) void requestAssessment(target);
  }

  async function requestAssessment(target: any) {
    assessmentResult.hidden = false;
    assessmentResult.setAttribute("aria-busy", "true");
    assessmentContent.replaceChildren(node("p", "Assessing current screenshot signals…", "muted"));
    try {
      const decision = await api("/admin/api/jev/capture-assessment", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capture_id: target.capture_id }),
      });
      assessmentContent.replaceChildren(options.renderJevDecision(decision, "Screenshot skip assessment", { captureID: target.capture_id }));
    } catch (error) {
      assessmentContent.replaceChildren(node("p", errorMessage(error), "error-title"));
    } finally {
      assessmentResult.removeAttribute("aria-busy");
    }
  }

  addButton.addEventListener("click", () => openSiteEditor(null));
  requiredElements<HTMLButtonElement>(dialog, "[data-close-capture-site-dialog]").forEach((closeButton) => {
    closeButton.addEventListener("click", closeDialog);
  });
  editForm.addEventListener("input", updateEditSaveState);
  editForm.addEventListener("change", updateEditSaveState);
  dialog.addEventListener("close", () => {
    state.currentTarget = null;
    state.baseline = null;
  });

  editForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const target = state.currentTarget;
    const baseline = state.baseline;
    if (!target || !baseline) return;

    const updates: Array<{ path: string; body: Record<string, unknown>; apply(): void; message: string }> = [];
    const scheduleWasUnreviewed = !baseline.reviewed;
    if (editName.value !== baseline.name) updates.push({
      path: `/admin/api/captures/${encodeURIComponent(target.capture_id)}/name`,
      body: { name: editName.value },
      apply: () => { baseline.name = editName.value; target.name = editName.value; },
      message: "site name",
    });
    if (Number(editInterval.value) !== baseline.interval || !baseline.reviewed) updates.push({
      path: `/admin/api/captures/${encodeURIComponent(target.capture_id)}`,
      body: { capture_interval_seconds: Number(editInterval.value) },
      apply: () => { baseline.interval = Number(editInterval.value); baseline.reviewed = true; target.capture_interval_seconds = baseline.interval; target.schedule_reviewed = true; },
      message: "screenshot schedule",
    });
    if (editSelector.value !== baseline.selector) updates.push({
      path: `/admin/api/captures/${encodeURIComponent(target.capture_id)}/readiness`,
      body: { wait_for_selector: editSelector.value },
      apply: () => { baseline.selector = editSelector.value; target.wait_for_selector = editSelector.value; },
      message: "readiness setting",
    });
    if (!updates.length) return;

    const saveLabel = baseline.reviewed ? "Save changes" : "Confirm schedule";
    const finishBusy = beginButtonBusy(editSave, "Saving changes…", requiredElement(dialog, "#capture-site-edit-feedback"));
    try {
      const saved = [];
      for (const update of updates) {
        await api(update.path, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(update.body) });
        update.apply();
        saved.push(update.message);
      }
      const message = saved.includes("screenshot schedule") && scheduleWasUnreviewed
        ? "Screenshot schedule reviewed. This site can now be added to playlists."
        : `Updated ${saved.join(", ")}.`;
      options.showMessage(message, false, "sites");
      closeDialog();
      await options.refresh();
    } catch (error) {
      options.showMessage(errorMessage(error), true, "sites");
    } finally {
      finishBusy();
      editSave.textContent = saveLabel;
      updateEditSaveState();
    }
  });

  requiredElements<HTMLButtonElement>(viewToggle, "[data-capture-view]").forEach((viewButton) => {
    viewButton.addEventListener("click", () => {
      state.view = viewButton.dataset.captureView === "list" ? "list" : "cards";
      storePreferredView(state.view);
      renderCurrentTargets();
    });
  });

  function renderCurrentTargets() {
    const container = requiredElement(document, "#capture-target-list");
    const count = requiredElement<HTMLElement>(document, "#capture-site-counts");
    const filterButtons = requiredElements<HTMLButtonElement>(document, "#capture-site-filters [data-capture-filter]");
    const attention = currentTargets.filter(targetNeedsAttention).length;
    const ready = currentTargets.length - attention;
    count.textContent = `${currentTargets.length} screenshot ${currentTargets.length === 1 ? "site" : "sites"} · ${attention} need attention`;
    filterButtons.forEach((filterButton) => {
      const filter = filterButton.dataset.captureFilter;
      const value = filter === "all" ? currentTargets.length : filter === "attention" ? attention : ready;
      requiredElement(filterButton, "[data-capture-count]").textContent = String(value);
    });

    const activeView: SiteView = currentTargets.length >= 10 ? state.view : "cards";
    viewToggle.hidden = currentTargets.length < 10;
    requiredElements<HTMLButtonElement>(viewToggle, "[data-capture-view]").forEach((viewButton) => {
      viewButton.setAttribute("aria-pressed", String(viewButton.dataset.captureView === activeView));
      viewButton.classList.toggle("is-selected", viewButton.dataset.captureView === activeView);
    });
    container.replaceChildren();
    if (!currentTargets.length) {
      container.append(node("p", "No capture sites yet. Add a site to configure its screenshot schedule.", "muted"));
      requiredElement<HTMLElement>(document, "#capture-filter-empty").hidden = true;
      return;
    }

    const orderedTargets = prioritizeCaptureTargets(currentTargets);
    const decisionByTarget = new Map(currentDecisions.map((decision) => [decision.capture_id, decision]));
    const cards = node("div", undefined, "capture-target-list__cards");
    cards.id = "capture-target-cards";
    cards.hidden = activeView !== "cards";
    const tableView = node("div", undefined, "capture-target-table-view");
    tableView.id = "capture-target-table-view";
    tableView.hidden = activeView !== "list";
    const openEditor = (target: any, decision: any, runAssessment = false) => openSiteEditor(target, decision, runAssessment);
    const desktopTable = createSiteTable(orderedTargets, decisionByTarget, options, openEditor);
    tableView.append(desktopTable);
    const mobileCards = node("div", undefined, "mobile-card-list capture-target-list__mobile");
    orderedTargets.forEach((target) => {
      const decision = decisionByTarget.get(target.capture_id);
      cards.append(renderCaptureTargetCard(target, decision, options, openEditor));
      mobileCards.append(renderMobileSiteRow(target, decision, options, openEditor));
    });
    tableView.append(mobileCards);
    container.append(cards, tableView);
    options.filterCaptureTargets();
  }

  return function renderCaptureTargets(targets: any[], decisions: any[] = []) {
    currentTargets = targets;
    currentDecisions = decisions;
    renderCurrentTargets();
  };
}

function applyRecordFilterMetadata(record: HTMLElement, target: any) {
  record.dataset.captureRecord = "true";
  record.dataset.search = `${target.name ?? ""} ${target.display_url ?? ""}`.toLocaleLowerCase();
  record.dataset.filter = targetNeedsAttention(target) ? "attention" : "ready";
}

function renderCaptureTargetCard(
  target: any,
  decision: any,
  options: CaptureTargetRendererOptions,
  openEditor: (target: any, decision: any, runAssessment?: boolean) => void,
) {
  const siteName = captureTargetName(target);
  const card = node("article", undefined, "capture-target");
  applyRecordFilterMetadata(card, target);
  const preview = node("img", undefined, "capture-target__preview");
  preview.src = `/admin/api/assets/${target.sha256}`;
  preview.alt = "Screenshot preview";
  preview.loading = "lazy";
  preview.decoding = "async";
  preview.addEventListener("error", () => { preview.hidden = true; }, { once: true });

  const content = node("div", undefined, "capture-target__content");
  const heading = node("div", undefined, "capture-target__heading");
  heading.append(node("h3", siteName), statusBadge(captureTargetStatus(target).label, captureTargetStatus(target).tone));
  content.append(heading);
  content.append(node("p", lastSuccessfulCapture(target), "muted"));
  content.append(node("p", `${formatCaptureInterval(target.capture_interval_seconds)} · ${target.viewport.width} × ${target.viewport.height} px`, "muted"));
  if (target.last_error) content.append(node("p", `Screenshot error: ${target.last_error}`, "capture-target__error error-title"));
  content.append(createSiteActions(target, decision, options, openEditor));
  card.append(preview, content);
  return card;
}

function renderMobileSiteRow(target: any, decision: any, options: CaptureTargetRendererOptions, openEditor: (target: any, decision: any, runAssessment?: boolean) => void) {
  const row = node("article", undefined, "data-card capture-target capture-target--mobile-row");
  applyRecordFilterMetadata(row, target);
  const heading = node("div", undefined, "data-card__heading");
  heading.append(node("h3", captureTargetName(target)), statusBadge(captureTargetStatus(target).label, captureTargetStatus(target).tone));
  const data = node("dl", undefined, "capture-target__mobile-data");
  data.append(
    definitionRow("Last capture", lastSuccessfulCapture(target)),
    definitionRow("Interval", `${formatCaptureInterval(target.capture_interval_seconds)} · ${target.viewport.width} × ${target.viewport.height} px`),
  );
  row.append(heading, data);
  if (target.last_error) row.append(node("p", `Screenshot error: ${target.last_error}`, "capture-target__error error-title"));
  row.append(createSiteActions(target, decision, options, openEditor));
  return row;
}

function definitionRow(label: string, value: string) {
  const wrapper = node("div");
  wrapper.append(node("dt", label), node("dd", value));
  return wrapper;
}

function createSiteTable(targets: any[], decisions: Map<string, any>, options: CaptureTargetRendererOptions, openEditor: (target: any, decision: any, runAssessment?: boolean) => void) {
  const table = node("table", undefined, "data-table capture-sites-table");
  table.append(node("caption", "Capture sites"));
  const head = node("thead");
  const headerRow = node("tr");
  ["Name", "Status", "Last capture", "Interval", "Actions"].forEach((label) => {
    const heading = node("th", label);
    heading.setAttribute("scope", "col");
    headerRow.append(heading);
  });
  head.append(headerRow);
  table.append(head);
  const body = node("tbody");
  targets.forEach((target) => {
    const row = node("tr", undefined, "capture-target--table-row");
    applyRecordFilterMetadata(row, target);
    const name = node("th", captureTargetName(target));
    name.setAttribute("scope", "row");
    const statusCell = node("td");
    const status = captureTargetStatus(target);
    statusCell.append(statusBadge(status.label, status.tone));
    const lastCapture = node("td", lastSuccessfulCapture(target));
    const interval = node("td", `${formatCaptureInterval(target.capture_interval_seconds)} · ${target.viewport.width} × ${target.viewport.height} px`);
    const actions = node("td");
    actions.append(createSiteActions(target, decisions.get(target.capture_id), options, openEditor));
    row.append(name, statusCell, lastCapture, interval, actions);
    body.append(row);
  });
  table.append(body);
  const wrapper = node("div", undefined, "table-scroll desktop-data capture-sites-table__desktop");
  wrapper.append(table);
  return wrapper;
}

function createSiteActions(target: any, decision: any, options: CaptureTargetRendererOptions, openEditor: (target: any, decision: any, runAssessment?: boolean) => void) {
  const siteName = captureTargetName(target);
  const actions = node("div", undefined, "table-actions capture-site-actions");
  const capture = button("Take screenshot now", "primary");
  capture.dataset.captureAction = "run";
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

  const edit = button("Edit", "secondary");
  edit.dataset.editCaptureSite = target.capture_id;
  edit.setAttribute("aria-label", `Edit ${siteName}`);
  edit.addEventListener("click", () => openEditor(target, decision));

  const overflow = node("details", undefined, "action-disclosure capture-site-overflow");
  const summary = node("summary", "⋮");
  summary.setAttribute("aria-label", `More actions for ${siteName}`);
  summary.title = `More actions for ${siteName}`;
  overflow.append(summary);
  const menu = node("div", undefined, "action-disclosure__content capture-site-overflow__actions");
  const assess = button("Run advisory assessment", "secondary");
  assess.dataset.captureAction = "assess";
  assess.addEventListener("click", () => {
    overflow.open = false;
    openEditor(target, decision, true);
  });
  const remove = button("Remove capture site", "danger");
  remove.dataset.captureAction = "remove";
  remove.addEventListener("click", async () => {
    const description = `Remove ${target.display_url} from managed capture sites? Future screenshots will stop. Existing playlist versions will keep their last saved image.`;
    try {
      const confirmed = await confirmSiteRemoval(target, options, description);
      if (!confirmed) return;
      options.showMessage(`${target.display_url} was removed. Future screenshots have stopped.`, false, "sites");
      await options.refresh();
    } catch (error) { options.showMessage(errorMessage(error), true, "sites"); }
  });
  menu.append(assess, remove);
  overflow.append(menu);
  actions.append(capture, edit, overflow);
  return actions;
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

function confirmSiteRemoval(target: any, options: CaptureTargetRendererOptions, description: string) {
  return confirmBeforeAction(
    (text) => options.showConfirmDialog({
      title: "Remove capture site?", description: text, confirmLabel: "Remove site", destructive: true,
    }),
    description,
    () => api(`/admin/api/captures/${encodeURIComponent(target.capture_id)}`, { method: "DELETE" }),
  );
}
