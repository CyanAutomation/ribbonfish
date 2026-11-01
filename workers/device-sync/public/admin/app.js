import {
  createFleetOpenUI,
  OPENUI_STARTER_SOURCE,
  renderOpenUIElement,
} from "./openui-core.js";
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
  hasPageURLs,
  parsePageURLs,
  summarizeFleetAttention,
} from "./ui-utils.js";

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
const fleetViewRuntime = createFleetOpenUI({ getOverview: async () => latestOverview });

fleetViewRuntime.subscribe(renderFleetSummary);

function node(tag, text, className) {
  const value = document.createElement(tag);
  if (text !== undefined && text !== null) value.textContent = String(text);
  if (className) value.className = className;
  return value;
}

function button(text, variant = "primary") {
  const value = node("button", text, `button button--${variant}`);
  value.type = "button";
  return value;
}

async function api(path, options = {}) {
  const response = await fetch(path, { cache: "no-store", ...options });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Something went wrong. Please try again.");
  return result;
}

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
  document.querySelector(tableSelector).replaceChildren(table(
    caption,
    fields.map(({ label }) => label),
    rows,
    emptyState,
  ));

  const cards = document.querySelector(cardsSelector);
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

function statusBadge(text, tone = "success") {
  const toneClass = tone === "success" ? "badge" : `badge badge--${tone}`;
  return node("span", text, toneClass);
}

function playlistForm() {
  return document.querySelector("#playlist-form");
}

function playlistVersionKey(playlist) {
  return JSON.stringify([playlist.playlist_id, playlist.revision]);
}

function syncScreenshotSettings() {
  const settings = document.querySelector("#screenshot-settings");
  const visible = hasPageURLs(document.querySelector('[name="capture_urls"]').value);
  settings.hidden = !visible;
  settings.disabled = !visible;
}

function resetPlaylistEditor() {
  const form = playlistForm();
  const editor = document.querySelector("#playlist-editor");
  playlistEditSource = null;
  editor.querySelector("summary").textContent = "Create playlist version";
  editor.open = false;
  form.querySelector("#playlist-form-help").textContent =
    "Add PNG images or page URLs. Images and screenshots can be reused across playlists. Saved versions stay available until you delete the playlist.";
  form.querySelector("[name=assets]").required = false;
  form.querySelector("#playlist-submit").textContent = "Save playlist version";
  form.querySelector("#cancel-playlist-edit").hidden = true;
  for (const selector of ["#playlist-current-assets", "#playlist-current-captures"]) {
    const selection = document.querySelector(selector);
    selection.querySelector(".asset-selection__list").replaceChildren();
    selection.hidden = true;
  }
  syncScreenshotSettings();
}

async function startPlaylistEdit(playlist) {
  try {
    const detail = await api(
      `/admin/api/playlists/${encodeURIComponent(playlist.playlist_id)}/${encodeURIComponent(playlist.revision)}`,
    );
    const form = playlistForm();
    form.reset();
    resetPlaylistEditor();
    playlistEditSource = { playlist_id: detail.playlist_id, revision: detail.revision };
    document.querySelector("#playlist-editor").open = true;
    document.querySelector("#playlist-editor-summary").textContent = `Edit ${detail.playlist_id} playlist version`;
    form.elements.namedItem("id").value = detail.playlist_id;
    form.elements.namedItem("rotation_interval").value = detail.rotation_interval;
    form.querySelector("#playlist-form-help").textContent =
      `Editing ${detail.playlist_id}, version ${compactIdentifier(detail.revision)}. Keep the images and page URLs you want, then save a new version. Saved versions do not change.`;
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
    const captureSelection = document.querySelector("#playlist-current-captures");
    const captureList = captureSelection.querySelector(".asset-selection__list");
    captureList.replaceChildren();
    (detail.captures ?? []).forEach((capture, index) => {
      const label = node("label", undefined, "asset-option");
      const checkbox = node("input");
      checkbox.type = "checkbox";
      checkbox.checked = true;
      checkbox.dataset.captureId = capture.capture_id;
      const preview = node("img", undefined, "asset-option__preview");
      preview.src = `/admin/api/assets/${capture.sha256}`;
      preview.alt = "";
      preview.loading = "lazy";
      preview.decoding = "async";
      preview.addEventListener("error", () => { preview.hidden = true; }, { once: true });
      const caption = node("span", `Keep page ${index + 1} · ${capture.url}`);
      label.append(checkbox, preview, caption);
      captureList.append(label);
    });
    captureSelection.hidden = !(detail.captures ?? []).length;
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
      actions.append(remove);
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
  renderResponsiveRecords({
    tableSelector: "#playlists",
    cardsSelector: "#playlists-mobile",
    caption: "Playlist versions",
    records: playlists,
    fields,
    emptyState: {
      message: "No playlists yet. Add images or page URLs to create your first playlist version.",
      actionLabel: "Create playlist version",
      href: "#playlist-editor",
    },
    cardTitleField: "Playlist",
    cardStatusField: "Status",
  });
}

function renderCaptureTargets(targets, decisions = []) {
  const decisionByTarget = new Map(decisions.map((decision) => [decision.capture_id, decision]));
  const container = document.querySelector("#capture-target-list");
  container.replaceChildren();
  if (!targets.length) {
    container.append(node("p", "No page screenshots yet. Add a page URL to a playlist to create one.", "muted"));
    return;
  }
  targets.forEach((target) => {
    const card = node("article", undefined, "capture-target");
    const preview = node("img", undefined, "capture-target__preview");
    preview.src = `/admin/api/assets/${target.sha256}`;
    preview.alt = `Latest screenshot or placeholder image for ${target.display_url}`;
    preview.loading = "lazy";
    preview.decoding = "async";
    preview.addEventListener("error", () => { preview.hidden = true; }, { once: true });

    const content = node("div", undefined, "capture-target__content");
    const heading = node("div", undefined, "capture-target__heading");
    heading.append(node("h4", target.display_url));
    const screenshotStatus = formatScreenshotStatus(target.job_status, target.last_error, target.last_success_at);
    heading.append(statusBadge(screenshotStatus.label, screenshotStatus.tone));
    content.append(heading);
    content.append(node("p", target.last_success_at ? `Last screenshot ${formatTimestamp(target.last_success_at)}` : "No screenshot is ready yet.", "muted"));
    if (target.last_error) content.append(node("p", `Screenshot error: ${target.last_error}`, "capture-target__error error-title"));

    const metadata = node("details", undefined, "capture-target__details");
    metadata.append(node("summary", "Schedule and screenshot details"));
    metadata.append(node("p", `${formatCaptureInterval(target.capture_interval_seconds)} · ${target.viewport.width} × ${target.viewport.height} px`, "muted"));
    if (target.last_error) metadata.append(node("p", `Full error: ${target.last_error}`, "error-title"));
    if (Number.isSafeInteger(target.next_due_at)) metadata.append(node("p", `Next screenshot ${formatTimestamp(target.next_due_at)}`, "muted"));
    const backgroundDecision = decisionByTarget.get(target.capture_id);
    if (backgroundDecision) {
      const suggestion = backgroundDecision.action === "defer_once" ? "A later capture could be suitable" :
        backgroundDecision.action === "error" ? "Assessment unavailable" : "Keep the scheduled capture";
      metadata.append(node("p", `Background assessment ${formatTimestamp(backgroundDecision.assessed_at)} for ${formatTimestamp(backgroundDecision.due_at)}: ${suggestion}. ${backgroundDecision.reason} The schedule was unchanged.`, "muted"));
    }

    content.append(metadata);

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
        showMessage(`Screenshot job ${compactIdentifier(result.job_id)} ${status}.`, false, "playlist");
        await refresh();
      } catch (error) { showMessage(error.message, true, "playlist"); }
      finally { capture.disabled = false; }
    });
    actions.append(capture);
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
    content.append(actions);
    assessmentDisclosure.append(assess, assessment);
    content.append(assessmentDisclosure);
    card.append(preview, content);
    container.append(card);
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
    buttons.push(rotate);
  }
  const actions = node("div", undefined, layout === "card" ? "card-actions" : "table-actions");
  actions.append(...buttons);
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
    records: devices,
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
  const [overview, enrollmentRequests, captureDecisions] = await Promise.all([
    api("/admin/api/overview"),
    api("/admin/api/enrollment-requests"),
    api("/admin/api/capture-decisions").catch(() => []),
  ]);
  latestOverview = overview;
  renderEnvironment(overview.environment);
  renderHealth(overview.asset_health);
  renderFleetAttention(overview, enrollmentRequests);
  renderPlaylists(overview.playlists);
  renderCaptureTargets(overview.capture_targets ?? [], captureDecisions);
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

const sectionLinks = [...document.querySelectorAll(".section-nav a")];
document.querySelector(".section-nav").addEventListener("click", (event) => {
  const link = event.target.closest("a[href^='#']");
  if (!link) return;
  const target = document.querySelector(link.getAttribute("href"));
  const disclosure = target?.closest("details");
  if (disclosure) disclosure.open = true;
  const more = link.closest(".section-nav__more");
  if (more) more.open = false;
});
const observedSections = sectionLinks
  .map((link) => document.querySelector(link.getAttribute("href")))
  .filter(Boolean);
if ("IntersectionObserver" in window) {
  const visibleSections = new Set();
  const sectionObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) visibleSections.add(entry.target);
      else visibleSections.delete(entry.target);
    });
    const current = [...visibleSections]
      .sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top)[0];
    if (!current) return;
    sectionLinks.forEach((link) => {
      if (link.hash === `#${current.id}`) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    });
  }, { rootMargin: "-20% 0px -65% 0px", threshold: [0, 0.1, 0.5] });
  observedSections.forEach((section) => sectionObserver.observe(section));
} else {
  sectionLinks[0]?.setAttribute("aria-current", "location");
}

document.querySelector('[name="capture_urls"]').addEventListener("input", syncScreenshotSettings);

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
  const captures = [...document.querySelectorAll("#playlist-current-captures input:checked")].map((input) => ({
    capture_id: input.dataset.captureId,
  }));
  const newURLs = parsePageURLs(form.get("capture_urls"));
  const captureInterval = Number(form.get("capture_interval_seconds"));
  const viewport = {
    width: Number(form.get("viewport_width")),
    height: Number(form.get("viewport_height")),
  };
  if (!files.length && !assets.length && !captures.length && !newURLs.length) {
    return showInlineMessage(feedback, "Add at least one PNG image or page URL.", true);
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
        captures: captures.concat(newURLs.map((url) => ({
          url,
          capture_interval_seconds: captureInterval,
          viewport,
        }))),
      }),
    });
    const captureNote = result.capture_count
      ? " Initial screenshots are queued after saving when capacity allows. Recent screenshots and active jobs may be reused."
      : "";
    showMessage(`New version ${compactIdentifier(result.revision)} is ready to activate.${captureNote}`, false, "playlist");
    formElement.reset();
    resetPlaylistEditor();
    await refresh();
  } catch (error) { showInlineMessage(feedback, error.message, true); }
  finally { submitButton.disabled = false; }
});

document.querySelector("#cancel-playlist-edit").addEventListener("click", () => {
  playlistForm().reset();
  resetPlaylistEditor();
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
