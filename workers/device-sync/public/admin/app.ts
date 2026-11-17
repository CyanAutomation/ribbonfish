import { api } from "./api.ts";
import { formatTimestamp } from "./admin-formatters.ts";
import { formatDeviceHealthDetails } from "./health-details.ts";
import { deviceNeedsReview } from "./device-needs-review.ts";
import { buildFleetInsights } from "./fleet-insights.ts";
import { requiredElement, requiredElements, requiredFormControl } from "./dom.ts";
import { formatCaptureObservation, formatRunTime } from "./capture-presentation.ts";
import {
  node,
  button,
  statusBadge,
  actionDisclosure,
  createDefinitionList,
  createFormField,
  createSettingsGroup,
  beginButtonBusy,
  setStatusNotice,
} from "./ui-primitives.ts";
import { createApiDashboardSourceEditor } from "./api-dashboard-editor.ts";
import { parseApiDashboardConfig } from "../../src/api-dashboard/config.ts";
import { renderApiDashboards } from "./api-dashboard-view.ts";
import { createCaptureTargetRenderer } from "./capture-sites-view.ts";
import { renderCaptureEfficiencyModule } from "./capture-efficiency-module.ts";
import { renderFleetOverviewMetrics } from "./fleet-overview.ts";
import {
  createBrandLockup,
  createActionGroup,
  createLoadingIndicator,
  createRecordCard,
  createRefreshCoordinator,
  createToolbar,
  renderFindingList,
  setPageHeaderMetadata,
  type RefreshMode,
} from "./ui-components.ts";
import { initModuleNavigation } from "./module-navigation.ts";
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
  formatEnrollmentApprovalPrompt,
  formatEnvironmentNotice,
  formatPlaylistState,
  playlistDeleteActionStates,
  formatScreenshotStatus,
  describeJevAnswer,
  formatJevAnswerLabel,
  prioritizeCaptureTargets,
  summarizeCaptureErrors,
} from "./ui-utils.ts";

requiredElement(document, "#brand-lockup").replaceWith(createBrandLockup({ ownerDocument: document }));
const ribbonfishLoading = createLoadingIndicator({ ownerDocument: document });
requiredElement(document, "#ribbonfish-loading").replaceWith(ribbonfishLoading.element);

const fleetSummary = requiredElement(document, "#fleet-summary");
const fleetAttention = requiredElement(document, "#fleet-attention");
const fleetDataAsOf = requiredElement(document, "#fleet-data-as-of");
const confirmDialog = requiredElement(document, "#confirm-dialog");
const confirmTitle = requiredElement(document, "#confirm-title");
const confirmDescription = requiredElement(document, "#confirm-description");
const confirmButton = requiredElement(document, "#confirm-submit");
const confirmCancel = requiredElement(document, "#confirm-cancel");
const environmentTag = requiredElement(document, "#environment-tag");
const environmentNotice = requiredElement(document, "#environment-notice");
const apiDashboardCreateForm = requiredElement<HTMLFormElement>(document, "#api-dashboard-form");
const apiDashboardCreateEditor = createApiDashboardSourceEditor(
  requiredElement(document, "#api-dashboard-source-list"),
  [],
  requiredFormControl<HTMLTextAreaElement>(apiDashboardCreateForm, "sources-json"),
);
let latestOverview: any = null;
let pendingEnrollmentsLoaded = false;
let pendingEnrollmentIDs = new Set<string>();
let playlistEditSource: { playlist_id: string; revision: string } | null = null;
let intervalDefinitions: any = null;
const feedbackSlots = new Map([...requiredElements(document, "[data-feedback-slot]")].map((element) => {
  const slot = {
    element,
    text: requiredElement(element, "[data-feedback-text]"),
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
    if (event.relatedTarget instanceof Node && element.contains(event.relatedTarget)) return;
    slot.focused = false;
    if (!slot.hovered && slot.transient) slot.timer.resume();
  });
  requiredElement(element, "[data-dismiss-feedback]").addEventListener("click", () => {
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
  setStatusNotice(slot.element, slot.text, text, isError ? "error" : "success");
  if (!isError) {
    if (slot.hovered || slot.focused) slot.timer.pause();
    else slot.timer.start();
  }
}

function showInfoMessage(text, context = "global") {
  const slot = feedbackSlots.get(context) ?? feedbackSlots.get("global");
  slot.timer.clear();
  slot.transient = false;
  setStatusNotice(slot.element, slot.text, text, "info");
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

function cell(label, value, className = undefined) {
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
        requiredElement(document, "#playlist-editor").open = true;
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
  cardStatusField = undefined,
  cardActionField = "Actions",
  cardClass = "data-card",
  cardHiddenFields = [],
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
  const tableContainer = typeof tableSelector === "string" ? requiredElement(document, tableSelector) : tableSelector;
  tableContainer.replaceChildren(table(
    caption,
    fields.map(({ label }) => label),
    rows,
    emptyState,
  ));

  const cards = typeof cardsSelector === "string" ? requiredElement(document, cardsSelector) : cardsSelector;
  cards.replaceChildren();
  if (!records.length) {
    cards.append(emptyCard(emptyState.message, emptyState.actionLabel, emptyState.href));
    return;
  }

  records.forEach((record) => {
    const recordFields = valuesFor(record, "card");
    const title = recordFields.find(({ label }) => label === cardTitleField);
    const status = recordFields.find(({ label }) => label === cardStatusField);
    const cardAction = recordFields.find(({ label }) => label === cardActionField);
    const detailsFields = recordFields.filter(({ label }) =>
      label !== cardTitleField && label !== cardStatusField && label !== cardActionField);
    const card = createRecordCard({
      title: title?.value instanceof HTMLElement ? title.value : title?.value == null ? "—" : String(title.value),
      status: status?.value instanceof HTMLElement ? status.value : undefined,
      fields: detailsFields,
      hiddenFields: cardHiddenFields,
      actions: cardAction?.value instanceof HTMLElement ? cardAction.value : undefined,
      className: cardClass,
      ownerDocument: cards.ownerDocument,
    });
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
  return requiredElement(document, "#playlist-form");
}

function playlistVersionKey(playlist) {
  return JSON.stringify([playlist.playlist_id, playlist.revision]);
}

function resetPlaylistEditor() {
  const form = playlistForm();
  const editor = requiredElement(document, "#playlist-editor");
  playlistEditSource = null;
  requiredElement(editor, "summary").textContent = "Create playlist version";
  editor.open = false;
  requiredElement(form, "#playlist-form-help").textContent =
    "Add PNG images and select reviewed sites from the library. Saved versions stay available until you delete the playlist.";
  requiredElement(form, "[name=assets]").required = false;
  requiredElement(form, "#playlist-submit").textContent = "Save playlist version";
  requiredElement(form, "#cancel-playlist-edit").hidden = true;
  for (const selector of ["#playlist-current-assets"]) {
    const selection = requiredElement(document, selector);
    requiredElement(selection, ".asset-selection__list").replaceChildren();
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
    requiredElement(document, "#playlist-editor").open = true;
    requiredElement(document, "#playlist-editor-summary").textContent = `Edit ${detail.playlist_id} playlist version`;
    requiredFormControl<HTMLInputElement>(form, "id").value = detail.playlist_id;
    requiredFormControl<HTMLSelectElement>(form, "rotation_interval").value = detail.rotation_interval;
    requiredElement(form, "#playlist-form-help").textContent =
      `Editing ${detail.playlist_id}, version ${compactIdentifier(detail.revision)}. Keep the images and sites you want, then save a new version. Saved versions do not change.`;
    requiredElement(form, "[name=assets]").required = false;
    requiredElement(form, "#playlist-submit").textContent = "Save as new version";
    requiredElement(form, "#cancel-playlist-edit").hidden = false;
    const selection = requiredElement(document, "#playlist-current-assets");
    const assetList = requiredElement(selection, ".asset-selection__list");
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
    requiredElement(document, "#playlist-feedback").hidden = true;
    form.scrollIntoView({ behavior: "smooth", block: "start" });
    requiredFormControl<HTMLInputElement>(form, "id").focus({ preventScroll: true });
  } catch (error) {
    showMessage(error.message, true, "playlist");
  }
}

function playlistActionButtons(playlist, deleteAction, layout) {
  const actions = [];
  const edit = button("Edit", "secondary");
  edit.setAttribute("aria-label", `Edit playlist ${playlist.playlist_id} from version ${compactIdentifier(playlist.revision)}`);
  edit.addEventListener("click", () => startPlaylistEdit(playlist));
  actions.push(edit);

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
    actions.push(activate);
  }

  if (deleteAction?.visible) {
    const remove = button("Delete playlist", deleteAction.disabled ? "secondary" : "danger");
    if (deleteAction.disabled) {
      remove.disabled = true;
      remove.setAttribute("aria-label", `Delete playlist unavailable. ${deleteAction.hint}`);
      actions.push(remove, node("p", deleteAction.hint, "playlist-delete-hint"));
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
      actions.push(actionDisclosure(`More actions for ${playlist.playlist_id}`, [remove]));
    }
  }
  return createActionGroup(actions, {
    label: `Actions for playlist ${playlist.playlist_id}, version ${compactIdentifier(playlist.revision)}`,
    className: layout === "card" ? "card-actions" : "table-actions",
    ownerDocument: document,
  });
}

function renderHealth(health) {
  const panel = requiredElement(document, "#asset-health");
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
  const desktop = requiredElement(document, "#playlists");
  const mobile = requiredElement(document, "#playlists-mobile");
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
    cardHiddenFields: ["Playlist"],
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
    renderResponsiveRecords({
      ...options,
      cardTitleField: "Version",
      tableSelector: tableContainer,
      cardsSelector: cardContainer,
      caption: `Versions of ${name}`,
      records: versions,
    });
  });
}

function filterCaptureTargets() {
  const query = requiredElement(document, "#capture-search").value.trim().toLocaleLowerCase();
  const activeFilter = requiredElement<HTMLButtonElement>(document, "#capture-site-filters [aria-pressed=\"true\"]").dataset.captureFilter;
  const cards = [...requiredElements<HTMLElement>(document, "#capture-target-list [data-capture-record]")];
  for (const card of cards) {
    card.hidden = !card.dataset.search.includes(query) || (activeFilter !== "all" && card.dataset.filter !== activeFilter);
  }
  const cardView = document.querySelector<HTMLElement>("#capture-target-cards");
  const tableView = document.querySelector<HTMLElement>("#capture-target-table-view");
  if (!cardView || !tableView) {
    requiredElement(document, "#capture-filter-empty").hidden = true;
    return;
  }
  const activeRecords = cardView.hidden
    ? requiredElements<HTMLElement>(tableView, "[data-capture-record]")
    : requiredElements<HTMLElement>(cardView, "[data-capture-record]");
  requiredElement(document, "#capture-filter-empty").hidden = !activeRecords.length || activeRecords.some((card) => !card.hidden);
}
requiredElement(document, "#capture-search").addEventListener("input", filterCaptureTargets);
requiredElements<HTMLButtonElement>(document, "#capture-site-filters [data-capture-filter]").forEach((filterButton) => {
  filterButton.addEventListener("click", () => {
    requiredElements<HTMLButtonElement>(document, "#capture-site-filters [data-capture-filter]").forEach((item) => {
      const selected = item === filterButton;
      item.setAttribute("aria-pressed", String(selected));
      item.classList.toggle("is-selected", selected);
    });
    filterCaptureTargets();
  });
});
const renderCaptureTargets = createCaptureTargetRenderer({
  getCaptureIntervalOptions: () => intervalDefinitions?.capture.options ?? [],
  filterCaptureTargets,
  showMessage,
  refresh: () => refresh(),
  showConfirmDialog,
  renderJevDecision,
});

function renderAvailableSites(targets, selectedIDs = null) {
  const list = requiredElement(document, "#available-sites .asset-selection__list");
  const prior = new Map([...requiredElements<HTMLInputElement>(list, "input[data-capture-id]")].map((input) => [input.dataset.captureId, input.checked]));
  list.replaceChildren();
  const eligible = targets.filter((target) => target.schedule_reviewed);
  if (!eligible.length) {
    list.append(node("p", "No reviewed capture sites or dashboards are available for playlists yet.", "muted"));
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
  return createActionGroup([
    ...buttons,
    actionDisclosure(`More actions for ${device.device_id}`, moreActions),
  ], {
    label: `Actions for device ${device.device_id}`,
    className: layout === "card" ? "card-actions" : "table-actions",
    ownerDocument: document,
  });
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
  let playlist: HTMLElement | string = "Not reported";
  if (device.health?.applied_playlist_id) {
    playlist = node("span", undefined, "device-details__playlist");
    playlist.append(
      node("span", device.health.applied_playlist_id),
      document.createTextNode(" / "),
      identifier(device.health.applied_revision, "playlist revision", "device"),
    );
  }
  const list = createDefinitionList([
    { label: "Authentication", value: device.auth_type === "key" ? "Key-based" : "Legacy token" },
    { label: "Last report", value: formatTimestamp(device.health?.received_at) },
    { label: "Playlist", value: playlist },
  ], { className: "device-details__list", ownerDocument: document });
  details.append(list, healthDetails(device));
  return details;
}

function renderDevices(devices, activePlaylist) {
  renderResponsiveRecords({
    tableSelector: "#devices",
    cardsSelector: "#devices-mobile",
    caption: "Enrolled devices",
    records: [...devices].sort((a, b) => {
      return Number(deviceNeedsReview(b, activePlaylist)) - Number(deviceNeedsReview(a, activePlaylist));
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
  return createActionGroup([approve, reject], {
    label: `Actions for enrollment request from ${request.device_id}`,
    className: layout === "card" ? "card-actions" : "table-actions",
    ownerDocument: document,
  });
}

function renderPendingEnrollments(requests) {
  const pendingDetails = requiredElement(document, "#pending-enrollments-details");
  const requestIDs = new Set<string>(requests.map((request) => request.request_id as string));
  const hasNewRequest = requests.some((request) => !pendingEnrollmentIDs.has(request.request_id));
  requiredElement(document, "#pending-enrollment-count").textContent = requests.length
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
  const items = buildFleetInsights(overview, enrollmentRequests);
  fleetAttention.replaceChildren(renderFindingList(items, { ownerDocument: fleetAttention.ownerDocument }));
  fleetDataAsOf.textContent = `Data as of ${formatTimestamp(overview.generated_at ?? Date.now())}`;
}

fleetAttention.addEventListener("click", (event) => {
  if (!(event.target instanceof Element)) return;
  const link = event.target.closest("a[href^='#']");
  if (!link) return;
  const target = requiredElement(document, link.getAttribute("href"));
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
  const list = createDefinitionList(details.map(({ label, value }) => ({
    label,
    value: /^[A-Za-z0-9._:-]{25,}$/.test(value) ? identifier(value, label, "activity") : value,
  })), { className: "audit-details__list", ownerDocument: document });
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

function hasUnsavedApiDashboardChanges() {
  return [...document.querySelectorAll<HTMLFormElement>("#api-dashboard-form, form[data-api-dashboard-edit]")]
    .some((form) => form.dataset.dirty === "true");
}

const runRefresh = createRefreshCoordinator({
  operation: refreshData,
  hasUnsavedChanges: hasUnsavedApiDashboardChanges,
  confirmDiscard: () => {
    if (!window.confirm("Discard unsaved API dashboard changes and refresh the dashboard list?")) return false;
    document.querySelectorAll<HTMLFormElement>("#api-dashboard-form, form[data-api-dashboard-edit]")
      .forEach((form) => {
        form.reset();
        delete form.dataset.dirty;
      });
    return true;
  },
  loading: ribbonfishLoading,
  isSkipped: (result) => result === false,
  onSkipped: () => showInfoMessage(
    "Refresh paused to protect your unsaved API dashboard edits. Save or cancel the edit, then refresh again.",
    "dashboards",
  ),
});

function refresh(mode: RefreshMode = "action") {
  return runRefresh(mode);
}

async function refreshData(): Promise<boolean> {
  const [overview, enrollmentRequests, captureDecisions, intervals, apiDashboards] = await Promise.all([
    api("/admin/api/overview"),
    api("/admin/api/enrollment-requests"),
    api("/admin/api/capture-decisions").catch(() => []),
    api("/admin/api/intervals"),
    api("/admin/api/api-dashboards").catch(() => []),
  ]);
  if (hasUnsavedApiDashboardChanges()) return false;
  intervalDefinitions = intervals;
  populateIntervalSelect(requiredElement(document, "#playlist-form [name=rotation_interval]"), intervals.rotation.options,
    intervals.rotation.default, (option) => option.value);
  latestOverview = overview;
  const browserTargets = (overview.capture_targets ?? []).filter((target) => target.capture_type !== "api-dashboard");
  const dashboardAttention = apiDashboards.filter((dashboard) => dashboard.last_error || dashboard.stale).length;
  setPageHeaderMetadata(requiredElement(document, "#dashboards-section > .page-header"), [
    `${apiDashboards.length} API dashboards`,
    `${dashboardAttention} need attention`,
  ]);
  setPageHeaderMetadata(requiredElement(document, "#playlist-section > .page-header"), [
    `${overview.playlists.length} saved versions`,
    overview.active_playlist ? `Active playlist: ${overview.active_playlist.playlist_id}` : "No active playlist",
  ]);
  setPageHeaderMetadata(requiredElement(document, "#device-section > .page-header"), [
    `${overview.devices.length} devices`,
    `${enrollmentRequests.length} awaiting approval`,
  ]);
  setPageHeaderMetadata(requiredElement(document, "#activity-section > .page-header"), [
    `${overview.audit.length} recent events`,
  ]);
  renderEnvironment(overview.environment);
  renderHealth(overview.asset_health);
  renderFleetAttention(overview, enrollmentRequests);
  renderFleetOverviewMetrics(fleetSummary, overview, enrollmentRequests);
  renderPlaylists(overview.playlists);
  renderCaptureEfficiencyModule(
    requiredElement(document, "#capture-efficiency-content"),
    browserTargets,
    overview.capture_efficiency,
  );
  renderCaptureTargets(browserTargets, captureDecisions);
  renderApiDashboards(apiDashboards, { showMessage, refresh, showConfirmDialog });
  renderAvailableSites(overview.capture_targets ?? []);
  renderDevices(overview.devices, overview.active_playlist);
  renderPendingEnrollments(enrollmentRequests);
  renderAudit(overview.audit);
  return true;
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
  environmentTag.classList.toggle("environment-tag--warning", !status.production);
  environmentNotice.classList.toggle("alert--warning", !status.production);
  environmentNotice.classList.remove("alert--info");
  if (status.production) {
    environmentNotice.hidden = true;
    environmentNotice.replaceChildren();
    delete environmentNotice.dataset.message;
    return;
  }
  const message = `${status.heading} ${status.detail}`.trim();
  if (environmentNotice.dataset.message !== message) {
    environmentNotice.replaceChildren();
    environmentNotice.append(node("strong", status.heading), node("span", ` ${status.detail}`));
    environmentNotice.dataset.message = message;
  }
  environmentNotice.hidden = false;
}

function renderJevDecision(
  result: {
    answers?: Record<string, { type?: string; choice?: string; score?: number; legend?: Record<string, string> }>;
    duration_review?: string;
    skip_eligibility?: { eligible?: boolean; due_at?: number; reason?: string };
  },
  title: string,
  { captureID }: { captureID?: string } = {},
) {
  const card = node("article", undefined, "jev-result");
  card.append(node("h3", title));
  const answers = node("div", undefined, "jev-result__answers");
  for (const [key, answer] of Object.entries(result.answers ?? {})) {
    const item = node("section", undefined, "jev-result__answer");
    item.append(node("h4", formatJevAnswerLabel(key)));
    const description = describeJevAnswer(key, answer, result.duration_review);
    if (description) item.append(node("p", description));
    answers.append(item);
  }
  card.append(answers, node("p", "Advisory only", "jev-advisory"));
  appendSkipOnceRecommendation(card, result, captureID);
  return card;
}

function appendSkipOnceRecommendation(card, result, captureID) {
  if (!captureID || result.answers?.recommendation?.choice !== "skip_once") return;
  const eligibility = result.skip_eligibility;
  if (!eligibility?.eligible || !Number.isSafeInteger(eligibility.due_at)) {
    card.append(node("p", `This suggestion cannot be confirmed safely: ${eligibility?.reason || "the screenshot schedule changed"}`, "muted"));
    return;
  }
  const confirmSkip = button("Confirm skip this screenshot once", "secondary");
  confirmSkip.addEventListener("click", () => confirmSkipOnce(confirmSkip, eligibility.due_at, captureID));
  card.append(confirmSkip);
}

async function confirmSkipOnce(confirmSkip, dueAt, captureID) {
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
}

function showConfirmDialog({ title, description, confirmLabel, destructive = false }) {
  if (typeof confirmDialog.showModal !== "function") return Promise.resolve(window.confirm(description));
  confirmTitle.textContent = title;
  confirmDescription.textContent = description;
  confirmButton.textContent = confirmLabel;
  confirmButton.className = `button button--${destructive ? "danger" : "primary"}`;
  confirmCancel.textContent = "Cancel";
  confirmDialog.returnValue = "cancel";
  return new Promise<boolean>((resolve) => {
    confirmDialog.addEventListener("close", () => resolve(confirmDialog.returnValue === "confirm"), { once: true });
    confirmDialog.showModal();
  });
}

initModuleNavigation();

requiredElement(document, "#capture-site-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const feedback = requiredElement(document, "#capture-site-feedback");
  const submit = requiredElement(form, "button[type=submit]");
  const finishBusy = beginButtonBusy(submit, "Adding site…", feedback);
  try {
    const result = await api("/admin/api/capture-sites", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: requiredFormControl<HTMLInputElement>(form, "url").value,
        viewport: {
          width: Number(requiredFormControl<HTMLInputElement>(form, "viewport_width").value),
          height: Number(requiredFormControl<HTMLInputElement>(form, "viewport_height").value),
        },
      }),
    });
    form.reset();
    requiredFormControl<HTMLInputElement>(form, "viewport_width").value = "1920";
    requiredFormControl<HTMLInputElement>(form, "viewport_height").value = "1080";
    showInlineMessage(feedback, result.schedule_reviewed
      ? "This site already exists and its schedule has been reviewed."
      : "Site added with the default daily schedule. Open Edit and confirm the schedule before adding this site to a playlist.");
    const dialog = requiredElement<HTMLDialogElement>(document, "#capture-site-dialog");
    if (dialog.open) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    }
    await refresh();
  } catch (error) { showInlineMessage(feedback, error.message, true); }
  finally { finishBusy(); }
});

apiDashboardCreateForm.addEventListener("input", () => { apiDashboardCreateForm.dataset.dirty = "true"; });
apiDashboardCreateForm.addEventListener("change", () => { apiDashboardCreateForm.dataset.dirty = "true"; });
window.addEventListener("beforeunload", (event) => {
  const dirty = [...document.querySelectorAll<HTMLFormElement>("#api-dashboard-form, form[data-api-dashboard-edit]")]
    .some((form) => form.dataset.dirty === "true");
  if (dirty) { event.preventDefault(); event.returnValue = ""; }
});

apiDashboardCreateForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const feedback = requiredElement(document, "#api-dashboard-feedback");
  const submit = requiredElement(form, "button[type=submit]");
  const finishBusy = beginButtonBusy(submit, "Creating dashboard…", feedback);
  try {
    if (!apiDashboardCreateEditor.validate()) throw new Error("Fix the highlighted source fields before creating the dashboard.");
    const config = parseApiDashboardConfig({
      sources: apiDashboardCreateEditor.getSources(),
      width: Number(requiredFormControl<HTMLInputElement>(form, "width").value),
      height: Number(requiredFormControl<HTMLInputElement>(form, "height").value),
    });
    await api("/admin/api/api-dashboards", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: requiredFormControl<HTMLInputElement>(form, "name").value,
        capture_interval_seconds: Number(requiredFormControl<HTMLSelectElement>(form, "capture_interval_seconds").value),
        ...config,
      }),
    });
    form.dataset.dirty = "false";
    showInlineMessage(feedback, "API dashboard created. Run it now or add it to a playlist to schedule refreshes.");
    await refresh();
  } catch (error) { showInlineMessage(feedback, error.message, true); }
  finally { finishBusy(); }
});

function displaySecret(title, value) {
  requiredElement(document, "#secret-title").textContent = title;
  requiredElement(document, "#secret-value").textContent = value;
  requiredElement(document, "#secret-panel").hidden = false;
  requiredElement(document, "#secret-panel").scrollIntoView({ behavior: "smooth", block: "center" });
  showMessage(`${title} created. Copy it before leaving this page.`, false, "credential");
}

requiredElement(document, "#reload").addEventListener("click", async (event) => {
  const refreshButton = event.currentTarget as HTMLButtonElement;
  refreshButton.disabled = true;
  try {
    await refresh("manual");
  } catch (error) { showMessage(error.message, true); }
  finally { refreshButton.disabled = false; }
});

setInterval(() => {
  if (!document.hidden) refresh("background").catch(() => {});
}, 60_000);

requiredElement(document, "#playlist-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget as HTMLFormElement;
  const feedback = requiredElement(document, "#playlist-feedback");
  const submitButton = requiredElement(formElement, "button[type=submit]");
  const form = new FormData(formElement);
  const files = form.getAll("assets").filter((value): value is File => value instanceof File && value.size > 0);
  const assets = playlistEditSource
    ? [...requiredElements(document, "#playlist-current-assets input:checked")].map((input) => ({
      sha256: input.dataset.sha256,
      size: Number(input.dataset.size),
    }))
    : [];
  const selectedSites = [...requiredElements<HTMLInputElement>(document, "#available-sites input:checked")].map((input) => ({
    capture_id: input.dataset.captureId,
  }));
  if (!files.length && !assets.length && !selectedSites.length) {
    return showInlineMessage(feedback, "Add at least one PNG image or capture site.", true);
  }
  const finishBusy = beginButtonBusy(
    submitButton,
    files.length ? "Uploading images…" : "Saving playlist version…",
    feedback,
  );
  try {
    if (files.length) showInlineMessage(feedback, "Uploading your images…");
    for (const file of files) {
      if (file.type !== "image/png") throw new Error(file.name + " is not a PNG image");
      assets.push(await api("/admin/api/assets", {
        method: "POST", headers: { "Content-Type": file.type }, body: file,
      }));
    }
    if (files.length) {
      submitButton.textContent = "Saving playlist version…";
      feedback.textContent = "Saving playlist version…";
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
    feedback.textContent = "";
    feedback.hidden = true;
  } catch (error) { showInlineMessage(feedback, error.message, true); }
  finally { finishBusy(); }
});

requiredElement(document, "#cancel-playlist-edit").addEventListener("click", () => {
  playlistForm().reset();
  resetPlaylistEditor();
  resetIntervalSelections(playlistForm());
  showMessage("Editing cancelled. Your saved versions are unchanged.", false, "playlist");
});

requiredElement(document, "#copy-secret").addEventListener("click", async () => {
  await copyValue(requiredElement(document, "#secret-value").textContent, "Value copied. Store it securely on the device.", "credential");
});

requiredElement(document, "#hide-secret").addEventListener("click", () => {
  requiredElement(document, "#secret-value").textContent = "";
  requiredElement(document, "#secret-panel").hidden = true;
});

refresh("initial")
  .catch((error) => showMessage(error.message, true));
