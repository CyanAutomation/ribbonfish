import {
  createFleetOpenUI,
  OPENUI_STARTER_SOURCE,
  renderOpenUIElement,
} from "./openui-core.js";
import {
  compactIdentifier,
  confirmAction,
  confirmBeforeAction,
  formatActorLabel,
  formatCaptureInterval,
  formatAuditDetails,
  formatAuditEventType,
  formatDeviceEnabledMessage,
  formatEnvironmentNotice,
  formatPlaylistState,
  playlistDeleteActionStates,
  formatScreenshotStatus,
  formatTimestamp,
  hasPageURLs,
  parsePageURLs,
} from "./ui-utils.js";

const message = document.querySelector("#message");
const messageText = document.querySelector("#message-text");
const fleetSummary = document.querySelector("#fleet-summary");
const confirmDialog = document.querySelector("#confirm-dialog");
const confirmTitle = document.querySelector("#confirm-title");
const confirmDescription = document.querySelector("#confirm-description");
const confirmButton = document.querySelector("#confirm-submit");
const confirmCancel = document.querySelector("#confirm-cancel");
const environmentTag = document.querySelector("#environment-tag");
const environmentNotice = document.querySelector("#environment-notice");
let latestOverview = null;
let fleetSummaryInitialized = false;
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

function fingerprintDisplay(value) {
  const wrapper = node("span", undefined, "fingerprint-display");
  const code = node("code", String(value).toUpperCase(), "fingerprint-display__value");
  wrapper.append(code);
  const copy = button("Copy", "quiet");
  copy.classList.add("button--small");
  copy.setAttribute("aria-label", "Copy full device fingerprint");
  copy.addEventListener("click", () => copyValue(value, "Device fingerprint copied."));
  wrapper.append(copy);
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
  playlistEditSource = null;
  form.querySelector("h3").textContent = "Create a playlist version";
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
    form.elements.namedItem("id").value = detail.playlist_id;
    form.elements.namedItem("rotation_interval").value = detail.rotation_interval;
    form.querySelector("h3").textContent = "Edit playlist as a new version";
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
    showMessage(error.message, true);
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
        showMessage(`Playlist ${playlist.playlist_id} is active. Devices will receive it on their next sync.`);
        await refresh();
      } catch (error) { showMessage(error.message, true); }
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
          showMessage(`Playlist ${playlist.playlist_id} was deleted. Uploaded images remain available for reuse.`);
          await refresh();
        } catch (error) { showMessage(error.message, true); }
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
      item.append(identifier(asset.sha256, "image SHA-256"), document.createTextNode(` (expected ${asset.expected_size} bytes)`));
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
      item.append(document.createTextNode(`${label}: `), identifier(issue.sha256, "image SHA-256"));
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
    { label: "Version", render: (playlist) => identifier(playlist.revision, "version ID") },
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
      href: "#playlist-form",
    },
    cardTitleField: "Playlist",
    cardStatusField: "Status",
  });
}

function renderCaptureTargets(targets) {
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
    content.append(node("p", `${formatCaptureInterval(target.capture_interval_seconds)} · ${target.viewport.width} × ${target.viewport.height} px`, "muted"));
    content.append(node("p", target.last_success_at ? `Last screenshot ${formatTimestamp(target.last_success_at)}` : "No screenshot is ready yet.", "muted"));
    if (target.last_error) content.append(node("p", target.last_error, "error-title"));

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
        showMessage(`Screenshot job ${compactIdentifier(result.job_id)} ${status}.`);
        await refresh();
      } catch (error) { showMessage(error.message, true); }
      finally { capture.disabled = false; }
    });
    actions.append(capture);
    content.append(actions);
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
      showMessage(formatDeviceEnabledMessage(device.device_id, nextEnabled));
      await refresh();
    } catch (error) { showMessage(error.message, true); }
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
      } catch (error) { showMessage(error.message, true); }
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
  let loaded = false;
  details.addEventListener("toggle", async () => {
    if (!details.open || loaded) return;
    loaded = true;
    content.replaceChildren(node("p", "Loading health details…", "muted"));
    try {
      const devicePath = `/admin/api/devices/${encodeURIComponent(device.device_id)}`;
      const [result, history] = await Promise.all([
        api(`${devicePath}/health`),
        api(`${devicePath}/health-history?limit=10`),
      ]);
      const report = result.latest;
      content.replaceChildren();
      if (!report) {
        content.append(node("p", "This device has not reported health yet.", "muted"));
        return;
      }
      content.append(node("p", `Fleet health ${result.health_status}.`));
      content.append(node("p", `Last report ${formatTimestamp(result.received_at)} · Agent ${report.agent_version} · Uptime ${formatAge(report.agent_uptime_seconds)}`));
      const lastSync = report.sync.last_success_age_seconds === null ? "never" : `${formatAge(report.sync.last_success_age_seconds)} ago`;
      content.append(node("p", `Sync ${report.sync.status} · last success ${lastSync}${report.sync.applied_playlist_id ? ` · ${report.sync.applied_playlist_id} / ${report.sync.applied_revision ?? "revision unknown"}` : ""}`));
      if (report.startup_error_code) content.append(node("p", `Startup issue: ${report.startup_error_code}`, "health-error"));
      if (report.outputs.length) {
        const outputList = node("ul");
        for (const output of report.outputs) {
          const connector = output.connector ? ` (${output.connector})` : "";
          const issue = output.error_code ? ` · ${output.error_code}` : "";
          const lastFrame = output.last_frame_age_seconds === null ? "no successful frame yet" : `last frame ${formatAge(output.last_frame_age_seconds)} ago`;
          outputList.append(node("li", `${output.display_id}${connector}: ${output.status} · ${lastFrame}${issue}`));
        }
        content.append(outputList);
      }
      if (report.host) {
        const readings = [];
        if (Number.isFinite(report.host.uptime_seconds)) readings.push(`Host uptime ${formatAge(report.host.uptime_seconds)}`);
        if (Number.isFinite(report.host.temperature_millicelsius)) readings.push(`Temperature ${(report.host.temperature_millicelsius / 1000).toFixed(1)}°C`);
        if (Number.isFinite(report.host.memory_available_bytes)) readings.push(`Memory ${formatBytes(report.host.memory_available_bytes)} available`);
        if (Number.isFinite(report.host.state_disk_free_bytes)) readings.push(`State disk ${formatBytes(report.host.state_disk_free_bytes)} free`);
        if (Number.isFinite(report.host.load_1m)) readings.push(`1m load ${report.host.load_1m.toFixed(2)}`);
        if (readings.length) content.append(node("p", readings.join(" · ")));
      }
      const events = history.events ?? [];
      content.append(node("h4", "Recent health changes"));
      if (!events.length) content.append(node("p", "No health changes recorded.", "muted"));
      else {
        const eventList = node("ul");
        events.forEach((event) => {
          const healthState = event.metadata?.health_status ? ` · ${event.metadata.health_status}` : "";
          const transition = event.metadata?.previous_health_status
            ? ` (${event.metadata.previous_health_status} → ${event.metadata.health_status})` : "";
          eventList.append(node("li", `${formatTimestamp(event.received_at)} · ${event.event_type}${healthState}${transition}${event.error_code ? ` · ${event.error_code}` : ""}`));
        });
        content.append(eventList);
      }
      content.append(node("p", `${history.samples?.length ?? 0} health samples in the last 30 days.`, "muted"));
    } catch (error) {
      content.replaceChildren(node("p", error.message, "health-error"));
    }
  });
  return details;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = bytes;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${amount.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatAge(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "unknown";
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function renderDevices(devices) {
  renderResponsiveRecords({
    tableSelector: "#devices",
    cardsSelector: "#devices-mobile",
    caption: "Enrolled devices",
    records: devices,
    fields: [
      { label: "Device", render: (device) => identifier(device.device_id, "device ID") },
      {
        label: "Status",
        render: (device) => statusBadge(device.enabled ? "Enabled" : "Disabled", device.enabled ? "success" : "neutral"),
      },
      { label: "Health", render: (device) => healthBadge(device.health) },
      { label: "Authentication", render: (device) => device.auth_type === "key" ? "Key-based" : "Legacy token" },
      { label: "Last report", render: (device) => formatTimestamp(device.health?.received_at) },
      { label: "Playback", render: (device) => {
        if (device.health?.last_error_code) return `Issue: ${device.health.last_error_code}`;
        const output = device.health?.outputs?.[0];
        if (!output) return "—";
        return output.error_code ? `${output.display_id}: ${output.error_code}` : `${output.display_id}: ${output.status}`;
      } },
      { label: "Playlist", render: (device) => device.health?.applied_playlist_id
        ? `${device.health.applied_playlist_id} / ${compactIdentifier(device.health.applied_revision)}` : "—" },
      { label: "Details", render: (device) => healthDetails(device) },
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
    const replacement = request.replaces_existing
      ? ` This will replace the existing credentials for ${request.device_id}.`
      : "";
    try {
      const confirmed = await confirmBeforeAction(
        (text) => showConfirmDialog({
          title: "Approve device?",
          description: text,
          confirmLabel: "Approve device",
        }),
        `Only approve ${request.device_id} if its physical display shows the full fingerprint ${request.fingerprint}.${replacement}`,
        () => api(`/admin/api/enrollment-requests/${request.request_id}/approve`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
      );
      if (!confirmed) return;
      showMessage(`Device ${request.device_id} was approved.`);
      await refresh();
    } catch (error) { showMessage(error.message, true); }
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
      showMessage(`Device request for ${request.device_id} was rejected.`);
      await refresh();
    } catch (error) { showMessage(error.message, true); }
  });
  actions.append(approve, reject);
  return actions;
}

function renderPendingEnrollments(requests) {
  renderResponsiveRecords({
    tableSelector: "#pending-enrollments",
    cardsSelector: "#pending-enrollments-mobile",
    caption: "Devices awaiting approval",
    records: requests,
    fields: [
      { label: "Device", render: (request) => identifier(request.device_id, "device ID") },
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
  const [overview, enrollmentRequests] = await Promise.all([
    api("/admin/api/overview"),
    api("/admin/api/enrollment-requests"),
  ]);
  latestOverview = overview;
  renderEnvironment(overview.environment);
  renderHealth(overview.asset_health);
  renderPlaylists(overview.playlists);
  renderCaptureTargets(overview.capture_targets ?? []);
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

const sectionLinks = [...document.querySelectorAll(".section-nav a")];
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
  showMessage(`${title} created. Copy it before leaving this page.`);
}

document.querySelector("#reload").addEventListener("click", async (event) => {
  const refreshButton = event.currentTarget;
  refreshButton.disabled = true;
  try {
    await refresh();
    showMessage("Management data refreshed.");
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
    showInlineMessage(feedback, `New version ${compactIdentifier(result.revision)} is ready to activate.${captureNote}`);
    formElement.reset();
    resetPlaylistEditor();
    await refresh();
  } catch (error) { showInlineMessage(feedback, error.message, true); }
  finally { submitButton.disabled = false; }
});

document.querySelector("#cancel-playlist-edit").addEventListener("click", () => {
  playlistForm().reset();
  resetPlaylistEditor();
  showInlineMessage(document.querySelector("#playlist-feedback"), "Editing cancelled. Your saved versions are unchanged.");
});

document.querySelector("#copy-secret").addEventListener("click", async () => {
  await copyValue(document.querySelector("#secret-value").textContent, "Value copied. Store it securely on the device.");
});

document.querySelector("#hide-secret").addEventListener("click", () => {
  document.querySelector("#secret-value").textContent = "";
  document.querySelector("#secret-panel").hidden = true;
});

refresh().catch((error) => showMessage(error.message, true));
