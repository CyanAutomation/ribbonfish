const message = document.querySelector("#message");

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

function timestamp(value) {
  return value ? new Date(value).toLocaleString() : "Never seen";
}

function table(headers, rows) {
  const element = node("table");
  const head = node("thead");
  const headerRow = node("tr");
  headers.forEach((label) => headerRow.append(node("th", label)));
  head.append(headerRow);
  element.append(head);
  const body = node("tbody");
  rows.forEach((row) => body.append(row));
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
    row.append(node("td", timestamp(playlist.created_at)));
    const state = node("td");
    state.append(node("span", playlist.active ? "Active" : "Staged", playlist.active ? "badge" : "badge inactive"));
    row.append(state);
    const action = node("td");
    const button = node("button", "Activate");
    button.type = "button";
    button.disabled = Boolean(playlist.active);
    button.addEventListener("click", async () => {
      try {
        await api("/admin/api/active-playlist", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ playlist_id: playlist.playlist_id, revision: playlist.revision }),
        });
        showMessage("Activated " + playlist.playlist_id + " / " + playlist.revision);
        await refresh();
      } catch (error) { showMessage(error.message, true); }
    });
    action.append(button);
    row.append(action);
    return row;
  });
  document.querySelector("#playlists").replaceChildren(table(
    ["Playlist", "Revision", "Rotation", "Assets", "Created", "State", ""], rows,
  ));
}

function renderDevices(devices) {
  const rows = devices.map((device) => {
    const row = node("tr");
    row.append(node("td", device.device_id));
    row.append(node("td", device.enabled ? "Enabled" : "Disabled"));
    row.append(node("td", timestamp(device.last_seen_at)));
    const actions = node("td");
    const toggle = node("button", device.enabled ? "Disable" : "Enable", "secondary");
    toggle.type = "button";
    toggle.addEventListener("click", async () => {
      try {
        await api("/admin/api/devices/" + encodeURIComponent(device.device_id), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: !device.enabled }),
        });
        showMessage(device.device_id + (device.enabled ? " disabled" : " enabled"));
        await refresh();
      } catch (error) { showMessage(error.message, true); }
    });
    const rotate = node("button", "Rotate token");
    rotate.type = "button";
    rotate.addEventListener("click", async () => {
      try {
        const result = await api("/admin/api/devices/" + encodeURIComponent(device.device_id) + "/rotate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        displaySecret("New token for " + device.device_id, result.device_token);
      } catch (error) { showMessage(error.message, true); }
    });
    actions.append(toggle, document.createTextNode(" "), rotate);
    row.append(actions);
    return row;
  });
  document.querySelector("#devices").replaceChildren(table(["Device", "Status", "Last poll", "Actions"], rows));
}

function renderAudit(events) {
  const rows = events.map((event) => {
    const row = node("tr");
    row.append(node("td", timestamp(event.occurred_at)));
    row.append(node("td", event.actor_id));
    row.append(node("td", event.event_type));
    row.append(node("td", event.subject_type + " · " + event.subject_id));
    row.append(node("td", JSON.stringify(event.metadata)));
    return row;
  });
  document.querySelector("#audit").replaceChildren(table(["Time", "Actor", "Action", "Subject", "Details"], rows));
}

async function refresh() {
  const overview = await api("/admin/api/overview");
  renderHealth(overview.asset_health);
  renderPlaylists(overview.playlists);
  renderDevices(overview.devices);
  renderAudit(overview.audit);
}

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
