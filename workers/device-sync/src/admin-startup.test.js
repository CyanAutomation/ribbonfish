import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

test("management page starts, renders its data, and dismisses errors", async () => {
  const html = await readFile(new URL("../public/admin/index.html", import.meta.url), "utf8");
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("../public/admin/app.js", import.meta.url))],
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
  });
  const dom = new JSDOM(html, { url: "https://example.test/admin/", runScripts: "outside-only" });
  const { window } = dom;
  window.confirm = () => true;
  const navigate = (action) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      window.removeEventListener("hashchange", onHashChange);
      reject(new Error("Navigation did not emit a hashchange event"));
    }, 2000);
    function onHashChange() {
      clearTimeout(timeout);
      resolve();
    }
    window.addEventListener("hashchange", onHashChange, { once: true });
    action();
  });
  const calls = [];
  const requests = [];
  let fail = false;
  const overview = {
    environment: { production: true },
    asset_health: { missing: [] },
    playlists: [], devices: [], audit: [], capture_targets: [{
      capture_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", display_url: "https://status.example/", name: "fbo QA status",
      capture_interval_seconds: 86400, viewport: { width: 1920, height: 1080 }, sha256: "a".repeat(64), size: 4,
      schedule_reviewed: true,
    }, {
      capture_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", display_url: "https://new.example/",
      capture_interval_seconds: 86400, viewport: { width: 1920, height: 1080 }, sha256: "b".repeat(64), size: 4,
      schedule_reviewed: false,
    }],
    active_playlist: null,
  };
  window.fetch = async (path, options = {}) => {
    calls.push(path);
    requests.push({ path, options });
    return {
      ok: !fail,
      json: async () => fail ? { error: "Refresh failed" } :
        path === "/admin/api/capture-sites" ? { schedule_reviewed: false } :
        path === "/admin/api/playlists" ? { revision: "revision-1", capture_count: 2 } :
        path === "/admin/api/overview" ? overview : path === "/admin/api/intervals" ? {
          capture: { default: 86400, options: [
            { value: 900, label: "15 minutes" }, { value: 1800, label: "30 minutes" },
            { value: 3600, label: "1 hour" }, { value: 21600, label: "6 hours" }, { value: 86400, label: "24 hours" },
          ] },
          rotation: { default: "90s", options: [
            { value: "30s", label: "30 seconds" }, { value: "60s", label: "60 seconds" },
            { value: "90s", label: "90 seconds" }, { value: "120s", label: "120 seconds" }, { value: "5m", label: "5 minutes" },
          ] },
        } : [],
    };
  };
  try {
    window.eval(bundle.outputFiles[0].text);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ["/admin/api/overview", "/admin/api/enrollment-requests", "/admin/api/capture-decisions", "/admin/api/intervals"]);
    assert.match(window.document.querySelector("#playlists").textContent, /No playlists yet/);
    assert.match(window.document.querySelector("#devices").textContent, /No devices have been approved/);
    const rotation = window.document.querySelector("[name=rotation_interval]");
    assert.deepEqual([...rotation.options].map((option) => option.value), ["30s", "60s", "90s", "120s", "5m"]);
    assert.equal(rotation.value, "90s");
    assert.ok(window.document.querySelector("#sites-section"));
    assert.equal(window.document.querySelector("#sites-section").hidden, true);
    await navigate(() => window.document.querySelector('a[href="#sites-section"]').click());
    assert.equal(window.document.querySelector("#sites-section").hidden, false);
    assert.equal(window.document.querySelector("#device-section").hidden, true);
    assert.equal(window.document.activeElement.id, "sites-title");
    assert.equal(window.document.querySelector('#module-navigation a[href="#sites-section"]').getAttribute("aria-current"), "page");
    assert.equal(window.document.querySelector("#capture-site-editor").open, false);
    await navigate(() => window.document.querySelector('#module-navigation a[href="#dashboard"]').click());
    assert.equal(window.document.querySelector("#sites-section").hidden, true);
    const analysisLink = window.document.querySelector('#dashboard-tiles a[href="#analysis-section"]');
    const analysisDialog = window.document.querySelector("#analysis-dialog");
    analysisLink.focus();
    await navigate(() => analysisLink.click());
    assert.equal(analysisDialog.open, true);
    assert.equal(window.document.querySelector("#dashboard-tiles").hidden, true);
    assert.equal(window.document.activeElement.id, "close-analysis");
    await navigate(() => analysisDialog.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(analysisDialog.open, false);
    assert.equal(window.document.activeElement, analysisLink);
    assert.match(window.document.querySelector("#capture-target-list").textContent, /https:\/\/status.example\//);
    assert.match(window.document.querySelector("#capture-target-list").textContent, /Schedule review needed/);
    assert.match(window.document.querySelector("#capture-target-list").textContent, /fbo QA status/);
    assert.match(window.document.querySelector("#available-sites").textContent, /fbo QA status/);
    const search = window.document.querySelector("#capture-search");
    search.value = "status.example";
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
    assert.equal(window.document.querySelectorAll("#capture-target-list .capture-target:not([hidden])").length, 1);
    search.value = "";
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
    const nameInput = window.document.querySelector("#capture-target-list input[data-site-name]");
    nameInput.value = "fbo QA status";
    nameInput.parentElement.parentElement.querySelector("button").click();
    await new Promise((resolve) => setImmediate(resolve));
    const nameRequest = requests.find(({ path }) => path.endsWith("/name"));
    assert.equal(JSON.parse(nameRequest.options.body).name, "fbo QA status");

    const scheduleButton = [...window.document.querySelectorAll("#capture-target-list button")]
      .find((button) => button.textContent === "Confirm schedule");
    scheduleButton.click();
    await new Promise((resolve) => setImmediate(resolve));
    const scheduleRequest = requests.find(({ path }) => path === "/admin/api/captures/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    assert.equal(scheduleRequest.options.method, "PATCH");
    assert.equal(JSON.parse(scheduleRequest.options.body).capture_interval_seconds, 86400);
    const siteForm = window.document.querySelector("#capture-site-form");
    siteForm.elements.namedItem("url").value = "https://added.example/";
    siteForm.dispatchEvent(new window.SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setImmediate(resolve));
    const siteRequest = requests.find(({ path }) => path === "/admin/api/capture-sites");
    assert.deepEqual(JSON.parse(siteRequest.options.body), {
      url: "https://added.example/", viewport: { width: 1920, height: 1080 },
    });
    window.document.querySelector('[name="id"]').value = "operations";
    window.document.querySelector("#available-sites input[data-capture-id]").checked = true;
    window.document.querySelector("#playlist-form").dispatchEvent(new window.SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setImmediate(resolve));
    const playlistRequest = requests.find(({ path }) => path === "/admin/api/playlists");
    const playlistBody = JSON.parse(playlistRequest.options.body);
    assert.deepEqual(playlistBody.captures, [{ capture_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }]);

    const siteCard = [...window.document.querySelectorAll("#capture-target-list article")]
      .find((card) => card.querySelector("h3")?.textContent === "fbo QA status");
    const removeSiteButton = [...siteCard.querySelectorAll("button")]
      .find((button) => button.textContent === "Remove capture site");
    assert.equal(removeSiteButton.closest("details").open, false);
    assert.ok(removeSiteButton);
    removeSiteButton.click();
    await new Promise((resolve) => setImmediate(resolve));
    const removeSiteRequest = requests.find(({ path }) => path === "/admin/api/captures/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    assert.equal(removeSiteRequest.options.method, "DELETE");

    overview.devices = [{ device_id: "pi-office", enabled: true, auth_type: "key", health: { status: "healthy" } }];
    window.document.querySelector("#reload").click();
    await new Promise((resolve) => setImmediate(resolve));
    const removeDeviceButton = [...window.document.querySelectorAll("#devices button")]
      .find((button) => button.textContent === "Delete device");
    assert.ok(removeDeviceButton);
    assert.equal(removeDeviceButton.closest("details").open, false);
    removeDeviceButton.click();
    await new Promise((resolve) => setImmediate(resolve));
    const removeDeviceRequest = requests.find(({ path }) => path === "/admin/api/devices/pi-office");
    assert.equal(removeDeviceRequest.options.method, "DELETE");

    overview.playlists = [
      { playlist_id: "operations", revision: "rev-one", active: true, rotation_interval: "90s", asset_count: 1, created_at: 1 },
      { playlist_id: "operations", revision: "rev-two", active: false, rotation_interval: "90s", asset_count: 2, created_at: 2 },
      { playlist_id: "status", revision: "rev-three", active: false, rotation_interval: "90s", asset_count: 1, created_at: 3 },
    ];
    window.document.querySelector("#reload").click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(window.document.querySelectorAll("#playlists .playlist-group").length, 2);
    assert.equal(window.document.querySelectorAll("#playlists-mobile .playlist-group").length, 2);
    assert.equal(window.document.querySelector("#playlists .playlist-group tbody").rows.length, 2);

    fail = true;
    window.document.querySelector("#reload").click();
    await new Promise((resolve) => setImmediate(resolve));
    const notice = window.document.querySelector('[data-feedback-slot="global"]');
    assert.equal(notice.hidden, false);
    assert.match(notice.textContent, /Refresh failed/);
    notice.querySelector("[data-dismiss-feedback]").click();
    assert.equal(notice.hidden, true);
  } finally {
    window.close();
  }
});
