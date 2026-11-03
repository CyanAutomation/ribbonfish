import { api } from "./api.ts";
import { formatCaptureObservation, formatRunTime } from "./capture-presentation.ts";
import { node, button, statusBadge, actionDisclosure } from "./ui-primitives.ts";
import { initModuleNavigation } from "./module-navigation.ts";
import {
  createFleetOpenUI,
  OPENUI_STARTER_SOURCE,
  renderOpenUIElement,
} from "./openui-core.ts";
import {
  compactIdentifier,
  confirmAction,
  confirmBeforeAction,
  createTransientNotice,
  createRetryableLoadOnce,
  formatActorLabel,
  formatCaptureInterval,
  formatAuditDetails,
  formatAuditEventType,
  formatDeviceEnabledMessage,
  formatDeviceHealthDetails,
  formatEnrollmentApprovalPrompt,
  formatEnvironmentNotice,
  formatPlaylistState,
  playlistDeleteActionStates,
  formatScreenshotStatus,
  formatTimestamp,
  summarizeFleetAttention,
  prioritizeCaptureTargets,
  summarizeCaptureErrors,
} from "./ui-utils.ts";

const fleetSummary = document.querySelector("#fleet-summary");
const fleetAttention = document.querySelector("#fleet-attention");
const confirmDialog = document.querySelector("#confirm-dialog");
const confirmTitle = document.querySelector("#confirm-title");
const confirmDescription = document.querySelector("#confirm-description");
const confirmButton = document.querySelector("#confirm-submit");
const confirmCancel = document.querySelector("#confirm-cancel");
const environmentTag = document.querySelector("#environment-tag");
const environmentNotice = document.querySelector("#environment-notice");
let latestOverview = null;
let fleetSummaryInitialized = false;
let pendingEnrollmentsLoaded = false;
let pendingEnrollmentIDs = new Set();
let playlistEditSource = null;
let intervalDefinitions = null;
const fleetViewRuntime = createFleetOpenUI({ getOverview: async () => latestOverview });

fleetViewRuntime.subscribe(renderFleetSummary);

const feedbackSlots = new Map([...document.querySelectorAll("[data-feedback-slot]")].map((element) => {
  const slot = {
    element,
    text: element.querySelector("[data-feedback-text]"),
    hovered: false,
    focused: false,
    transient: false,
    timer: null,
  };
  slot.timer = createTransientNotice({ onExpire: () => { slot.transient = false; element.hidden = true; } });
  element.addEventListener("mouseenter", () => { slot.hovered = true; slot.timer.pause(); });
  element.addEventListener("mouseleave", () => {
    slot.hovered = false;
    if (!slot.focused && slot.transient) slot.timer.resume();
  });
  element.addEventListener("focusin", () => { slot.focused = true; slot.timer.pause(); });
  element.addEventListener("focusout", (event) => {
    if (element.contains(event.relatedTarget)) return;
    slot.focused = false;
    if (!slot.hovered && slot.transient) slot.timer.resume();
  });
  element.querySelector("[data-dismiss-feedback]").addEventListener("click", () => {
    slot.timer.clear();
    slot.transient = false;
    element.hidden = true;
  });
  return [element.dataset.feedbackSlot, slot];
}));

function showMessage(text, isError = false, context = "global") {
  const slot = feedbackSlots.get(context) ?? feedbackSlots.get("global");
  slot.timer.clear();
  slot.transient = !isError;
  slot.text.textContent = text;
  slot.element.classList.toggle("alert--success", !isError);
  slot.element.classList.toggle("alert--error", isError);
  slot.element.setAttribute("role", isError ? "alert" : "status");
  slot.element.setAttribute("aria-live", isError ? "assertive" : "polite");
  slot.element.hidden = false;
  if (!isError) {
    if (slot.hovered || slot.focused) slot.timer.pause();
    else slot.timer.start();
  }
}

function showInlineMessage(target, text, isError = false) {
  target.textContent = text;
  target.classList.toggle("error", isError);
  target.hidden = false;
}

function table(caption, headers, rows, emptyState) {
  const element = node("table", undefined, "data-table");
  element.append(node("caption", caption, "visually-hidden"));
  const head = node("thead");
  const headerRow = node("tr");
  headers.forEach((label) => {
    const cell = node("th", label);
    cell.scope = "col";
    headerRow.append(cell);
  });
  head.append(headerRow);
  element.append(head);
  const body = node("tbody");
  rows.forEach((row) => body.append(row));
  if (!rows.length && emptyState) {
    const row = node("tr", undefined, "empty-row");
    const cell = node("td", undefined, "empty-state-cell");
    cell.colSpan = headers.length;
    cell.append(renderEmptyState(emptyState.message, emptyState.actionLabel, emptyState.href, true));
    row.append(cell);
    body.append(row);
  }
  element.append(body);
  return element;
}

function cell(label, value, className) {
  const element = node("td", undefined, className);
  element.dataset.label = label;
  if (value instanceof Node) element.append(value);
  else element.textContent = value === null || value === undefined ? "—" : String(value);
  return element;
}

function renderEmptyState(messageTextValue, actionLabel, href, compact = false) {
  const card = node("div", undefined, "empty-state");
  card.append(node("p", messageTextValue));
  if (actionLabel && href) {
    const action = node("a", actionLabel, `button button--secondary${compact ? " button--small" : ""}`);
    action.href = href;
    if (href === "#playlist-editor") {
      action.addEventListener("click", () => {
        document.querySelector("#playlist-editor").open = true;
      });
    }
    card.append(action);
  }
  return card;
}

function renderResponsiveRecords({
  tableSelector,
  cardsSelector,
  caption,
  records,
  fields,
  emptyState,
  cardTitleField,
  cardStatusField,
  cardActionField = "Actions",
  cardClass = "data-card",
}) {
  const valuesFor = (record, layout) => fields.map((field) => ({
    ...field,
    value: field.render(record, layout),
  }));
  const rows = records.map((record) => {
    const row = node("tr");
    valuesFor(record, "table").forEach(({ label, value }) => row.append(cell(label, value)));
    return row;
  });
  const tableContainer = typeof tableSelector === "string" ? document.querySelector(tableSelector) : tableSelector;
  tableContainer.replaceChildren(table(
    caption,
    fields.map(({ label }) => label),
    rows,
    emptyState,
  ));

  const cards = typeof cardsSelector === "string" ? document.querySelector(cardsSelector) : cardsSelector;
  cards.replaceChildren();
  if (!records.length) {
    cards.append(emptyCard(emptyState.message, emptyState.actionLabel, emptyState.href));
    return;
  }

  records.forEach((record) => {
    const recordFields = valuesFor(record, "card");
    const card = node("article", undefined, cardClass);
    const header = node("div", undefined, "data-card__header");
    const title = recordFields.find(({ label }) => label === cardTitleField);
    const titleHeading = node("h3");
    if (title?.value instanceof Node) titleHeading.append(title.value);
    else titleHeading.textContent = title?.value == null ? "—" : String(title.value);
    header.append(titleHeading);
    const status = recordFields.find(({ label }) => label === cardStatusField);
    if (status) header.append(status.value);
    card.append(header);

    const cardAction = recordFields.find(({ label }) => label === cardActionField);
    const detailsFields = recordFields.filter(({ label }) =>
      label !== cardTitleField && label !== cardStatusField && label !== cardActionField);
    if (detailsFields.length) {
      const details = node("dl");
      detailsFields.forEach(({ label, value }) => {
        const field = node("div");
        field.append(node("dt", label));
        const content = node("dd");
        if (value instanceof Node) content.append(value);
        else content.textContent = value == null ? "—" : String(value);
        field.append(content);
        details.append(field);
      });
      card.append(details);
    }
    if (cardAction) card.append(cardAction.value);
    cards.append(card);
  });
}

function identifier(value, label, context = "global") {
  const fullValue = value === null || value === undefined || value === "" ? "—" : String(value);
  const wrapper = node("span", undefined, "identifier");
  const code = node("code", compactIdentifier(fullValue), "identifier__value");
  code.title = fullValue;
  code.setAttribute("aria-label", `${label}: ${fullValue}`);
  wrapper.append(code);
  if (fullValue !== "—" && fullValue.length > 24) {
    const copy = button("Copy", "quiet");
    copy.classList.add("button--small", "identifier__copy");
    copy.setAttribute("aria-label", `Copy full ${label}`);
    copy.addEventListener("click", () => copyValue(fullValue, `${label} copied.`, context));
    wrapper.append(copy);
  }
  return wrapper;
}

function fingerprintDisplay(value) {
  const wrapper = node("span", undefined, "fingerprint-display");
  const code = node("code", String(value).toUpperCase(), "fingerprint-display__value");
  wrapper.append(code);
  const copy = button("Copy", "quiet");
  copy.classList.add("button--small");
  copy.setAttribute("aria-label", "Copy full device fingerprint");
  copy.addEventListener("click", () => copyValue(value, "Device fingerprint copied.", "device"));
  wrapper.append(copy);
  return wrapper;
}

async function copyValue(value, successMessage, context = "global") {
  try {
    await navigator.clipboard.writeText(value);
    showMessage(successMessage, false, context);
  } catch {
    showMessage("Clipboard access failed. Select and copy the value manually.", true, context);
  }
}

function playlistForm() {
  return document.querySelector("#playlist-form");
}

function playlistVersionKey(playlist) {
  return JSON.stringify([playlist.playlist_id, playlist.revision]);
}

function resetPlaylistEditor() {
  const form = playlistForm();
  const editor = document.querySelector("#playlist-editor");
  playlistEditSource = null;
  editor.querySelector("summary").textContent = "Create playlist version";
  editor.open = false;
  form.querySelector("#playlist-form-help").textContent =
    "Add PNG images and select reviewed sites from the library. Saved versions stay available until you delete the playlist.";
  form.querySelector("[name=assets]").required = false;
  form.querySelector("#playlist-submit").textContent = "Save playlist version";
  form.querySelector("#cancel-playlist-edit").hidden = true;
  for (const selector of ["#playlist-current-assets"]) {
    const selection = document.querySelector(selector);
    selection.querySelector(".asset-selection__list").replaceChildren();
    selection.hidden = true;
  }
  renderAvailableSites(latestOverview?.capture_targets ?? [], new Set());
}

async function startPlaylistEdit(playlist) {
  try {
    const detail = await api(
      `/admin/api/playlists/${encodeURIComponent(playlist.playlist_id)}/${encodeURIComponent(playlist.revision)}`,
    );
    const form = playlistForm();
    form.reset();
    resetPlaylistEditor();
    resetIntervalSelections(form);
    playlistEditSource = { playlist_id: detail.playlist_id, revision: detail.revision };
    document.querySelector("#playlist-editor").open = true;
    document.querySelector("#playlist-editor-summary").textContent = `Edit ${detail.playlist_id} playlist version`;
    form.elements.namedItem("id").value = detail.playlist_id;
    form.elements.namedItem("rotation_interval").value = detail.rotation_interval;
    form.querySelector("#playlist-form-help").textContent =
      `Editing ${detail.playlist_id}, version ${compactIdentifier(detail.revision)}. Keep the images and sites you want, then save a new version. Saved versions do not change.`;
    form.querySelector("[name=assets]").required = false;
    form.querySelector("#playlist-submit").textContent = "Save as new version";
    form.querySelector("#cancel-playlist-edit").hidden = false;
    const selection = document.querySelector("#playlist-current-assets");
    const assetList = selection.querySelector(".asset-selection__list");
    assetList.replaceChildren();
    detail.assets.forEach((asset, index) => {
      const label = node("label", undefined, "asset-option");
      const checkbox = node("input");
      checkbox.type = "checkbox";
      checkbox.checked = true;
      checkbox.dataset.sha256 = asset.sha256;
      checkbox.dataset.size = String(asset.size);
      const preview = node("img", undefined, "asset-option__preview");
      preview.src = `/admin/api/assets/${asset.sha256}`;
      preview.alt = "";
      preview.loading = "lazy";
      preview.decoding = "async";
      preview.addEventListener("error", () => { preview.hidden = true; }, { once: true });
      const caption = node("span", `Keep image ${index + 1} · ${compactIdentifier(asset.sha256)}`);
      label.append(checkbox, preview, caption);
      assetList.append(label);
    });
    selection.hidden = false;
    renderAvailableSites(latestOverview?.capture_targets ?? [], new Set((detail.captures ?? []).map((capture) => capture.capture_id)));
    document.querySelector("#playlist-feedback").hidden = true;
    form.scrollIntoView({ behavior: "smooth", block: "start" });
    form.elements.namedItem("id").focus({ preventScroll: true });
  } catch (error) {
    showMessage(error.message, true, "playlist");
  }
}

function playlistActionButtons(playlist, deleteAction, layout) {
  const actions = node("div", undefined, layout === "card" ? "card-actions" : "table-actions");
  const edit = button("Edit", "secondary");
  edit.setAttribute("aria-label", `Edit playlist ${playlist.playlist_id} from version ${compactIdentifier(playlist.revision)}`);
  edit.addEventListener("click", () => startPlaylistEdit(playlist));
  actions.append(edit);

  if (!playlist.active) {
    const activate = button("Activate version", "primary");
    activate.addEventListener("click", async () => {
      const description = `Make playlist ${playlist.playlist_id}, version ${compactIdentifier(playlist.revision)}, active. Enrolled devices will receive it the next time they sync.`;
      try {
        const confirmed = await confirmBeforeAction(
          (text) => showConfirmDialog({
            title: "Activate playlist version?",
            description: text,
            confirmLabel: "Activate version",
          }),
          description,
          () => api("/admin/api/active-playlist", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ playlist_id: playlist.playlist_id, revision: playlist.revision }),
          }),
        );
        if (!confirmed) return;
        showMessage(`Playlist ${playlist.playlist_id} is active. Devices will receive it on their next sync.`, false, "playlist");
        await refresh();
      } catch (error) { showMessage(error.message, true, "playlist"); }
    });
    actions.append(activate);
  }

  if (deleteAction?.visible) {
    const remove = button("Delete playlist", deleteAction.disabled ? "secondary" : "danger");
    if (deleteAction.disabled) {
      remove.disabled = true;
      remove.setAttribute("aria-label", `Delete playlist unavailable. ${deleteAction.hint}`);
      actions.append(remove, node("p", deleteAction.hint, "playlist-delete-hint"));
    } else {
      remove.addEventListener("click", async () => {
        const description = `Delete playlist ${playlist.playlist_id} and all ${deleteAction.versionCount} saved versions? Uploaded images stay available and can be reused by another playlist.`;
        try {
          const confirmed = await confirmBeforeAction(
            (text) => showConfirmDialog({
              title: "Delete playlist?",
              description: text,
              confirmLabel: "Delete playlist",
              destructive: true,
            }),
            description,
            () => api(`/admin/api/playlists/${encodeURIComponent(playlist.playlist_id)}`, { method: "DELETE" }),
          );
          if (!confirmed) return;
          showMessage(`Playlist ${playlist.playlist_id} was deleted. Uploaded images remain available for reuse.`, false, "playlist");
          await refresh();
        } catch (error) { showMessage(error.message, true, "playlist"); }
      });
      actions.append(actionDisclosure(`More actions for ${playlist.playlist_id}`, [remove]));
    }
  }
  return actions;
}

function renderHealth(health) {
  const panel = document.querySelector("#asset-health");
  panel.replaceChildren();
  const issues = health.integrity_issues ?? [];
  if (!health.missing.length && !issues.length) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  if (health.missing.length) {
    panel.append(node("h2", "Images missing from the active playlist", "error-title"));
    panel.append(node("p", "Devices without a cached image will keep showing their last working playlist."));
    const list = node("ul");
    health.missing.forEach((asset) => {
      const item = node("li");
      item.append(identifier(asset.sha256, "image SHA-256", "overview"), document.createTextNode(` (expected ${asset.expected_size} bytes)`));
      list.append(item);
    });
    panel.append(list);
  }
  if (issues.length) {
    panel.append(node("h2", "Image storage issues", "error-title"));
    panel.append(node("p", "The database points to images that are missing from storage. Missing placeholder images are restored automatically when the published placeholder image is available. Saved playlist versions do not change; upload a replacement image and save a new version to repair one."));
    const list = node("ul");
    issues.forEach((issue) => {
      const item = node("li");
      const label = issue.issue_type === "missing_playlist_asset" ? "Missing playlist image" : "Missing placeholder image";
      item.append(document.createTextNode(`${label}: `), identifier(issue.sha256, "image SHA-256", "overview"));
      list.append(item);
    });
    panel.append(list);
  }
}

function renderPlaylists(playlists) {
  const deleteStates = playlistDeleteActionStates(playlists);
  const deleteStateByVersion = new Map(playlists.map((playlist, index) => [
    playlistVersionKey(playlist),
    deleteStates[index],
  ]));
  const fields = [
    { label: "Playlist", render: (playlist) => playlist.playlist_id },
    { label: "Version", render: (playlist) => identifier(playlist.revision, "version ID", "playlist") },
    { label: "Show each item for", render: (playlist) => playlist.rotation_interval },
    { label: "Items", render: (playlist) => playlist.asset_count },
    { label: "Created", render: (playlist) => formatTimestamp(playlist.created_at) },
    {
      label: "Status",
      render: (playlist) => statusBadge(formatPlaylistState(playlist.active), playlist.active ? "success" : "neutral"),
    },
    {
      label: "Actions",
      render: (playlist, layout) => playlistActionButtons(
        playlist,
        deleteStateByVersion.get(playlistVersionKey(playlist)),
        layout,
      ),
    },
  ];
  const desktop = document.querySelector("#playlists");
  const mobile = document.querySelector("#playlists-mobile");
  desktop.replaceChildren();
  mobile.replaceChildren();
  const groups = new Map();
  [...playlists].sort((a, b) => String(a.playlist_id).localeCompare(String(b.playlist_id)) || Number(b.active) - Number(a.active)).forEach((playlist) => {
    const versions = groups.get(playlist.playlist_id) ?? [];
    versions.push(playlist);
    groups.set(playlist.playlist_id, versions);
  });
  const options = {
    fields,
    emptyState: {
      message: "No playlists yet. Add images or reviewed sites to create your first playlist version.",
      actionLabel: "Create playlist version",
      href: "#playlist-editor",
    },
    cardTitleField: "Playlist",
    cardStatusField: "Status",
  };
  if (!groups.size) {
    renderResponsiveRecords({ ...options, tableSelector: desktop, cardsSelector: mobile, caption: "Playlist versions", records: [] });
    return;
  }
  groups.forEach((versions, name) => {
    const desktopGroup = node("section", undefined, "playlist-group");
    const mobileGroup = node("section", undefined, "playlist-group");
    desktopGroup.append(node("h3", name));
    mobileGroup.append(node("h3", name));
    const tableContainer = node("div", undefined, "table-scroll");
    tableContainer.tabIndex = 0;
    tableContainer.setAttribute("role", "region");
    tableContainer.setAttribute("aria-label", `Versions of ${name}`);
    const cardContainer = node("div", undefined, "playlist-group__cards");
    desktopGroup.append(tableContainer);
    mobileGroup.append(cardContainer);
    desktop.append(desktopGroup);
    mobile.append(mobileGroup);
    renderResponsiveRecords({ ...options, tableSelector: tableContainer, cardsSelector: cardContainer, caption: `Versions of ${name}`, records: versions });
  });
}

let openCaptureID = null;
function filterCaptureTargets() {
  const query = document.querySelector("#capture-search").value.trim().toLocaleLowerCase();
  const filter = document.querySelector("#capture-filter").value;
  const cards = [...document.querySelectorAll("#capture-target-list .capture-target")];
  for (const card of cards) {
    card.hidden = !card.dataset.search.includes(query) || (filter !== "all" && card.dataset.filter !== filter);
  }
  document.querySelector("#capture-filter-empty").hidden = !cards.length || cards.some((card) => !card.hidden);
}
document.querySelector("#capture-search").addEventListener("input", filterCaptureTargets);
document.querySelector("#capture-filter").addEventListener("change", filterCaptureTargets);

function renderCaptureTargets(targets, decisions = [], efficiency = null) {
  const decisionByTarget = new Map(decisions.map((decision) => [decision.capture_id, decision]));
  const container = document.querySelector("#capture-target-list");
  container.replaceChildren();
  if (efficiency) {
    const daily = efficiency.daily_usage ?? {};
    const recent = efficiency.last_30_days ?? {};
    const runTime = recent.browser_run_ms ?? {};
    const usage = node("details", undefined, "usage-details");
    usage.append(node("summary", "Capture efficiency and Browser Run usage"));
    usage.append(node("p",
      `Browser Run today: ${formatRunTime(daily.accounted_ms)} of ${formatRunTime(daily.budget_ms)} accounted. ` +
      `Last 30 days: ${recent.successful_screenshots ?? 0} screenshots completed, ${recent.validator_unchanged ?? 0} unchanged validator checks skipped Browser Run, ` +
      `${recent.successful_unclassified ?? 0} older results unclassified. Browser Run time: ${formatRunTime(runTime.response_header)} measured, ` +
      `${formatRunTime(runTime.reserve)} reserve-estimated, ${runTime.unclassified_jobs ?? 0} older jobs unclassified. ` +
      `Scheduled JEV made ${recent.jev_shadow_assessments ?? 0} shadow assessments. Of ${recent.jev_candidate_deferrals ?? 0} defer suggestions, ` +
      `${recent.jev_candidate_changed ?? 0} were followed by changed screenshots and ${recent.jev_candidate_unchanged ?? 0} by unchanged screenshots; ` +
      `${recent.jev_candidate_unverified ?? 0} remain unverified. Schedules were unchanged.`, "muted"));
    container.append(usage);
  }
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
    const card = node("article", undefined, "capture-target");
    const siteName = target.name || target.display_url;
    card.dataset.search = `${target.name ?? ""} ${target.display_url}`.toLocaleLowerCase();
    card.dataset.filter = target.last_error || !target.schedule_reviewed || !target.last_success_at ? "attention" : "ready";
    const preview = node("img", undefined, "capture-target__preview");
    preview.src = `/admin/api/assets/${target.sha256}`;
    preview.alt = `Latest screenshot or placeholder image for ${target.display_url}`;
    preview.loading = "lazy";
    preview.decoding = "async";
    preview.addEventListener("error", () => { preview.hidden = true; }, { once: true });

    const content = node("div", undefined, "capture-target__content");
    const heading = node("div", undefined, "capture-target__heading");
    heading.append(node("h3", siteName));
    const screenshotStatus = formatScreenshotStatus(target.job_status, target.last_error, target.last_success_at);
    heading.append(statusBadge(screenshotStatus.label, screenshotStatus.tone));
    if (!target.schedule_reviewed) heading.append(statusBadge("Schedule review needed", "warning"));
    content.append(heading);
    content.append(node("p", target.last_success_at ? `Last successful capture ${formatTimestamp(target.last_success_at)}` : "No screenshot is ready yet.", "muted"));
    content.append(node("p", `${formatCaptureInterval(target.capture_interval_seconds)} · ${target.viewport.width} × ${target.viewport.height} px`, "muted"));
    if (target.last_error && !repeatedErrors.some((issue) => issue.message === target.last_error)) content.append(node("p", `Screenshot error: ${target.last_error}`, "capture-target__error error-title"));

    const detail = node("details", undefined, "capture-target__panel");
    detail.open = openCaptureID === target.capture_id;
    detail.addEventListener("toggle", () => {
      if (detail.open) {
        openCaptureID = target.capture_id;
        for (const other of container.querySelectorAll(".capture-target__panel[open]")) {
          if (other !== detail) other.open = false;
        }
      } else if (openCaptureID === target.capture_id) openCaptureID = null;
    });
    detail.append(node("summary", "View details"));
    const detailContent = node("div", undefined, "capture-target__panel-content");
    detailContent.append(node("p", target.display_url, "capture-target__url muted"));
    const nameSection = node("section", undefined, "capture-detail-section");
    nameSection.append(node("h4", "Site name"));
    const nameLabel = node("label", "Name (optional)");
    const nameInput = node("input", undefined, "field-control");
    nameInput.type = "text"; nameInput.maxLength = 120; nameInput.value = target.name ?? "";
    nameInput.dataset.siteName = "true";
    nameLabel.append(nameInput);
    const saveName = button("Save name", "secondary");
    saveName.addEventListener("click", async () => {
      saveName.disabled = true;
      try {
        await api(`/admin/api/captures/${encodeURIComponent(target.capture_id)}/name`, {
          method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: nameInput.value }),
        });
        showMessage("Site name updated.", false, "sites");
        await refresh();
      } catch (error) { showMessage(error.message, true, "sites"); }
      finally { saveName.disabled = false; }
    });
    nameSection.append(nameLabel, saveName);
    detailContent.append(nameSection);

    const metadata = node("details", undefined, "capture-target__details");
    metadata.append(node("summary", "Schedule and settings"));
    metadata.append(node("p", `${formatCaptureInterval(target.capture_interval_seconds)} · ${target.viewport.width} × ${target.viewport.height} px`, "muted"));
    metadata.append(node("p", "This schedule is shared by every playlist that uses this page at the same screenshot size.", "field-hint"));
    const intervalLabel = node("label", "Screenshot interval ");
    const intervalSelect = node("select");
    intervalSelect.className = "field-control";
    intervalSelect.setAttribute("aria-label", `Screenshot interval for ${target.display_url}`);
    for (const option of intervalDefinitions?.capture.options ?? []) {
      const item = node("option", option.label);
      item.value = String(option.value);
      item.selected = option.value === target.capture_interval_seconds;
      intervalSelect.append(item);
    }
    intervalLabel.append(intervalSelect);
    const saveInterval = button(target.schedule_reviewed ? "Save screenshot schedule" : "Confirm schedule", "secondary");
    saveInterval.addEventListener("click", async () => {
      saveInterval.disabled = true;
      try {
        await api(`/admin/api/captures/${encodeURIComponent(target.capture_id)}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ capture_interval_seconds: Number(intervalSelect.value) }),
        });
        showMessage(target.schedule_reviewed ? "Screenshot schedule updated." : "Screenshot schedule reviewed. This site can now be added to playlists.", false, "sites");
        await refresh();
      } catch (error) { showMessage(error.message, true, "sites"); }
      finally { saveInterval.disabled = false; }
    });
    metadata.append(intervalLabel, saveInterval);
    const advanced = node("details", undefined, "capture-target__details");
    advanced.append(node("summary", "Advanced readiness settings"));
    const selectorLabel = node("label", "Wait for CSS selector ");
    const selectorInput = node("input");
    selectorInput.type = "text";
    selectorInput.maxLength = 256;
    selectorInput.className = "field-control";
    selectorInput.value = target.wait_for_selector ?? "";
    selectorInput.setAttribute("aria-label", `Wait for CSS selector for ${target.display_url}`);
    selectorLabel.append(selectorInput);
    advanced.append(selectorLabel, node("p",
      "Optional. Capture waits for this element to appear after page load. Leave blank to keep the current readiness behavior.", "field-hint"));
    const saveReadiness = button("Save readiness setting", "secondary");
    saveReadiness.addEventListener("click", async () => {
      saveReadiness.disabled = true;
      try {
        await api(`/admin/api/captures/${encodeURIComponent(target.capture_id)}/readiness`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ wait_for_selector: selectorInput.value }),
        });
        showMessage("Capture readiness updated. The screenshot schedule is unchanged.", false, "sites");
        await refresh();
      } catch (error) { showMessage(error.message, true, "sites"); }
      finally { saveReadiness.disabled = false; }
    });
    advanced.append(saveReadiness);
    if (target.last_error) detailContent.append(node("p", `Screenshot error: ${target.last_error}`, "error-title"));
    if (Number.isSafeInteger(target.next_due_at)) detailContent.append(node("p", `Next screenshot ${formatTimestamp(target.next_due_at)}`, "muted"));
    const backgroundDecision = decisionByTarget.get(target.capture_id);
    if (backgroundDecision) {
      const suggestion = backgroundDecision.action === "defer_once" ? "A later capture could be suitable" :
        backgroundDecision.action === "error" ? "Assessment unavailable" : "Keep the scheduled capture";
      metadata.dataset.assessment = `Background assessment ${formatTimestamp(backgroundDecision.assessed_at)} for ${formatTimestamp(backgroundDecision.due_at)}: ${suggestion}. ${backgroundDecision.reason} ${formatCaptureObservation(backgroundDecision)} The schedule was unchanged.`;
    }

    detailContent.append(metadata, advanced);

    const actions = node("div", undefined, "action-row");
    const capture = button("Take screenshot now", "secondary");
    capture.addEventListener("click", async () => {
      capture.disabled = true;
      try {
        const result = await api(`/admin/api/captures/${encodeURIComponent(target.capture_id)}/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        const status = result.status === "running" ? "has started" : "is queued";
        showMessage(`Screenshot job ${compactIdentifier(result.job_id)} ${status}.`, false, "sites");
        await refresh();
      } catch (error) { showMessage(error.message, true, "sites"); }
      finally { capture.disabled = false; }
    });
    actions.append(capture);
    const removeSite = button("Remove capture site", "danger");
    removeSite.addEventListener("click", async () => {
      const description = `Remove ${target.display_url} from managed capture sites? Future screenshots will stop. Existing playlist versions will keep their last saved image.`;
      try {
        const confirmed = await confirmBeforeAction(
          (text) => showConfirmDialog({
            title: "Remove capture site?",
            description: text,
            confirmLabel: "Remove site",
            destructive: true,
          }),
          description,
          () => api(`/admin/api/captures/${encodeURIComponent(target.capture_id)}`, { method: "DELETE" }),
        );
        if (!confirmed) return;
        showMessage(`${target.display_url} was removed. Future screenshots have stopped.`, false, "sites");
        await refresh();
      } catch (error) { showMessage(error.message, true, "sites"); }
    });
    const removeActions = actionDisclosure(`More actions for ${siteName}`, [removeSite]);
    const assessmentDisclosure = node("details", undefined, "capture-target__assessment");
    assessmentDisclosure.append(node("summary", "Assess screenshot schedule"));
    const assess = button("Run advisory assessment", "secondary");
    const assessment = node("div", undefined, "jev-result-slot");
    assess.addEventListener("click", async () => {
      assess.disabled = true;
      assessment.setAttribute("aria-busy", "true");
      assessment.replaceChildren(node("p", "Assessing current screenshot signals…", "muted"));
      try {
        const decision = await api("/admin/api/jev/capture-assessment", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ capture_id: target.capture_id }),
        });
        assessment.removeAttribute("aria-busy");
        assessment.replaceChildren(renderJevDecision(decision, "Screenshot skip assessment", { captureID: target.capture_id }));
      } catch (error) {
        assessment.removeAttribute("aria-busy");
        assessment.replaceChildren(node("p", error.message, "error-title"));
      } finally { assess.disabled = false; }
    });
    detailContent.prepend(actions);
    if (metadata.dataset.assessment) assessmentDisclosure.append(node("p", metadata.dataset.assessment, "muted"));
    assessmentDisclosure.append(assess, assessment);
    detailContent.append(assessmentDisclosure, removeActions);
    detail.append(detailContent);
    content.append(detail);
    card.append(preview, content);
    container.append(card);
  });
  filterCaptureTargets();
}

function renderAvailableSites(targets, selectedIDs = null) {
  const list = document.querySelector("#available-sites .asset-selection__list");
  const prior = new Map([...list.querySelectorAll("input[data-capture-id]")].map((input) => [input.dataset.captureId, input.checked]));
  list.replaceChildren();
  const eligible = targets.filter((target) => target.schedule_reviewed);
  if (!eligible.length) {
    list.append(node("p", "No reviewed sites yet. Add and review a site in the Sites section first.", "muted"));
    return;
  }
  eligible.forEach((target) => {
    const label = node("label", undefined, "asset-option");
    const checkbox = node("input");
    checkbox.type = "checkbox";
    checkbox.dataset.captureId = target.capture_id;
    checkbox.checked = selectedIDs ? selectedIDs.has(target.capture_id) : (prior.get(target.capture_id) ?? false);
    const preview = node("img", undefined, "asset-option__preview");
    preview.src = `/admin/api/assets/${target.sha256}`;
    preview.alt = "";
    preview.loading = "lazy";
    preview.decoding = "async";
    preview.addEventListener("error", () => { preview.hidden = true; }, { once: true });
    label.append(checkbox, preview, node("span", `${target.name ? `${target.name} · ` : ""}${target.display_url} · ${formatCaptureInterval(target.capture_interval_seconds)} · ${target.viewport.width} × ${target.viewport.height} px`));
    list.append(label);
  });
}

function deviceActionButtons(device, layout) {
  const toggle = button(device.enabled ? "Disable" : "Enable", device.enabled ? "secondary" : "primary");
  toggle.addEventListener("click", async () => {
    const nextEnabled = !device.enabled;
    const actionName = nextEnabled ? "Enable" : "Disable";
    const consequence = nextEnabled
      ? "This device will be able to sync again."
      : "This device will stop syncing until you enable it again.";
    try {
      const confirmed = await confirmBeforeAction(
        (text) => showConfirmDialog({
          title: `${actionName} device?`,
          description: text,
          confirmLabel: `${actionName} device`,
          destructive: !nextEnabled,
        }),
        `${actionName} device ${device.device_id}? ${consequence}`,
        () => api("/admin/api/devices/" + encodeURIComponent(device.device_id), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: nextEnabled }),
        }),
      );
      if (!confirmed) return;
      showMessage(formatDeviceEnabledMessage(device.device_id, nextEnabled), false, "device");
      await refresh();
    } catch (error) { showMessage(error.message, true, "device"); }
  });

  const buttons = [toggle];
  const remove = button("Delete device", "danger");
  remove.addEventListener("click", async () => {
    try {
      const confirmed = await confirmBeforeAction(
        (text) => showConfirmDialog({
          title: "Delete device?",
          description: text,
          confirmLabel: "Delete device",
          destructive: true,
        }),
        `Permanently delete ${device.device_id}? It will no longer be able to sync. Its health history will also be deleted.`,
        () => api(`/admin/api/devices/${encodeURIComponent(device.device_id)}`, { method: "DELETE" }),
      );
      if (!confirmed) return;
      showMessage(`Device ${device.device_id} was deleted.`, false, "device");
      await refresh();
    } catch (error) { showMessage(error.message, true, "device"); }
  });
  const moreActions = [remove];
  if (device.auth_type !== "key") {
    const rotate = button("Rotate device token", "danger");
    rotate.addEventListener("click", async () => {
      try {
        const { confirmed, result } = await confirmAction(
          (text) => showConfirmDialog({
            title: "Rotate device token?",
            description: text,
            confirmLabel: "Rotate device token",
            destructive: true,
          }),
          `The current token for ${device.device_id} will stop working. Update the device with the new token right away.`,
          () => api("/admin/api/devices/" + encodeURIComponent(device.device_id) + "/rotate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          }),
        );
        if (!confirmed) return;
        displaySecret(`New token for ${device.device_id}`, result.device_token);
        await refresh();
      } catch (error) { showMessage(error.message, true, "device"); }
    });
    moreActions.push(rotate);
  }
  const actions = node("div", undefined, layout === "card" ? "card-actions" : "table-actions");
  actions.append(...buttons, actionDisclosure(`More actions for ${device.device_id}`, moreActions));
  return actions;
}

function healthBadge(health) {
  const status = health?.status ?? "unknown";
  const labels = {
    healthy: ["Healthy", "success"],
    degraded: ["Degraded", "warning"],
    stale: ["Stale", "warning"],
    offline: ["Offline", "warning"],
    unknown: ["Unknown", "neutral"],
    starting: ["Starting", "neutral"],
    stopping: ["Stopping", "neutral"],
    disabled: ["Disabled", "neutral"],
  };
  const [label, tone] = labels[status] ?? labels.unknown;
  return statusBadge(label, tone);
}

function healthDetails(device) {
  const details = node("details", undefined, "device-health-details");
  details.append(node("summary", "Health details"));
  const content = node("div", undefined, "device-health-details__content");
  content.append(node("p", "Open to load device health and recent history.", "muted"));
  details.append(content);
  const healthDetailsLoader = createRetryableLoadOnce();
  details.addEventListener("toggle", async () => {
    if (!details.open || healthDetailsLoader.loaded) return;
    content.replaceChildren(node("p", "Loading health details…", "muted"));
    try {
      const devicePath = `/admin/api/devices/${encodeURIComponent(device.device_id)}`;
      const loadedData = await healthDetailsLoader.load(async () => {
        const [result, history] = await Promise.all([
          api(`${devicePath}/health`),
          api(`${devicePath}/health-history?limit=10`),
        ]);
        return { result, history };
      });
      if (!loadedData) return;
      const { result, history } = loadedData;
      const report = result.latest;
      content.replaceChildren();
      if (!report) {
        content.append(node("p", formatDeviceHealthDetails(result, history).message, "muted"));
        return;
      }
      const details = formatDeviceHealthDetails(result, history);
      details.summary.forEach((line, index) => {
        content.append(node("p", line, index === details.summary.length - 1 && report.startup_error_code ? "health-error" : undefined));
      });
      if (details.outputs.length) {
        const outputList = node("ul");
        details.outputs.forEach((line) => outputList.append(node("li", line)));
        content.append(outputList);
      }
      if (details.host.length) content.append(node("p", details.host.join(" · ")));
      content.append(node("h4", "Recent health changes"));
      if (!details.events.length) content.append(node("p", "No health changes recorded.", "muted"));
      else {
        const eventList = node("ul");
        details.events.forEach((line) => eventList.append(node("li", line)));
        content.append(eventList);
      }
      content.append(node("p", `${details.sampleCount} health samples in the last 30 days.`, "muted"));
    } catch (error) {
      content.replaceChildren(node("p", error.message, "health-error"));
    }
  });
  return details;
}

function deviceDetails(device) {
  const details = node("details", undefined, "device-details");
  details.append(node("summary", "Device details"));
  const list = node("dl", undefined, "device-details__list");
  const fields = [
    ["Authentication", device.auth_type === "key" ? "Key-based" : "Legacy token"],
    ["Last report", formatTimestamp(device.health?.received_at)],
    ["Playlist", device.health?.applied_playlist_id
      ? `${device.health.applied_playlist_id} / ${compactIdentifier(device.health.applied_revision)}`
      : "Not reported"],
  ];
  fields.forEach(([label, value]) => {
    const item = node("div");
    item.append(node("dt", label), node("dd", value));
    list.append(item);
  });
  details.append(list, healthDetails(device));
  return details;
}

function renderDevices(devices) {
  renderResponsiveRecords({
    tableSelector: "#devices",
    cardsSelector: "#devices-mobile",
    caption: "Enrolled devices",
    records: [...devices].sort((a, b) => {
      const needsReview = (device) => device.enabled && ["degraded", "stale", "offline", "unknown"].includes(device.health?.status ?? "unknown");
      return Number(needsReview(b)) - Number(needsReview(a));
    }),
    fields: [
      { label: "Device", render: (device) => identifier(device.device_id, "device ID", "device") },
      {
        label: "Status",
        render: (device) => statusBadge(device.enabled ? "Enabled" : "Disabled", device.enabled ? "success" : "neutral"),
      },
      { label: "Health", render: (device) => healthBadge(device.health) },
      { label: "Playback", render: (device) => {
        if (device.health?.last_error_code) return `Issue: ${device.health.last_error_code}`;
        const output = device.health?.outputs?.[0];
        if (!output) return "—";
        return output.error_code ? `${output.display_id}: ${output.error_code}` : `${output.display_id}: ${output.status}`;
      } },
      { label: "Details", render: (device) => deviceDetails(device) },
      { label: "Actions", render: (device, layout) => deviceActionButtons(device, layout) },
    ],
    emptyState: {
      message: "No devices have been approved yet. New devices appear here after you approve a request.",
    },
    cardTitleField: "Device",
    cardStatusField: "Status",
  });
}

function pendingRequestActions(request, layout) {
  const actions = node("div", undefined, layout === "card" ? "card-actions" : "table-actions");
  const approve = button("Approve", "primary");
  approve.addEventListener("click", async () => {
    try {
      const confirmed = await confirmBeforeAction(
        (text) => showConfirmDialog({
          title: "Approve device?",
          description: text,
          confirmLabel: "Approve device",
        }),
        formatEnrollmentApprovalPrompt(request),
        () => api(`/admin/api/enrollment-requests/${request.request_id}/approve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
      );
      if (!confirmed) return;
      showMessage(`Device ${request.device_id} was approved.`, false, "device");
      await refresh();
    } catch (error) { showMessage(error.message, true, "device"); }
  });

  const reject = button("Reject", "danger");
  reject.addEventListener("click", async () => {
    try {
      const confirmed = await confirmBeforeAction(
        (text) => showConfirmDialog({
          title: "Reject device request?",
          description: text,
          confirmLabel: "Reject request",
          destructive: true,
        }),
        `Reject the enrollment request from ${request.device_id}? The device will remain unable to sync.`,
        () => api(`/admin/api/enrollment-requests/${request.request_id}/reject`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
      );
      if (!confirmed) return;
      showMessage(`Device request for ${request.device_id} was rejected.`, false, "device");
      await refresh();
    } catch (error) { showMessage(error.message, true, "device"); }
  });
  actions.append(approve, reject);
  return actions;
}

function renderPendingEnrollments(requests) {
  const pendingDetails = document.querySelector("#pending-enrollments-details");
  const requestIDs = new Set(requests.map((request) => request.request_id));
  const hasNewRequest = requests.some((request) => !pendingEnrollmentIDs.has(request.request_id));
  document.querySelector("#pending-enrollment-count").textContent = requests.length
    ? `${requests.length} pending`
    : "No pending requests";
  if (!requests.length) pendingDetails.open = false;
  else if (!pendingEnrollmentsLoaded || hasNewRequest) pendingDetails.open = true;
  pendingEnrollmentIDs = requestIDs;
  pendingEnrollmentsLoaded = true;
  renderResponsiveRecords({
    tableSelector: "#pending-enrollments",
    cardsSelector: "#pending-enrollments-mobile",
    caption: "Devices awaiting approval",
    records: requests,
    fields: [
      { label: "Device", render: (request) => identifier(request.device_id, "device ID", "device") },
      { label: "Status", render: () => statusBadge("Awaiting approval", "warning") },
      { label: "Fingerprint", render: (request) => fingerprintDisplay(request.fingerprint) },
      { label: "First seen", render: (request) => formatTimestamp(request.created_at) },
      { label: "Expires", render: (request) => formatTimestamp(request.expires_at) },
      {
        label: "Existing device",
        render: (request) => request.replaces_existing ? "Yes, credentials will be replaced" : "No",
      },
      { label: "Actions", render: (request, layout) => pendingRequestActions(request, layout) },
    ],
    emptyState: {
      message: "No devices are waiting for approval. New devices appear here after they connect.",
    },
    cardTitleField: "Device",
    cardStatusField: "Status",
  });
}

function renderFleetAttention(overview, enrollmentRequests) {
  const items = summarizeFleetAttention(overview, enrollmentRequests);
  fleetAttention.replaceChildren();
  if (!items.length) {
    fleetAttention.classList.add("fleet-attention--clear");
    fleetAttention.append(node("p", "No current issues need attention.", "fleet-attention__clear"));
    return;
  }

  fleetAttention.classList.remove("fleet-attention--clear");
  fleetAttention.append(node("h3", "Needs attention"));
  const list = node("ul", undefined, "fleet-attention__list");
  items.forEach((item) => {
    const row = node("li");
    const link = node("a", undefined, "fleet-attention__link");
    link.href = item.href;
    link.append(
      node("strong", item.count),
      document.createTextNode(` ${item.count === 1 ? item.singular : item.plural}`),
    );
    row.append(link);
    list.append(row);
  });
  fleetAttention.append(list);
}

fleetAttention.addEventListener("click", (event) => {
  const link = event.target.closest("a[href^='#']");
  if (!link) return;
  const target = document.querySelector(link.getAttribute("href"));
  const disclosure = target?.closest("details");
  if (disclosure) disclosure.open = true;
});

function renderSubject(subjectType, subjectID) {
  const subjectLabel = String(subjectType ?? "Unknown");
  const displayType = subjectLabel.charAt(0).toUpperCase() + subjectLabel.slice(1);
  const value = node("div", undefined, "subject");
  value.append(node("span", displayType));
  value.append(identifier(subjectID, `${displayType} ID`, "activity"));
  return value;
}

function renderAuditDetails(metadata) {
  const details = formatAuditDetails(metadata);
  if (!details.length) return node("span", "—", "muted");
  const disclosure = node("details", undefined, "audit-details");
  disclosure.append(node("summary", `View details (${details.length})`));
  const list = node("dl", undefined, "audit-details__list");
  details.forEach(({ label, value }) => {
    const item = node("div");
    const description = node("dd");
    if (/^[A-Za-z0-9._:-]{25,}$/.test(value)) description.append(identifier(value, label, "activity"));
    else description.textContent = value;
    item.append(node("dt", label), description);
    list.append(item);
  });
  disclosure.append(list);
  return disclosure;
}

function emptyCard(messageTextValue, actionLabel, href) {
  return renderEmptyState(messageTextValue, actionLabel, href);
}

function renderAudit(events) {
  renderResponsiveRecords({
    tableSelector: "#audit",
    cardsSelector: "#audit-mobile",
    caption: "Recent activity",
    records: events,
    fields: [
      { label: "Time", render: (event) => formatTimestamp(event.occurred_at) },
      { label: "Actor", render: (event) => formatActorLabel(event.actor_id) },
      { label: "Action", render: (event) => formatAuditEventType(event.event_type) },
      { label: "Subject", render: (event) => renderSubject(event.subject_type, event.subject_id) },
      { label: "Details", render: (event) => renderAuditDetails(event.metadata) },
    ],
    emptyState: { message: "No activity yet. Management actions will appear here." },
    cardTitleField: "Action",
    cardActionField: null,
    cardClass: "data-card data-card--activity",
  });
}

async function refresh() {
  const [overview, enrollmentRequests, captureDecisions, intervals] = await Promise.all([
    api("/admin/api/overview"),
    api("/admin/api/enrollment-requests"),
    api("/admin/api/capture-decisions").catch(() => []),
    api("/admin/api/intervals"),
  ]);
  intervalDefinitions = intervals;
  populateIntervalSelect(document.querySelector("#playlist-form [name=rotation_interval]"), intervals.rotation.options,
    intervals.rotation.default, (option) => option.value);
  latestOverview = overview;
  document.querySelector("#sites-tile-status").textContent = `${(overview.capture_targets ?? []).length} sites`;
  document.querySelector("#playlists-tile-status").textContent = `${overview.playlists.length} playlist versions`;
  document.querySelector("#devices-tile-status").textContent = `${overview.devices.length} devices · ${enrollmentRequests.length} awaiting approval`;
  renderEnvironment(overview.environment);
  renderHealth(overview.asset_health);
  renderFleetAttention(overview, enrollmentRequests);
  renderPlaylists(overview.playlists);
  renderCaptureTargets(overview.capture_targets ?? [], captureDecisions, overview.capture_efficiency);
  renderAvailableSites(overview.capture_targets ?? []);
  renderDevices(overview.devices);
  renderPendingEnrollments(enrollmentRequests);
  renderAudit(overview.audit);
  if (!fleetSummaryInitialized) {
    fleetViewRuntime.renderProgram(OPENUI_STARTER_SOURCE);
    fleetSummaryInitialized = true;
  } else {
    fleetViewRuntime.refresh();
  }
}

function populateIntervalSelect(select, options, selectedValue, getValue) {
  const previous = select.value;
  select.replaceChildren();
  for (const option of options) {
    const item = node("option", option.label);
    item.value = String(getValue(option));
    select.append(item);
  }
  select.value = options.some((option) => String(getValue(option)) === previous)
    ? previous : String(selectedValue);
}

function resetIntervalSelections(form) {
  if (!intervalDefinitions) return;
  form.elements.namedItem("rotation_interval").value = intervalDefinitions.rotation.default;
}

function renderEnvironment(environment) {
  const status = formatEnvironmentNotice(environment);
  environmentTag.textContent = status.label;
  environmentNotice.classList.toggle("alert--warning", !status.production);
  environmentNotice.classList.toggle("alert--info", status.production);
  environmentNotice.replaceChildren();
  const lead = node("strong", status.heading);
  const detail = node("span", ` ${status.detail}`);
  environmentNotice.append(lead, detail);
  environmentNotice.hidden = false;
}

function renderFleetSummary(view) {
  if (!view) return;
  if (view.loading) {
    fleetSummary.setAttribute("aria-busy", "true");
    fleetSummary.replaceChildren(node("p", "Loading fleet summary…", "muted"));
    return;
  }
  fleetSummary.removeAttribute("aria-busy");
  if (view.errors.length) {
    fleetSummary.replaceChildren(node("p", view.errors.map((error) => error.message).join(" "), "error-title"));
    return;
  }
  try {
    fleetSummary.replaceChildren(renderOpenUIElement(view.root));
  } catch (error) {
    fleetSummary.replaceChildren(node("p", error.message, "error-title"));
  }
}

function renderJevDecision(result, title, { captureID } = {}) {
  const card = node("article", undefined, "jev-result");
  card.append(node("h3", title));
  const answers = node("div", undefined, "jev-result__answers");
  for (const [key, answer] of Object.entries(result.answers ?? {})) {
    const item = node("section", undefined, "jev-result__answer");
    const label = key.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
    item.append(node("h4", label));
    if (answer.type === "choice") item.append(node("p", `Recommendation: ${answer.choice.replaceAll("_", " ")}`));
    else if (answer.type === "score") {
      const maximum = Math.max(0, Object.keys(answer.legend ?? {}).length - 1);
      item.append(node("p", `Score: ${Number(answer.score).toFixed(2)} / ${maximum}`));
    } else if (answer.type === "noul") item.append(node("p", `Signal: ${Math.round(answer.noul * 100)}%`));
    if (Number.isFinite(answer.confidence)) item.append(node("p", `Confidence: ${Math.round(answer.confidence * 100)}%`, "muted"));
    if (answer.probabilities && typeof answer.probabilities === "object") {
      const probabilities = node("ul", undefined, "jev-result__probabilities");
      for (const [choice, probability] of Object.entries(answer.probabilities)) {
        const choiceLabel = answer.legend?.[choice] ?? choice.replaceAll("_", " ");
        const row = node("li", undefined, "jev-result__probability");
        row.append(node("span", choiceLabel), node("span", `${Math.round(probability * 100)}%`));
        probabilities.append(row);
      }
      item.append(probabilities);
    }
    answers.append(item);
  }
  card.append(answers, node("p", "Advisory only", "jev-advisory"));
  if (captureID && result.answers?.recommendation?.choice === "skip_once") {
    const eligibility = result.skip_eligibility;
    if (eligibility?.eligible && Number.isSafeInteger(eligibility.due_at)) {
      const confirmSkip = button("Confirm skip this screenshot once", "secondary");
      confirmSkip.addEventListener("click", async () => {
        const dueAt = eligibility.due_at;
        const confirmed = await showConfirmDialog({
          title: "Skip one scheduled screenshot?",
          description: `This skips the screenshot due ${formatTimestamp(dueAt)} once. The current image stays in use, and the next scheduled screenshot remains due as normal.`,
          confirmLabel: "Skip once",
        });
        if (!confirmed) return;
        confirmSkip.disabled = true;
        try {
          await api(`/admin/api/captures/${encodeURIComponent(captureID)}/skip-once`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ due_at: dueAt }),
          });
          confirmSkip.textContent = "Skip confirmed";
          showMessage("One scheduled screenshot skip is confirmed.", false, "playlist");
          await refresh();
        } catch (error) {
          confirmSkip.disabled = false;
          showMessage(error.message, true, "playlist");
        }
      });
      card.append(confirmSkip);
    } else {
      card.append(node("p", `This suggestion cannot be confirmed safely: ${eligibility?.reason || "the screenshot schedule changed"}`, "muted"));
    }
  }
  return card;
}

async function runFleetJevAnalysis() {
  const buttonElement = document.querySelector("#run-fleet-analysis");
  const result = document.querySelector("#fleet-analysis-result");
  buttonElement.disabled = true;
  result.setAttribute("aria-busy", "true");
  result.replaceChildren(node("p", "Analyzing current fleet signals…", "muted"));
  try {
    const decision = await api("/admin/api/jev/fleet-analysis", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    result.removeAttribute("aria-busy");
    result.replaceChildren(renderJevDecision(decision, "Fleet assessment"));
  } catch (error) {
    result.removeAttribute("aria-busy");
    result.replaceChildren(node("p", error.message, "error-title"));
  } finally { buttonElement.disabled = false; }
}

function showConfirmDialog({ title, description, confirmLabel, destructive = false }) {
  if (typeof confirmDialog.showModal !== "function") return Promise.resolve(window.confirm(description));
  confirmTitle.textContent = title;
  confirmDescription.textContent = description;
  confirmButton.textContent = confirmLabel;
  confirmButton.className = `button button--${destructive ? "danger" : "primary"}`;
  confirmCancel.textContent = "Cancel";
  confirmDialog.returnValue = "cancel";
  return new Promise((resolve) => {
    confirmDialog.addEventListener("close", () => resolve(confirmDialog.returnValue === "confirm"), { once: true });
    confirmDialog.showModal();
  });
}

document.querySelector("#run-fleet-analysis").addEventListener("click", runFleetJevAnalysis);

initModuleNavigation();

document.querySelector("#capture-site-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const feedback = document.querySelector("#capture-site-feedback");
  const submit = form.querySelector("button[type=submit]");
  submit.disabled = true;
  try {
    const result = await api("/admin/api/capture-sites", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: form.elements.namedItem("url").value,
        viewport: {
          width: Number(form.elements.namedItem("viewport_width").value),
          height: Number(form.elements.namedItem("viewport_height").value),
        },
      }),
    });
    form.reset();
    form.elements.namedItem("viewport_width").value = "1920";
    form.elements.namedItem("viewport_height").value = "1080";
    showInlineMessage(feedback, result.schedule_reviewed
      ? "This site already exists and its schedule has been reviewed."
      : "Site added with the default daily schedule. Review or confirm that schedule below.");
    await refresh();
  } catch (error) { showInlineMessage(feedback, error.message, true); }
  finally { submit.disabled = false; }
});

function displaySecret(title, value) {
  document.querySelector("#secret-title").textContent = title;
  document.querySelector("#secret-value").textContent = value;
  document.querySelector("#secret-panel").hidden = false;
  document.querySelector("#secret-panel").scrollIntoView({ behavior: "smooth", block: "center" });
  showMessage(`${title} created. Copy it before leaving this page.`, false, "credential");
}

document.querySelector("#reload").addEventListener("click", async (event) => {
  const refreshButton = event.currentTarget;
  refreshButton.disabled = true;
  try {
    await refresh();
  } catch (error) { showMessage(error.message, true); }
  finally { refreshButton.disabled = false; }
});

setInterval(() => {
  if (!document.hidden) refresh().catch(() => {});
}, 60_000);

document.querySelector("#playlist-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const feedback = document.querySelector("#playlist-feedback");
  const submitButton = formElement.querySelector("button[type=submit]");
  const form = new FormData(formElement);
  const files = [...form.getAll("assets")].filter((value) => value instanceof File && value.size > 0);
  const assets = playlistEditSource
    ? [...document.querySelectorAll("#playlist-current-assets input:checked")].map((input) => ({
      sha256: input.dataset.sha256,
      size: Number(input.dataset.size),
    }))
    : [];
  const selectedSites = [...document.querySelectorAll("#available-sites input:checked")].map((input) => ({
    capture_id: input.dataset.captureId,
  }));
  if (!files.length && !assets.length && !selectedSites.length) {
    return showInlineMessage(feedback, "Add at least one PNG image or capture site.", true);
  }
  submitButton.disabled = true;
  try {
    if (files.length) showInlineMessage(feedback, "Uploading your images…");
    for (const file of files) {
      if (file.type !== "image/png") throw new Error(file.name + " is not a PNG image");
      assets.push(await api("/admin/api/assets", {
        method: "POST", headers: { "Content-Type": file.type }, body: file,
      }));
    }
    const result = await api("/admin/api/playlists", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: form.get("id"),
        rotation_interval: form.get("rotation_interval"),
        assets,
        captures: selectedSites,
      }),
    });
    const captureNote = result.capture_count
      ? " Initial screenshots are queued after saving when capacity allows. Recent screenshots and active jobs may be reused."
      : "";
    showMessage(`New version ${compactIdentifier(result.revision)} is ready to activate.${captureNote}`, false, "playlist");
    formElement.reset();
    resetPlaylistEditor();
    resetIntervalSelections(formElement);
    await refresh();
  } catch (error) { showInlineMessage(feedback, error.message, true); }
  finally { submitButton.disabled = false; }
});

document.querySelector("#cancel-playlist-edit").addEventListener("click", () => {
  playlistForm().reset();
  resetPlaylistEditor();
  resetIntervalSelections(playlistForm());
  showMessage("Editing cancelled. Your saved versions are unchanged.", false, "playlist");
});

document.querySelector("#copy-secret").addEventListener("click", async () => {
  await copyValue(document.querySelector("#secret-value").textContent, "Value copied. Store it securely on the device.", "credential");
});

document.querySelector("#hide-secret").addEventListener("click", () => {
  document.querySelector("#secret-value").textContent = "";
  document.querySelector("#secret-panel").hidden = true;
});

refresh().catch((error) => showMessage(error.message, true));
