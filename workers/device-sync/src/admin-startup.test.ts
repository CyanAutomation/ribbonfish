import test, { before } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

// Console workflows: ../README.md#management-api and ../../../README.md#core-workflows.
const html = await readFile(new URL("../public/admin/index.html", import.meta.url), "utf8");
let appBundle;

before(async () => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("../public/admin/app.ts", import.meta.url))],
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
  });
  appBundle = bundle.outputFiles[0].text;
});

const overviewFixture = () => ({
  generated_at: 1_700_000_000_000,
  environment: { production: true },
  asset_health: { missing: [] },
  playlists: [],
  devices: [],
  audit: [],
  capture_targets: [{
    capture_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", display_url: "https://status.example/", name: "fbo QA status",
    capture_interval_seconds: 86400, viewport: { width: 1920, height: 1080 }, sha256: "a".repeat(64), size: 4,
    schedule_reviewed: true, active_in_playlist: true, average_browser_ms: 50_000, browser_ms_samples: 10,
  }, {
    capture_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", display_url: "https://new.example/",
    capture_interval_seconds: 86400, viewport: { width: 1920, height: 1080 }, sha256: "b".repeat(64), size: 4,
    schedule_reviewed: false,
  }],
  active_playlist: null,
  capture_efficiency: {
    daily_usage: { accounted_ms: 600_000, budget_ms: 600_000, free_plan_limit_ms: 600_000 },
    last_30_days: {
      successful_screenshots: 8,
      validator_unchanged: 2,
      successful_unclassified: 1,
      browser_run_ms: { response_header: 480_000, reserve: 120_000, unclassified_jobs: 0 },
    },
  },
});

function openConsole(initialDashboards = []) {
  const dom = new JSDOM(html, { url: "https://example.test/admin/", runScripts: "outside-only" });
  const { window } = dom;
  const calls = [];
  const requests = [];
  const overview = overviewFixture();
  let apiDashboards = initialDashboards;
  let fail = false;
  window.confirm = () => true;
  window.fetch = async (path, options = {}) => {
    calls.push(path);
    requests.push({ path, options });
    const body = fail ? { error: "Refresh failed" } :
      path === "/admin/api/capture-sites" ? { schedule_reviewed: false } :
      path === "/admin/api/playlists" ? { revision: "revision-1", capture_count: 2 } :
      path === "/admin/api/overview" ? overview : path === "/admin/api/api-dashboards" ? apiDashboards : path === "/admin/api/intervals" ? {
        capture: { default: 86400, options: [
          { value: 900, label: "15 minutes" }, { value: 1800, label: "30 minutes" },
          { value: 3600, label: "1 hour" }, { value: 10800, label: "3 hours" },
          { value: 21600, label: "6 hours" }, { value: 43200, label: "12 hours" }, { value: 86400, label: "24 hours" },
        ] },
        rotation: { default: "90s", options: [
          { value: "30s", label: "30 seconds" }, { value: "60s", label: "60 seconds" },
          { value: "90s", label: "90 seconds" }, { value: "120s", label: "120 seconds" }, { value: "5m", label: "5 minutes" },
        ] },
      } : [];
    return { ok: !fail, json: async () => body };
  };
  window.eval(appBundle);
  return {
    dom,
    window,
    calls,
    requests,
    overview,
    setFailure(value) { fail = value; },
    setDashboards(value) { apiDashboards = value; },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function navigate(window, action) {
  return new Promise((resolve, reject) => {
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
}

test("management console renders empty states and the supported rotation default", async () => {
  const { dom, window, calls } = openConsole();
  try {
    await settle();
    assert.deepEqual(calls, ["/admin/api/overview", "/admin/api/enrollment-requests", "/admin/api/capture-decisions", "/admin/api/intervals", "/admin/api/api-dashboards"]);
    assert.match(window.document.querySelector("#playlists").textContent, /No playlists yet/);
    assert.match(window.document.querySelector("#devices").textContent, /No devices have been approved/);
    const rotation = window.document.querySelector("[name=rotation_interval]");
    assert.deepEqual([...rotation.options].map((option) => option.value), ["30s", "60s", "90s", "120s", "5m"]);
    assert.equal(rotation.value, "90s");
    assert.equal(window.document.querySelector("#sites-section").hidden, true);
  } finally {
    dom.window.close();
  }
});

test("management navigation shows the selected section and moves focus", { timeout: 5000 }, async () => {
  const { dom, window } = openConsole();
  try {
    await settle();
    await navigate(window, () => window.document.querySelector('#module-navigation a[href="#sites-section"]').click());
    assert.equal(window.document.querySelector("#sites-section").hidden, false);
    assert.equal(window.document.querySelector("#device-section").hidden, true);
    assert.equal(window.document.activeElement.id, "sites-title");
    assert.equal(window.document.querySelector('#module-navigation a[href="#sites-section"]').getAttribute("aria-current"), "page");
    assert.equal(window.document.querySelector("#capture-site-editor").open, false);

    const navigation = window.document.querySelector("#module-navigation");
    const toggle = window.document.querySelector("#module-navigation-toggle");
    const activeLink = window.document.querySelector('#module-navigation a[href="#sites-section"]');
    activeLink.focus();
    toggle.click();
    assert.equal(navigation.hidden, true, "the navigation can be collapsed");
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(window.document.activeElement, toggle, "focus returns to the visible toggle before hiding the sidebar");
    assert.equal(window.document.querySelector("#management-shell").classList.contains("management-shell--nav-collapsed"), true);
    toggle.click();
    assert.equal(navigation.hidden, false, "the navigation can be revealed again");
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
  } finally {
    dom.window.close();
  }
});

test("management modules share page headers and labeled control toolbars", { timeout: 5000 }, async () => {
  const { dom, window } = openConsole();
  try {
    await settle();
    for (const [sectionID, titleID, title] of [
      ["overview-section", "overview-title", "Fleet snapshot"],
      ["sites-section", "sites-title", "Capture sites"],
      ["dashboards-section", "dashboards-title", "Capture dashboards"],
      ["capture-efficiency-section", "capture-efficiency-title", "Capture efficiency and Browser Run usage"],
      ["playlist-section", "playlist-title", "Playlist versions"],
      ["device-section", "device-title", "Device fleet"],
      ["activity-section", "activity-title", "Recent activity"],
    ]) {
      const section = window.document.getElementById(sectionID);
      const header = section.querySelector(":scope > .page-header");
      assert.ok(header, `${sectionID} has a shared page header`);
      assert.equal(header.tagName, "HEADER");
      assert.equal(header.querySelector("h2")?.id, titleID);
      assert.equal(header.querySelector("h2")?.textContent, title);
      assert.equal(section.querySelector(":scope > .section-heading"), null);
    }

    const sitesHeader = window.document.querySelector("#sites-section > .page-header");
    const sitesDescription = sitesHeader.querySelector(".page-header__description");
    assert.match(sitesDescription.textContent, /review their screenshot schedules/);
    assert.equal(sitesHeader.querySelector("h2").getAttribute("aria-describedby"), sitesDescription.id);
    assert.deepEqual([...sitesHeader.querySelectorAll(".page-header__meta span")].map((item) => item.textContent), [
      "2 screenshot sites", "2 need attention",
    ]);
    const deviceHeader = window.document.querySelector("#device-section > .page-header");
    assert.deepEqual([...deviceHeader.querySelectorAll(".page-header__meta span")].map((item) => item.textContent), [
      "0 devices", "0 awaiting approval",
    ]);

    const playlistAction = window.document.querySelector('#playlist-section .page-header__actions a[href="#playlist-editor"]');
    assert.equal(playlistAction.textContent, "Create playlist version");
    const siteAction = window.document.querySelector('#sites-section .page-header__actions a[href="#capture-site-editor"]');
    assert.equal(siteAction.textContent, "Add site");
    const dashboardAction = window.document.querySelector('#dashboards-section .page-header__actions a[href="#api-dashboard-editor"]');
    assert.equal(dashboardAction.textContent, "Add API dashboard");

    const filters = window.document.querySelector(".capture-filters");
    assert.equal(filters.getAttribute("role"), "group");
    assert.equal(filters.getAttribute("aria-label"), "Capture site filters");
    assert.deepEqual([...filters.querySelectorAll(".toolbar__group")].map((group) => group.getAttribute("aria-label")), ["Site search", "Site status"]);
    assert.equal(filters.querySelector("input[type=search]"), window.document.getElementById("capture-search"));
    assert.equal(filters.querySelector("select"), window.document.getElementById("capture-filter"));

    const sourceToolbar = window.document.querySelector("#api-dashboard-source-list > .source-editor-toolbar");
    assert.equal(sourceToolbar.getAttribute("role"), "group");
    assert.equal(sourceToolbar.getAttribute("aria-label"), "Dashboard source controls");
    assert.equal(sourceToolbar.querySelector("[data-add-dashboard-source]").textContent, "Add source");

    await navigate(window, () => siteAction.click());
    const siteEditor = window.document.getElementById("capture-site-editor");
    assert.equal(siteEditor.open, true, "the page action opens its existing native editor disclosure");
    assert.equal(window.document.activeElement, siteEditor.querySelector("summary"), "focus moves to the editor disclosure trigger");
    await navigate(window, () => dashboardAction.click());
    const dashboardEditor = window.document.getElementById("api-dashboard-editor");
    assert.equal(dashboardEditor.open, true, "the dashboard page action opens its native editor disclosure");
    assert.equal(window.document.activeElement, dashboardEditor.querySelector("summary"));
  } finally {
    dom.window.close();
  }
});

test("dashboard navigation renders capture efficiency and fleet findings", { timeout: 5000 }, async () => {
  const { dom, window } = openConsole();
  try {
    await settle();
    const efficiencyTile = window.document.querySelector('#dashboard-tiles a[href="#capture-efficiency-section"]');
    assert.ok(efficiencyTile);
    await navigate(window, () => efficiencyTile.click());
    assert.equal(window.document.querySelector("#capture-efficiency-section").hidden, false);
    assert.equal(window.document.querySelector("#dashboard-tiles").hidden, true);
    assert.equal(window.document.activeElement.id, "capture-efficiency-title");
    assert.equal(window.document.querySelector('#module-navigation a[href="#capture-efficiency-section"]').getAttribute("aria-current"), "page");
    assert.equal(window.document.querySelectorAll("#capture-efficiency-section .metric-card").length, 2);
    assert.equal(window.document.querySelectorAll("#capture-efficiency-section .scale-meter").length, 2);
    assert.match(window.document.querySelector("#capture-efficiency-section").textContent, /Forecast at current schedules/);
    assert.match(window.document.querySelector("#capture-efficiency-section").textContent, /Cloudflare account-wide allowance/);
    assert.match(window.document.querySelector("#capture-efficiency-section").textContent, /fbo QA status/);
    assert.match(window.document.querySelector("#capture-efficiency-section").textContent, /10 site samples/);
    assert.match(window.document.querySelector("#capture-efficiency-section").textContent, /8m 0s measured, 2m 0s reserve-estimated/);
    assert.doesNotMatch(window.document.querySelector("#capture-target-list").textContent, /Capture efficiency and Browser Run usage/);

    await navigate(window, () => window.document.querySelector('#module-navigation a[href="#dashboard"]').click());
    const insightsLink = window.document.querySelector('#module-navigation a[href="#fleet-insights"]');
    await navigate(window, () => insightsLink.click());
    assert.equal(window.document.querySelector("#dashboard-tiles").hidden, true);
    assert.equal(window.document.querySelector("#overview-section").hidden, false);
    assert.equal(window.document.activeElement.id, "fleet-insights-title");
    assert.equal(insightsLink.getAttribute("aria-current"), "page");
    assert.match(window.document.querySelector("#fleet-attention").textContent, /schedule needs review/);
    assert.match(window.document.querySelector("#fleet-data-as-of").textContent, /Data as of/);
    await navigate(window, () => window.document.querySelector('#fleet-attention a[href="#sites-section"]').click());
    assert.equal(window.document.querySelector("#sites-section").hidden, false);
  } finally {
    dom.window.close();
  }
});

test("API dashboard editor adds provider-aware sources and preserves existing IDs and order", { timeout: 5000 }, async () => {
  const { dom, window, requests } = openConsole([{
      capture_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      name: "Operations status",
      enabled: true,
      capture_interval_seconds: 300,
      viewport_width: 1920,
      viewport_height: 1080,
      configuration: {
        width: 1920,
        height: 1080,
        sources: [
          { id: "keep-kuma", provider: "uptime-kuma", display_name: "Kuma", enabled: false, hostname: "kuma.example.org", slug: "status" },
          { id: "keep-status", provider: "atlassian-statuspage", display_name: "Status", enabled: true, hostname: "status.example.org", optional_note: "preserve" },
        ],
      },
      sources: [
        { id: "keep-kuma", displayName: "Kuma", freshness: "unavailable", disabled: true, requestStats: { requestCount: 0, notModifiedCount: 0, failedRequestCount: 0, responseBytes: 0, durationMs: 0 } },
        { id: "keep-status", displayName: "Status", freshness: "fresh", requestStats: { requestCount: 1, notModifiedCount: 1, failedRequestCount: 0, responseBytes: 1200, durationMs: 45 }, cache: { summary: { etag: '"v1"', cacheControl: "public, max-age=0", contentFetchedAt: "2026-11-05T11:00:00Z", revalidatedAt: "2026-11-05T12:00:00Z" } } },
      ],
      last_success_at: 1_794_000_000_000,
      current_size: 125000,
      api_last_image_at: 1_793_999_000_000,
      api_fetch_ms: 180,
      api_render_ms: 0,
      api_total_ms: 300,
      api_asset_reused: 1,
      recent_metrics: { sample_count: 8, successes: 7, failures: 1, completed_count: 8, retry_attempts: 2, partial_source_failures: 1, all_source_failures: 1, upstream_requests: 12, not_modified_responses: 3, upstream_failed_requests: 1, response_bytes: 24000, fetch_p50_ms: 180, fetch_p90_ms: 560, render_p50_ms: 230, render_p90_ms: 410, total_p50_ms: 300, total_p90_ms: 600, render_operations: 4, render_failures: 1, content_hash_matches: 3, asset_reuses: 6 },
    }]);
  try {
    await settle();
    await navigate(window, () => window.document.querySelector('#module-navigation a[href="#dashboards-section"]').click());
    const create = window.document.querySelector("#api-dashboard-form");
    assert.equal(create.querySelectorAll("[data-dashboard-source]").length, 1);
    const sourceHostname = create.querySelector('[data-source-field="hostname"]');
    assert.equal(sourceHostname.labels[0].htmlFor, sourceHostname.id);
    assert.match(sourceHostname.getAttribute("aria-describedby"), /hostname-help/);
    sourceHostname.value = "localhost";
    sourceHostname.dispatchEvent(new window.Event("input", { bubbles: true }));
    assert.equal(sourceHostname.getAttribute("aria-invalid"), "true");
    assert.match(sourceHostname.getAttribute("aria-describedby"), /hostname-error/);
    sourceHostname.value = "status.example.org";
    sourceHostname.dispatchEvent(new window.Event("input", { bubbles: true }));
    assert.equal(sourceHostname.hasAttribute("aria-invalid"), false, "valid input clears its associated error state");
    create.querySelector("[data-add-dashboard-source]").click();
    assert.equal(create.querySelectorAll("[data-dashboard-source]").length, 2);
    const createProvider = create.querySelector("[data-dashboard-source] select[name=provider]");
    createProvider.value = "atlassian-statuspage";
    createProvider.dispatchEvent(new window.Event("change", { bubbles: true }));
    assert.equal(create.querySelector("[data-dashboard-source] [name=slug]").hidden, true);

    const card = window.document.querySelector("#api-dashboard-list article");
    assert.ok(card, "existing dashboard is listed in its own module");
    assert.match(card.textContent, /Last successful capture/);
    assert.match(card.textContent, /Image last changed/);
    assert.match(card.textContent, /PNG 122\.1 KB/);
    assert.match(card.textContent, /capture work 300 ms/);
    assert.match(card.textContent, /Efficiency · 8 recent jobs/);
    assert.match(card.textContent, /API fetch duration/);
    assert.match(card.textContent, /Capture work wall time/);
    assert.match(card.textContent, /1 render failure/);
    assert.match(card.textContent, /p50/);
    assert.match(card.textContent, /Worker CPU and memory/);
    assert.match(card.textContent, /Kuma: Disabled/);
    assert.match(card.textContent, /Status: Fresh/);
    assert.match(card.textContent, /Last-Modified|ETag/);
    assert.deepEqual([...window.document.querySelectorAll("#dashboards-section > .page-header .page-header__meta span")].map((item) => item.textContent), [
      "1 API dashboards", "0 with errors",
    ]);
    const edit = card.querySelector("[data-api-dashboard-edit]");
    assert.ok(edit);
    const editSourceToolbar = edit.querySelector(".source-editor-toolbar");
    assert.equal(editSourceToolbar.getAttribute("role"), "group");
    assert.equal(editSourceToolbar.getAttribute("aria-label"), "Dashboard source controls");
    const sourceRows = edit.querySelectorAll("[data-dashboard-source]");
    assert.equal(sourceRows.length, 2);
    assert.deepEqual([...sourceRows].map((row) => row.querySelector("[name=id]").value), ["keep-kuma", "keep-status"]);
    assert.equal(sourceRows[0].querySelector("[name=enabled]").checked, false);
    assert.equal(sourceRows[1].querySelector("[name=slug]").hidden, true);
    sourceRows[0].querySelector("[data-move-source-down]").click();
    edit.querySelector("[data-save-api-dashboard]").click();
    await settle();
    const update = requests.find((request) => request.path.endsWith("/dddddddd-dddd-4ddd-8ddd-dddddddddddd") && request.options.method === "PATCH");
    assert.ok(update, "save posts a structured configuration update");
    const body = JSON.parse(update.options.body);
    assert.deepEqual(body.sources.map((source) => source.id), ["keep-status", "keep-kuma"]);
    assert.equal(body.sources[1].enabled, false);
    assert.equal(body.sources[0].optional_note, "preserve");
  } finally {
    dom.window.close();
  }
});

test("site search, naming, and schedule review send the selected site data", async () => {
  const { dom, window, requests } = openConsole();
  try {
    await settle();
    assert.match(window.document.querySelector("#capture-target-list").textContent, /https:\/\/status.example\//);
    assert.match(window.document.querySelector("#capture-target-list").textContent, /Schedule review needed/);
    assert.match(window.document.querySelector("#capture-target-list").textContent, /fbo QA status/);

    const intervalErrors = [];
    window.addEventListener("error", (event) => {
      intervalErrors.push(event.message);
      event.preventDefault();
    });
    const intervalSelect = window.document.querySelector(".capture-target__details select");
    assert.equal(intervalSelect.hasAttribute("aria-label"), false);
    assert.match(window.document.querySelector(`label[for="${intervalSelect.id}"]`)?.textContent ?? "", /^Screenshot interval/);
    const selectorInput = window.document.querySelector('.capture-target__details input[maxlength="256"]');
    assert.equal(selectorInput.hasAttribute("aria-label"), false);
    assert.equal(window.document.querySelector(`label[for="${selectorInput.id}"]`)?.textContent, "Wait for CSS selector");
    assert.deepEqual(Array.from(intervalSelect.options, ({ textContent }) => textContent), [
      "15 minutes", "30 minutes", "1 hour", "3 hours", "6 hours", "12 hours", "24 hours",
    ]);
    intervalSelect.value = "3600";
    intervalSelect.dispatchEvent(new window.Event("change", { bubbles: true }));
    assert.deepEqual(intervalErrors, [], "changing a screenshot interval does not raise a runtime error");

    const search = window.document.querySelector("#capture-search");
    search.value = "status.example";
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
    assert.equal(window.document.querySelectorAll("#capture-target-list .capture-target:not([hidden])").length, 1);
    search.value = "";
    search.dispatchEvent(new window.Event("input", { bubbles: true }));

    const nameInput = window.document.querySelector("#capture-target-list input[data-site-name]");
    nameInput.value = "fbo QA status";
    assert.equal(nameInput.labels[0].textContent.includes("Name (optional)"), true);
    nameInput.closest(".settings-group").querySelector("button").click();
    await settle();
    const nameRequest = requests.find(({ path }) => path.endsWith("/name"));
    assert.equal(JSON.parse(nameRequest.options.body).name, "fbo QA status");

    const scheduleButton = [...window.document.querySelectorAll("#capture-target-list button")]
      .find((button) => button.textContent === "Confirm schedule");
    scheduleButton.click();
    await settle();
    const scheduleRequest = requests.find(({ path }) => path === "/admin/api/captures/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    assert.equal(scheduleRequest.options.method, "PATCH");
    assert.equal(JSON.parse(scheduleRequest.options.body).capture_interval_seconds, 86400);
  } finally {
    dom.window.close();
  }
});

test("operators can register a site and stage a playlist with an existing capture", async () => {
  const { dom, window, requests } = openConsole();
  try {
    await settle();
    const siteForm = window.document.querySelector("#capture-site-form");
    siteForm.elements.namedItem("url").value = "https://added.example/";
    siteForm.dispatchEvent(new window.SubmitEvent("submit", { bubbles: true, cancelable: true }));
    const siteSubmit = siteForm.querySelector("button[type=submit]");
    assert.equal(siteSubmit.disabled, true);
    assert.equal(siteSubmit.textContent, "Adding site…");
    assert.equal(window.document.querySelector("#capture-site-feedback").textContent, "Adding site…");
    await settle();
    assert.equal(siteSubmit.disabled, false);
    assert.equal(siteSubmit.textContent, "Add site");
    const siteRequest = requests.find(({ path }) => path === "/admin/api/capture-sites");
    assert.deepEqual(JSON.parse(siteRequest.options.body), {
      url: "https://added.example/", viewport: { width: 1920, height: 1080 },
    });

    window.document.querySelector('[name="id"]').value = "operations";
    window.document.querySelector("#available-sites input[data-capture-id]").checked = true;
    window.document.querySelector("#playlist-form").dispatchEvent(new window.SubmitEvent("submit", { bubbles: true, cancelable: true }));
    const playlistSubmit = window.document.querySelector("#playlist-submit");
    assert.equal(playlistSubmit.disabled, true);
    assert.equal(playlistSubmit.textContent, "Saving playlist version…");
    await settle();
    assert.equal(playlistSubmit.disabled, false);
    assert.equal(playlistSubmit.textContent, "Save playlist version");
    const playlistRequest = requests.find(({ path }) => path === "/admin/api/playlists");
    assert.deepEqual(JSON.parse(playlistRequest.options.body).captures, [
      { capture_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    ]);
  } finally {
    dom.window.close();
  }
});

test("uploaded playlist progress clears after a version saves", async () => {
  const { dom, window, requests } = openConsole();
  try {
    await settle();
    const file = new window.File(["png-data"], "status.png", { type: "image/png" });
    const NativeFormData = window.FormData;
    class TestFormData extends NativeFormData {
      getAll(name) {
        return name === "assets" ? [file] : super.getAll(name);
      }
    }
    Object.defineProperty(window, "FormData", { configurable: true, value: TestFormData });

    const form = window.document.querySelector("#playlist-form");
    form.elements.namedItem("id").value = "operations";
    form.dispatchEvent(new window.SubmitEvent("submit", { bubbles: true, cancelable: true }));
    const feedback = window.document.querySelector("#playlist-feedback");
    assert.equal(feedback.textContent, "Uploading your images…");
    await settle();

    assert.equal(requests.some(({ path }) => path === "/admin/api/assets"), true);
    assert.equal(requests.some(({ path }) => path === "/admin/api/playlists"), true);
    assert.equal(feedback.hidden, true, "completed progress is cleared from the inline form feedback");
    assert.match(window.document.querySelector('[data-feedback-slot="playlist"]').textContent, /New version/);
  } finally {
    dom.window.close();
  }
});

test("site and device deletion send explicit requests", async () => {
  const { dom, window, requests, overview } = openConsole();
  try {
    await settle();
    const siteCard = [...window.document.querySelectorAll("#capture-target-list article")]
      .find((card) => card.querySelector("h3")?.textContent === "fbo QA status");
    const removeSiteButton = [...siteCard.querySelectorAll("button")]
      .find((button) => button.textContent === "Remove capture site");
    assert.ok(removeSiteButton);
    assert.equal(removeSiteButton.closest("details").open, false);
    removeSiteButton.click();
    await settle();
    const removeSiteRequest = requests.find(({ path }) => path === "/admin/api/captures/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    assert.equal(removeSiteRequest.options.method, "DELETE");

    overview.devices = [{ device_id: "pi-office", enabled: true, auth_type: "key", health: { status: "healthy" } }];
    window.document.querySelector("#reload").click();
    await settle();
    const removeDeviceButton = [...window.document.querySelectorAll("#devices button")]
      .find((button) => button.textContent === "Delete device");
    assert.ok(removeDeviceButton);
    assert.equal(removeDeviceButton.closest("details").open, false);
    removeDeviceButton.click();
    await settle();
    const removeDeviceRequest = requests.find(({ path }) => path === "/admin/api/devices/pi-office");
    assert.equal(removeDeviceRequest.options.method, "DELETE");
  } finally {
    dom.window.close();
  }
});

test("playlist revisions stay grouped and refresh errors can be dismissed", async () => {
  const { dom, window, overview, setFailure } = openConsole();
  try {
    await settle();
    overview.playlists = [
      { playlist_id: "operations", revision: "rev-one", active: true, rotation_interval: "90s", asset_count: 1, created_at: 1 },
      { playlist_id: "operations", revision: "rev-two", active: false, rotation_interval: "90s", asset_count: 2, created_at: 2 },
      { playlist_id: "status", revision: "rev-three", active: false, rotation_interval: "90s", asset_count: 1, created_at: 3 },
    ];
    window.document.querySelector("#reload").click();
    await settle();
    assert.equal(window.document.querySelectorAll("#playlists .playlist-group").length, 2);
    assert.equal(window.document.querySelectorAll("#playlists-mobile .playlist-group").length, 2);
    assert.equal(window.document.querySelector("#playlists .playlist-group tbody").rows.length, 2);

    setFailure(true);
    window.document.querySelector("#reload").click();
    await settle();
    const notice = window.document.querySelector('[data-feedback-slot="global"]');
    assert.equal(notice.hidden, false);
    assert.match(notice.textContent, /Refresh failed/);
    notice.querySelector("[data-dismiss-feedback]").click();
    assert.equal(notice.hidden, true);
  } finally {
    dom.window.close();
  }
});
