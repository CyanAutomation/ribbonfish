import {
  createFleetOpenUI,
  OPENUI_STARTER_SOURCE,
  OPENUI_SYSTEM_PROMPT,
  renderOpenUIElement,
} from "./openui-core.js";
import {
  compactIdentifier,
  confirmBeforeAction,
  formatActorLabel,
  formatAuditDetails,
  formatAuditEventType,
  formatDeviceEnabledMessage,
  formatEnvironmentNotice,
  formatTimestamp,
} from "./ui-utils.js";

const message = document.querySelector("#message");
const messageText = document.querySelector("#message-text");
const openuiPreview = document.querySelector("#openui-preview");
const openuiSource = document.querySelector("#openui-source");
const openuiMessage = document.querySelector("#openui-message");
const openuiPrompt = document.querySelector("#openui-prompt-text");
const confirmDialog = document.querySelector("#confirm-dialog");
const confirmTitle = document.querySelector("#confirm-title");
const confirmDescription = document.querySelector("#confirm-description");
const confirmButton = document.querySelector("#confirm-submit");
const confirmCancel = document.querySelector("#confirm-cancel");
const environmentTag = document.querySelector("#environment-tag");
const environmentNotice = document.querySelector("#environment-notice");
let latestOverview = null;
let openuiProgram = OPENUI_STARTER_SOURCE;
let openuiInitialized = false;
let playlistEditSource = null;
const openuiRuntime = createFleetOpenUI({ getOverview: async () => latestOverview });
openuiSource.value = OPENUI_STARTER_SOURCE;
openuiPrompt.textContent = OPENUI_SYSTEM_PROMPT;

openuiRuntime.subscribe(renderOpenUIView);

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

function showMessage(text, isError = false) {
  messageText.textContent = text;
  message.classList.toggle("alert--success", !isError);
  message.classList.toggle("alert--error", isError);
  message.setAttribute("role", isError ? "alert" : "status");
  message.setAttribute("aria-live", isError ? "assertive" : "polite");
  message.hidden = false;
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
    const content = node("div", undefined, "empty-state");
    content.append(node("p", emptyState.message));
    if (emptyState.actionLabel && emptyState.href) {
      const action = node("a", emptyState.actionLabel, "button button--secondary button--small");
      action.href = emptyState.href;
      content.append(action);
    }
    cell.append(content);
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

function identifier(value, label) {
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
    copy.addEventListener("click", () => copyValue(fullValue, `${label} copied.`));
    wrapper.append(copy);
  }
  return wrapper;
}

async function copyValue(value, successMessage) {
  try {
    await navigator.clipboard.writeText(value);
    showMessage(successMessage);
  } catch {
    showMessage("Clipboard access failed. Select and copy the value manually.", true);
  }
}

function statusBadge(text, tone = "success") {
  const toneClass = tone === "success" ? "badge" : `badge badge--${tone}`;
  return node("span", text, toneClass);
}

function playlistForm() {
  return document.querySelector("#playlist-form");
}

function resetPlaylistEditor() {
  const form = playlistForm();
  playlistEditSource = null;
  form.querySelector("h3").textContent = "Create a playlist revision";
  form.querySelector("#playlist-form-help").textContent =
    "Upload the images you want in this version. Saved revisions stay available until you delete their playlist.";
  form.querySelector("[name=assets]").required = true;
  form.querySelector("#playlist-submit").textContent = "Upload and save revision";
  form.querySelector("#cancel-playlist-edit").hidden = true;
  const selection = document.querySelector("#playlist-current-assets");
  selection.querySelector(".asset-selection__list").replaceChildren();
  selection.hidden = true;
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
    form.elements.namedItem("id").value = detail.playlist_id;
    form.elements.namedItem("rotation_interval").value = detail.rotation_interval;
    form.querySelector("h3").textContent = "Edit playlist as a new revision";
    form.querySelector("#playlist-form-help").textContent =
      `Editing ${detail.playlist_id} from ${compactIdentifier(detail.revision)}. Keep the images you want, add PNGs if you like, then save a new revision. This revision stays unchanged.`;
    form.querySelector("[name=assets]").required = false;
    form.querySelector("#playlist-submit").textContent = "Save new revision";
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
    document.querySelector("#playlist-feedback").hidden = true;
    form.scrollIntoView({ behavior: "smooth", block: "start" });
    form.elements.namedItem("id").focus({ preventScroll: true });
  } catch (error) {
    showMessage(error.message, true);
  }
}

function playlistActionButtons(playlist, canDelete, revisionCount) {
  const actions = node("div", undefined, "table-actions");
  const edit = button("Edit", "secondary");
  edit.setAttribute("aria-label", `Edit playlist ${playlist.playlist_id} from revision ${compactIdentifier(playlist.revision)}`);
  edit.addEventListener("click", () => startPlaylistEdit(playlist));
  actions.append(edit);

  if (!playlist.active) {
    const activate = button("Activate", "primary");
    activate.addEventListener("click", async () => {
      const description = `Make “${playlist.playlist_id}” revision ${compactIdentifier(playlist.revision)} the active playlist. Enrolled devices will receive it the next time they sync.`;
      try {
        const confirmed = await confirmBeforeAction(
          (text) => showConfirmDialog({
            title: "Activate playlist revision?",
            description: text,
            confirmLabel: "Activate playlist",
          }),
          description,
          () => api("/admin/api/active-playlist", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ playlist_id: playlist.playlist_id, revision: playlist.revision }),
          }),
        );
        if (!confirmed) return;
        showMessage(`Playlist “${playlist.playlist_id}” is active. Devices will receive it on their next sync.`);
        await refresh();
      } catch (error) { showMessage(error.message, true); }
    });
    actions.append(activate);
  }

  if (canDelete) {
    const remove = button("Delete playlist", "danger");
    remove.addEventListener("click", async () => {
      const description = `Delete “${playlist.playlist_id}” and all ${revisionCount} of its saved revisions? Uploaded PNGs stay in storage and can be reused by another playlist.`;
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
        showMessage(`Playlist “${playlist.playlist_id}” was deleted. Uploaded images remain available for reuse.`);
        await refresh();
      } catch (error) { showMessage(error.message, true); }
    });
    actions.append(remove);
  }
  return actions;
}

function renderPlaylistCard(playlist, canDelete, revisionCount) {
  const card = node("article", undefined, "data-card");
  const header = node("div", undefined, "data-card__header");
  header.append(node("h3", playlist.playlist_id), statusBadge(
    playlist.active ? "Active" : "Staged",
    playlist.active ? "success" : "neutral",
  ));
  card.append(header);
  const details = node("dl");
  [
    ["Revision", identifier(playlist.revision, "revision ID")],
    ["Rotation", String(playlist.rotation_interval)],
    ["Images", String(playlist.asset_count)],
    ["Created", formatTimestamp(playlist.created_at)],
  ].forEach(([label, value]) => {
    const field = node("div");
    field.append(node("dt", label));
    const content = node("dd");
    if (value instanceof Node) content.append(value);
    else content.textContent = value;
    field.append(content);
    details.append(field);
  });
  card.append(details);
  const actions = playlistActionButtons(playlist, canDelete, revisionCount);
  actions.classList.remove("table-actions");
  actions.classList.add("card-actions");
  card.append(actions);
  return card;
}

function renderHealth(health) {
  const panel = document.querySelector("#asset-health");
  panel.replaceChildren();
  if (!health.missing.length) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  panel.append(node("h2", "Missing assets in the active playlist", "error-title"));
  panel.append(node("p", "Devices without cached copies will keep showing their last good playlist."));
  const list = node("ul");
  health.missing.forEach((asset) => {
    const item = node("li");
    item.append(identifier(asset.sha256, "asset SHA-256"), document.createTextNode(` (expected ${asset.expected_size} bytes)`));
    list.append(item);
  });
  panel.append(list);
}

function renderPlaylists(playlists) {
  const activeIDs = new Set(playlists.filter((playlist) => playlist.active).map((playlist) => playlist.playlist_id));
  const revisionCounts = new Map();
  playlists.forEach((playlist) => revisionCounts.set(
    playlist.playlist_id,
    (revisionCounts.get(playlist.playlist_id) ?? 0) + 1,
  ));
  const deleteIDs = new Set();
  const rows = playlists.map((playlist) => {
    const row = node("tr");
    row.append(cell("Playlist", playlist.playlist_id));
    row.append(cell("Revision", identifier(playlist.revision, "revision ID")));
    row.append(cell("Rotation", playlist.rotation_interval));
    row.append(cell("Assets", playlist.asset_count));
    row.append(cell("Created", formatTimestamp(playlist.created_at)));
    row.append(cell("State", statusBadge(playlist.active ? "Active" : "Staged", playlist.active ? "success" : "neutral")));
    const canDelete = !activeIDs.has(playlist.playlist_id) && !deleteIDs.has(playlist.playlist_id);
    if (canDelete) deleteIDs.add(playlist.playlist_id);
    row.append(cell("Actions", playlistActionButtons(
      playlist,
      canDelete,
      playlist.revision_count ?? revisionCounts.get(playlist.playlist_id),
    )));
    return row;
  });
  document.querySelector("#playlists").replaceChildren(table(
    "Playlist revisions",
    ["Playlist", "Revision", "Rotation", "Assets", "Created", "State", "Actions"],
    rows,
    {
      message: "No playlists yet. Add a few PNG images to create your first playlist revision.",
      actionLabel: "Create a playlist",
      href: "#playlist-form",
    },
  ));
  const cards = document.querySelector("#playlists-mobile");
  cards.replaceChildren();
  if (!playlists.length) {
    cards.append(emptyCard("No playlists yet. Add a few PNG images to create your first playlist revision.", "Create a playlist", "#playlist-form"));
    return;
  }
  const cardDeleteIDs = new Set();
  playlists.forEach((playlist) => {
    const canDelete = !activeIDs.has(playlist.playlist_id) && !cardDeleteIDs.has(playlist.playlist_id);
    if (canDelete) cardDeleteIDs.add(playlist.playlist_id);
    cards.append(renderPlaylistCard(
      playlist,
      canDelete,
      playlist.revision_count ?? revisionCounts.get(playlist.playlist_id),
    ));
  });
}

function deviceActionButtons(device) {
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
      showMessage(formatDeviceEnabledMessage(device.device_id, nextEnabled));
      await refresh();
    } catch (error) { showMessage(error.message, true); }
  });

  const rotate = button("Rotate token", "danger");
  rotate.addEventListener("click", async () => {
    let result;
    try {
      const confirmed = await confirmBeforeAction(
        (text) => showConfirmDialog({
          title: "Rotate device token?",
          description: text,
          confirmLabel: "Rotate token",
          destructive: true,
        }),
        `The current token for ${device.device_id} will stop working. Update the device with the new token right away.`,
        async () => {
          result = await api("/admin/api/devices/" + encodeURIComponent(device.device_id) + "/rotate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          });
        },
      );
      if (!confirmed) return;
      displaySecret(`New token for ${device.device_id}`, result.device_token);
      await refresh();
    } catch (error) { showMessage(error.message, true); }
  });
  return [toggle, rotate];
}

function renderDeviceCard(device) {
  const card = node("article", undefined, "data-card");
  const header = node("div", undefined, "data-card__header");
  const title = node("h3");
  title.append(identifier(device.device_id, "device ID"));
  header.append(title, statusBadge(device.enabled ? "Enabled" : "Disabled", device.enabled ? "success" : "neutral"));
  card.append(header);
  const details = node("dl");
  const lastSeen = node("div");
  lastSeen.append(node("dt", "Last check-in"), node("dd", formatTimestamp(device.last_seen_at)));
  details.append(lastSeen);
  card.append(details);
  const actions = node("div", undefined, "card-actions");
  actions.append(...deviceActionButtons(device));
  card.append(actions);
  return card;
}

function renderDevices(devices) {
  const rows = devices.map((device) => {
    const row = node("tr");
    row.append(cell("Device", identifier(device.device_id, "device ID")));
    row.append(cell("Status", statusBadge(device.enabled ? "Enabled" : "Disabled", device.enabled ? "success" : "neutral")));
    row.append(cell("Last check-in", formatTimestamp(device.last_seen_at)));
    const actions = node("div", undefined, "table-actions");
    actions.append(...deviceActionButtons(device));
    row.append(cell("Actions", actions));
    return row;
  });
  document.querySelector("#devices").replaceChildren(table(
    "Enrolled devices",
    ["Device", "Status", "Last check-in", "Actions"],
    rows,
    {
      message: "No devices are enrolled yet. Create an enrollment code to add the first device.",
      actionLabel: "Create enrollment code",
      href: "#enrollment-form",
    },
  ));
  const cards = document.querySelector("#devices-mobile");
  cards.replaceChildren();
  if (!devices.length) cards.append(emptyCard("No devices are enrolled yet. Create an enrollment code to add the first device.", "Create enrollment code", "#enrollment-form"));
  else devices.forEach((device) => cards.append(renderDeviceCard(device)));
}

function renderSubject(subjectType, subjectID) {
  const subjectLabel = String(subjectType ?? "Unknown");
  const displayType = subjectLabel.charAt(0).toUpperCase() + subjectLabel.slice(1);
  const value = node("div", undefined, "subject");
  value.append(node("span", displayType));
  value.append(identifier(subjectID, `${displayType} ID`));
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
    if (/^[A-Za-z0-9._:-]{25,}$/.test(value)) description.append(identifier(value, label));
    else description.textContent = value;
    item.append(node("dt", label), description);
    list.append(item);
  });
  disclosure.append(list);
  return disclosure;
}

function renderAuditCard(event) {
  const card = node("article", undefined, "data-card data-card--activity");
  const header = node("div", undefined, "data-card__header");
  header.append(node("h3", formatAuditEventType(event.event_type)));
  card.append(header);
  const fields = node("dl");
  [
    ["Time", formatTimestamp(event.occurred_at)],
    ["Actor", formatActorLabel(event.actor_id)],
    ["Subject", renderSubject(event.subject_type, event.subject_id)],
  ].forEach(([label, value]) => {
    const field = node("div");
    field.append(node("dt", label));
    const content = node("dd");
    if (value instanceof Node) content.append(value);
    else content.textContent = String(value);
    field.append(content);
    fields.append(field);
  });
  card.append(fields);
  const details = renderAuditDetails(event.metadata);
  if (details.tagName === "DETAILS") {
    details.classList.add("activity-card__details");
    card.append(details);
  }
  return card;
}

function emptyCard(messageTextValue, actionLabel, href) {
  const card = node("div", undefined, "empty-state");
  card.append(node("p", messageTextValue));
  if (actionLabel && href) {
    const action = node("a", actionLabel, "button button--secondary");
    action.href = href;
    card.append(action);
  }
  return card;
}

function renderAudit(events) {
  const rows = events.map((event) => {
    const row = node("tr");
    row.append(cell("Time", formatTimestamp(event.occurred_at)));
    row.append(cell("Actor", formatActorLabel(event.actor_id)));
    row.append(cell("Action", formatAuditEventType(event.event_type)));
    row.append(cell("Subject", renderSubject(event.subject_type, event.subject_id)));
    row.append(cell("Details", renderAuditDetails(event.metadata)));
    return row;
  });
  document.querySelector("#audit").replaceChildren(table(
    "Recent management activity",
    ["Time", "Actor", "Action", "Subject", "Details"],
    rows,
    { message: "No activity yet. Management actions will appear here." },
  ));
  const cards = document.querySelector("#audit-mobile");
  cards.replaceChildren();
  if (!events.length) cards.append(emptyCard("No activity yet. Management actions will appear here."));
  else events.forEach((event) => cards.append(renderAuditCard(event)));
}

async function refresh() {
  const overview = await api("/admin/api/overview");
  latestOverview = overview;
  renderEnvironment(overview.environment);
  renderHealth(overview.asset_health);
  renderPlaylists(overview.playlists);
  renderDevices(overview.devices);
  renderAudit(overview.audit);
  if (!openuiInitialized) {
    renderOpenUIProgram(OPENUI_STARTER_SOURCE, false);
    openuiInitialized = true;
  } else {
    openuiRuntime.refresh();
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

function renderOpenUIView(view) {
  if (!view) return;
  if (view.loading) {
    openuiPreview.setAttribute("aria-busy", "true");
    openuiPreview.replaceChildren(node("p", "Loading fleet summary…", "muted"));
    return;
  }
  openuiPreview.removeAttribute("aria-busy");
  if (view.errors.length) {
    openuiPreview.replaceChildren(node("p", view.errors.map((error) => error.message).join(" "), "error-title"));
    return;
  }
  try {
    openuiPreview.replaceChildren(renderOpenUIElement(view.root));
  } catch (error) {
    openuiPreview.replaceChildren(node("p", error.message, "error-title"));
  }
}

function showOpenUIMessage(text, isError = false) {
  openuiMessage.textContent = text;
  openuiMessage.classList.toggle("error", isError);
}

function renderOpenUIProgram(source, announce = true) {
  try {
    const view = openuiRuntime.renderProgram(source);
    openuiProgram = source;
    renderOpenUIView(view);
    if (announce) showOpenUIMessage("View rendered.");
    return true;
  } catch (error) {
    showOpenUIMessage(error.message, true);
    return false;
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
  return new Promise((resolve) => {
    confirmDialog.addEventListener("close", () => resolve(confirmDialog.returnValue === "confirm"), { once: true });
    confirmDialog.showModal();
  });
}

document.querySelector("#dismiss-message").addEventListener("click", () => { message.hidden = true; });

document.querySelector("#openui-preview-button").addEventListener("click", () => {
  renderOpenUIProgram(openuiSource.value);
});

document.querySelector("#openui-merge-button").addEventListener("click", () => {
  try {
    const merged = openuiRuntime.mergePatch(openuiProgram, openuiSource.value);
    openuiSource.value = merged;
    renderOpenUIProgram(merged, false);
  } catch (error) { showOpenUIMessage(error.message, true); }
});

document.querySelector("#openui-reset-button").addEventListener("click", () => {
  openuiSource.value = OPENUI_STARTER_SOURCE;
  renderOpenUIProgram(OPENUI_STARTER_SOURCE);
});

document.querySelector("#openui-copy-prompt").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(OPENUI_SYSTEM_PROMPT);
    showOpenUIMessage("Prompt copied. Use it with your preferred model, then paste the result above.");
  } catch {
    showOpenUIMessage("Clipboard access failed. Expand the prompt below and copy it manually.", true);
  }
});

let openuiInputTimer;
openuiSource.addEventListener("input", () => {
  clearTimeout(openuiInputTimer);
  openuiInputTimer = setTimeout(() => {
    const status = openuiRuntime.inspectProgram(openuiSource.value);
    if (status.errors.length) {
      showOpenUIMessage(status.errors[0].message, true);
    } else {
      showOpenUIMessage(`${status.statementCount} statement${status.statementCount === 1 ? "" : "s"}${status.incomplete ? " · input is still streaming" : " · ready to preview"}`);
    }
  }, 200);
});

function displaySecret(title, value) {
  document.querySelector("#secret-title").textContent = title;
  document.querySelector("#secret-value").textContent = value;
  document.querySelector("#secret-panel").hidden = false;
  document.querySelector("#secret-panel").scrollIntoView({ behavior: "smooth", block: "center" });
  showMessage(`${title} created. Copy it before leaving this page.`);
}

document.querySelector("#reload").addEventListener("click", async (event) => {
  const refreshButton = event.currentTarget;
  refreshButton.disabled = true;
  try {
    await refresh();
    showMessage("Overview refreshed.");
  } catch (error) { showMessage(error.message, true); }
  finally { refreshButton.disabled = false; }
});

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
  if (!files.length && !assets.length) {
    return showInlineMessage(feedback, "Choose at least one PNG image or keep an existing image.", true);
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
      }),
    });
    showInlineMessage(feedback, `New revision ${compactIdentifier(result.revision)} is ready. Activate it whenever you’re ready.`);
    formElement.reset();
    resetPlaylistEditor();
    await refresh();
  } catch (error) { showInlineMessage(feedback, error.message, true); }
  finally { submitButton.disabled = false; }
});

document.querySelector("#cancel-playlist-edit").addEventListener("click", () => {
  playlistForm().reset();
  resetPlaylistEditor();
  showInlineMessage(document.querySelector("#playlist-feedback"), "Editing cancelled. Your saved revisions are unchanged.");
});

document.querySelector("#enrollment-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const feedback = document.querySelector("#enrollment-feedback");
  const submitButton = formElement.querySelector("button[type=submit]");
  const form = new FormData(formElement);
  submitButton.disabled = true;
  try {
    const result = await api("/admin/api/enrollment-codes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expires_in_minutes: Number(form.get("expires_in_minutes")) }),
    });
    showInlineMessage(feedback, "Enrollment code created. Copy it from the one-time panel below.");
    displaySecret("One-time enrollment code", result.code);
    await refresh();
  } catch (error) { showInlineMessage(feedback, error.message, true); }
  finally { submitButton.disabled = false; }
});

document.querySelector("#copy-secret").addEventListener("click", async () => {
  await copyValue(document.querySelector("#secret-value").textContent, "Value copied. Store it securely on the device.");
});

document.querySelector("#hide-secret").addEventListener("click", () => {
  document.querySelector("#secret-value").textContent = "";
  document.querySelector("#secret-panel").hidden = true;
});

refresh().catch((error) => showMessage(error.message, true));
