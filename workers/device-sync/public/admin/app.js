import {
  createFleetOpenUI,
  OPENUI_STARTER_SOURCE,
  OPENUI_SYSTEM_PROMPT,
  renderOpenUIElement,
} from "./openui-core.js";
import {
  confirmBeforeAction,
  formatAuditDetails,
  formatAuditEventType,
  formatDeviceEnabledMessage,
  formatTimestamp,
} from "./ui-utils.js";

const message = document.querySelector("#message");
const openuiPreview = document.querySelector("#openui-preview");
const openuiSource = document.querySelector("#openui-source");
const openuiMessage = document.querySelector("#openui-message");
const openuiPrompt = document.querySelector("#openui-prompt-text");
let latestOverview = null;
let openuiProgram = OPENUI_STARTER_SOURCE;
let openuiInitialized = false;
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

async function api(path, options = {}) {
  const response = await fetch(path, { cache: "no-store", ...options });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Request failed with status " + response.status);
  return result;
}

function showMessage(text, isError = false) {
  message.textContent = text;
  message.classList.toggle("error", isError);
}

function table(caption, headers, rows, emptyMessage) {
  const element = node("table");
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
  if (!rows.length && emptyMessage) {
    const row = node("tr", undefined, "empty-row");
    const cell = node("td", emptyMessage, "empty-state");
    cell.colSpan = headers.length;
    row.append(cell);
    body.append(row);
  }
  element.append(body);
  return element;
}

function renderHealth(health) {
  const panel = document.querySelector("#asset-health");
  panel.replaceChildren();
  if (!health.missing.length) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  panel.append(node("h2", "Active playlist has missing R2 assets", "error-title"));
  panel.append(node("p", "Devices without cached copies of these images will keep their last good playlist."));
  const list = node("ul");
  health.missing.forEach((asset) => list.append(node("li", asset.sha256 + " (expected " + asset.expected_size + " bytes)")));
  panel.append(list);
}

function renderPlaylists(playlists) {
  const rows = playlists.map((playlist) => {
    const row = node("tr");
    row.append(node("td", playlist.playlist_id));
    row.append(node("td", playlist.revision));
    row.append(node("td", playlist.rotation_interval));
    row.append(node("td", playlist.asset_count));
    row.append(node("td", formatTimestamp(playlist.created_at)));
    const state = node("td");
    state.append(node("span", playlist.active ? "Active" : "Staged", playlist.active ? "badge" : "badge inactive"));
    row.append(state);
    const action = node("td");
    const button = node("button", "Activate");
    button.type = "button";
    button.disabled = Boolean(playlist.active);
    button.addEventListener("click", async () => {
      try {
        const confirmed = await confirmBeforeAction(
          (prompt) => window.confirm(prompt),
          `Activate ${playlist.playlist_id} / ${playlist.revision}? This will replace the playlist sent to devices.`,
          () => api("/admin/api/active-playlist", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ playlist_id: playlist.playlist_id, revision: playlist.revision }),
          }),
        );
        if (!confirmed) return;
        showMessage("Activated " + playlist.playlist_id + " / " + playlist.revision);
        await refresh();
      } catch (error) { showMessage(error.message, true); }
    });
    action.append(button);
    row.append(action);
    return row;
  });
  document.querySelector("#playlists").replaceChildren(table(
    "Playlist revisions",
    ["Playlist", "Revision", "Rotation", "Assets", "Created (UTC)", "State", ""], rows,
    "No playlist revisions yet. Upload PNG images below to stage the first revision.",
  ));
}

function renderDevices(devices) {
  const rows = devices.map((device) => {
    const row = node("tr");
    row.append(node("td", device.device_id));
    row.append(node("td", device.enabled ? "Enabled" : "Disabled"));
    row.append(node("td", formatTimestamp(device.last_seen_at)));
    const actions = node("td");
    const toggle = node("button", device.enabled ? "Disable" : "Enable", "secondary");
    toggle.type = "button";
    toggle.addEventListener("click", async () => {
      try {
        const nextEnabled = !device.enabled;
        const confirmed = await confirmBeforeAction(
          (prompt) => window.confirm(prompt),
          `${nextEnabled ? "Enable" : "Disable"} device ${device.device_id}?${nextEnabled ? "" : " It will stop syncing until enabled again."}`,
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
    const rotate = node("button", "Rotate token");
    rotate.type = "button";
    rotate.addEventListener("click", async () => {
      try {
        let result;
        const confirmed = await confirmBeforeAction(
          (prompt) => window.confirm(prompt),
          `Rotate the token for ${device.device_id}? The existing token will stop working. Store the new token on the device immediately.`,
          async () => {
            result = await api("/admin/api/devices/" + encodeURIComponent(device.device_id) + "/rotate", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: "{}",
            });
          },
        );
        if (!confirmed) return;
        displaySecret("New token for " + device.device_id, result.device_token);
      } catch (error) { showMessage(error.message, true); }
    });
    actions.append(toggle, document.createTextNode(" "), rotate);
    row.append(actions);
    return row;
  });
  document.querySelector("#devices").replaceChildren(table(
    "Enrolled devices",
    ["Device", "Status", "Last poll (UTC)", "Actions"],
    rows,
    "No devices enrolled yet. Create an enrollment code below to add the first device.",
  ));
}

function renderAudit(events) {
  const rows = events.map((event) => {
    const row = node("tr");
    row.append(node("td", formatTimestamp(event.occurred_at)));
    row.append(node("td", event.actor_id || "Unknown"));
    row.append(node("td", formatAuditEventType(event.event_type)));
    row.append(node("td", event.subject_type + " · " + event.subject_id));
    const details = node("td");
    details.append(renderAuditDetails(event.metadata));
    row.append(details);
    return row;
  });
  document.querySelector("#audit").replaceChildren(table(
    "Recent management activity",
    ["Time (UTC)", "Actor", "Action", "Subject", "Details"],
    rows,
    "No management activity yet.",
  ));
}

async function refresh() {
  const overview = await api("/admin/api/overview");
  latestOverview = overview;
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

function renderAuditDetails(metadata) {
  const details = formatAuditDetails(metadata);
  if (!details.length) return node("span", "—", "muted");
  const list = node("ul", undefined, "audit-details");
  details.forEach(({ label, value }) => {
    const item = node("li");
    item.append(node("span", label + ": ", "audit-detail-label"), node("span", value));
    list.append(item);
  });
  return list;
}

function renderOpenUIView(view) {
  if (!view) return;
  if (view.loading) {
    openuiPreview.setAttribute("aria-busy", "true");
    openuiPreview.replaceChildren(node("p", "Loading read-only fleet view…", "muted"));
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
    if (announce) showOpenUIMessage("OpenUI view rendered.");
    return true;
  } catch (error) {
    showOpenUIMessage(error.message, true);
    return false;
  }
}

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
    showOpenUIMessage("OpenUI prompt copied. Use it with your preferred model, then paste the result above.");
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
      showOpenUIMessage(`${status.statementCount} OpenUI statement${status.statementCount === 1 ? "" : "s"}${status.incomplete ? " · input is still streaming" : " · ready to preview"}`);
    }
  }, 200);
});

function displaySecret(title, value) {
  document.querySelector("#secret-title").textContent = title;
  document.querySelector("#secret-value").textContent = value;
  document.querySelector("#secret-panel").hidden = false;
  document.querySelector("#secret-panel").scrollIntoView({ behavior: "smooth", block: "center" });
}

document.querySelector("#reload").addEventListener("click", () => {
  refresh().then(() => showMessage("Updated")).catch((error) => showMessage(error.message, true));
});

document.querySelector("#playlist-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const files = [...form.getAll("assets")].filter((value) => value instanceof File && value.size > 0);
  if (!files.length) return showMessage("Choose at least one PNG image.", true);
  try {
    showMessage("Uploading images…");
    const assets = [];
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
    showMessage("Staged revision " + result.revision + ". Activate it from the playlist list when ready.");
    event.currentTarget.reset();
    await refresh();
  } catch (error) { showMessage(error.message, true); }
});

document.querySelector("#enrollment-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    const result = await api("/admin/api/enrollment-codes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expires_in_minutes: Number(form.get("expires_in_minutes")) }),
    });
    displaySecret("One-time enrollment code", result.code);
    await refresh();
  } catch (error) { showMessage(error.message, true); }
});

document.querySelector("#copy-secret").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(document.querySelector("#secret-value").textContent);
    showMessage("Copied. Store this value securely on the device.");
  } catch { showMessage("Clipboard access failed; select and copy the value manually.", true); }
});

document.querySelector("#hide-secret").addEventListener("click", () => {
  document.querySelector("#secret-value").textContent = "";
  document.querySelector("#secret-panel").hidden = true;
});

refresh().catch((error) => showMessage(error.message, true));
