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
    schedule_reviewed: true, active_in_playlist: true, last_success_at: 1_700_000_000_000,
    wait_for_selector: ".status-indicator", average_browser_ms: 50_000, browser_ms_samples: 10,
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

function openConsole(initialDashboards = [], {
  smallScreen = false,
  initialDecisions = [],
  captureTargets,
  storedCaptureView,
  unavailableLocalStorage = false,
  fakeTimers = false,
} = {}) {
  const dom = new JSDOM(html, { url: "https://example.test/admin/", runScripts: "outside-only" });
  const { window } = dom;
  const calls = [];
  const requests = [];
  const scheduledTimers = new Map();
  let nextTimerID = 0;
  const overview = overviewFixture();
  if (captureTargets) overview.capture_targets = captureTargets;
  let apiDashboards = initialDashboards;
  const captureDecisions = initialDecisions;
  let fail = false;
  window.matchMedia = (query) => ({
    matches: smallScreen && query === "(max-width: 56rem)",
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return false; },
  });
  window.confirm = () => true;
  if (storedCaptureView) window.localStorage.setItem("ribbonfish.capture-sites.view", storedCaptureView);
  if (unavailableLocalStorage) {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() { throw new window.DOMException("Storage unavailable", "SecurityError"); },
    });
  }
  if (fakeTimers) {
    window.setTimeout = (callback, delay = 0) => {
      const timerID = ++nextTimerID;
      scheduledTimers.set(timerID, { callback, delay });
      return timerID;
    };
    window.clearTimeout = (timerID) => scheduledTimers.delete(timerID);
  }
  window.fetch = async (path, options = {}) => {
    calls.push(path);
    requests.push({ path, options });
    const body = fail ? { error: "Refresh failed" } :
      path === "/admin/api/capture-sites" ? { schedule_reviewed: false } :
      path === "/admin/api/playlists" ? { revision: "revision-1", capture_count: 2 } :
      path === "/admin/api/jev/capture-assessment" ? {
        suggestion: "skip_once", risk: { score: 0, label: "Low", confidence: 0.9 },
        skip_eligibility: { eligible: true, due_at: 1_800_000_000_000 },
      } :
      path === "/admin/api/playlists/operations/rev-two/readiness" ? playlistReadinessResult() :
      path === "/admin/api/jev/playlist-readiness-assessment" ? playlistReadinessResult(true) :
      path === "/admin/api/active-playlist" ? { active_playlist: { playlist_id: "operations", revision: "rev-two" } } :
      path === "/admin/api/overview" ? overview : path === "/admin/api/api-dashboards" ? apiDashboards :
      path === "/admin/api/capture-decisions" ? captureDecisions : path === "/admin/api/intervals" ? {
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
    scheduledTimers,
    fireTimers() {
      const pending = [...scheduledTimers.values()];
      scheduledTimers.clear();
      pending.forEach(({ callback }) => callback());
    },
    setFailure(value) { fail = value; },
    setDashboards(value) { apiDashboards = value; },
  };
}

function playlistReadinessResult(withAssessment = false) {
  return {
    revision: { playlist_id: "operations", revision: "rev-two" },
    status: "review",
    summary: {
      total_items: 1, total_captures: 1, fresh_captures: 0, missing_assets: 0,
      stale_captures: 1, disabled_captures: 0, unreviewed_schedules: 0, devices_to_update: 1,
    },
    blockers: [], warnings: ["stale_captures"],
    items: [{ label: "Capture 1", status: "stale" }],
    devices_to_update: [{ device_id: "pi-office", sync_status: "behind" }],
    latest_assessment: withAssessment ? {
      assessed_at: Date.now(), deterministic_status: "review",
      answers: { assessment: { choice: "review" }, risk: { label: "Moderate" } },
      observed_outcome: "not_activated",
    } : null,
  };
}

test("capture site background assessment is shown once", async () => {
  const decision = {
    capture_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    action: "defer_once",
    assessed_at: 1_700_000_100_000,
    due_at: 1_700_000_200_000,
    reason: "Recent screenshots were stable.",
    observed_result: null,
  };
  const { dom, window } = openConsole([], { initialDecisions: [decision] });
  try {
    await settle();
    const card = [...window.document.querySelectorAll(".capture-target")]
      .find((item) => item.dataset.search.includes("status.example"));
    card.querySelector("[data-edit-capture-site]").click();
    const dialog = window.document.querySelector("#capture-site-dialog");
    assert.equal((dialog.querySelector("#capture-site-assessment-content").textContent.match(/Background assessment/g) ?? []).length, 1);
  } finally {
    dom.window.close();
  }
});

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
    assert.equal(window.document.querySelector("#capture-site-dialog").open, false);

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

test("management navigation starts collapsed on narrow screens and can be expanded", { timeout: 5000 }, async () => {
  const { dom, window } = openConsole([], { smallScreen: true });
  try {
    await settle();
    const navigation = window.document.querySelector("#module-navigation");
    const toggle = window.document.querySelector("#module-navigation-toggle");
    assert.equal(navigation.hidden, true);
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.ok(window.document.querySelector("#overview-section"), "the overview replaces the removed home tiles");
    toggle.click();
    assert.equal(navigation.hidden, false);
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
      ["overview-section", "overview-title", "Fleet overview"],
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
    assert.match(sitesDescription.textContent, /scheduled captures run while a site is included in the active playlist/i);
    assert.equal(sitesHeader.querySelector("h2").getAttribute("aria-describedby"), sitesDescription.id);
    assert.equal(sitesHeader.querySelector(".page-header__meta").hidden, true,
      "site totals are shown once beside the wired status filters");
    const deviceHeader = window.document.querySelector("#device-section > .page-header");
    assert.deepEqual([...deviceHeader.querySelectorAll(".page-header__meta span")].map((item) => item.textContent), [
      "0 devices", "0 awaiting approval",
    ]);

    for (const sectionID of ["sites-section", "dashboards-section", "playlist-section"]) {
      assert.equal(window.document.querySelector(`#${sectionID} .page-header__actions`), null,
        `${sectionID} keeps its editor action beside the editor instead of repeating it in the page heading`);
    }
    for (const [editorID, label] of [
      ["api-dashboard-editor", "Add an API status dashboard"],
      ["playlist-editor", "Create playlist version"],
    ]) {
      const editor = window.document.getElementById(editorID);
      assert.equal(editor.open, false);
      assert.equal(editor.querySelector("summary").textContent.trim(), label);
    }

    const filters = window.document.querySelector(".capture-filters");
    assert.equal(filters.getAttribute("role"), "group");
    assert.equal(filters.getAttribute("aria-label"), "Capture site search");
    assert.deepEqual([...filters.querySelectorAll(".toolbar__group")].map((group) => group.getAttribute("aria-label")), ["Search sites"]);
    assert.equal(filters.querySelector("input[type=search]"), window.document.getElementById("capture-search"));
    assert.equal(window.document.getElementById("capture-filter"), null);
    assert.equal(window.document.querySelector("#capture-site-filters").getAttribute("aria-label"), "Filter screenshot sites");
    assert.equal(window.document.querySelector("#capture-site-view-toggle").hidden, true, "the list view is reserved for ten or more sites");

    const sourceToolbar = window.document.querySelector("#api-dashboard-source-list > .source-editor-toolbar");
    assert.equal(sourceToolbar.getAttribute("role"), "group");
    assert.equal(sourceToolbar.getAttribute("aria-label"), "Dashboard source controls");
    assert.equal(sourceToolbar.querySelector("[data-add-dashboard-source]").textContent, "Add source");

    const siteEditor = window.document.getElementById("capture-site-dialog");
    assert.equal(siteEditor.open, false);
    window.document.getElementById("add-capture-site").click();
    assert.equal(siteEditor.open, true, "the add form opens in the shared site dialog");
    assert.equal(window.document.getElementById("capture-site-form").hidden, false);
    assert.equal(window.document.getElementById("capture-site-edit-form").hidden, true);
    siteEditor.querySelector("[data-close-capture-site-dialog]").click();
    assert.equal(siteEditor.open, false);
    window.document.querySelector("#api-dashboard-editor > summary").click();
    const dashboardEditor = window.document.getElementById("api-dashboard-editor");
    assert.equal(dashboardEditor.open, true, "the dashboard editor opens from its native disclosure trigger");
    window.document.querySelector("#playlist-editor > summary").click();
    assert.equal(window.document.getElementById("playlist-editor").open, true);
  } finally {
    dom.window.close();
  }
});

test("overview navigation renders the fleet landing page, capture efficiency and deep linked findings", { timeout: 5000 }, async () => {
  const { dom, window } = openConsole();
  try {
    await settle();
    assert.equal(window.document.querySelector("#overview-section").hidden, false);
    assert.equal(window.document.querySelector("#dashboard-tiles"), null);
    await navigate(window, () => window.document.querySelector('#module-navigation a[href="#capture-efficiency-section"]').click());
    assert.equal(window.document.querySelector("#capture-efficiency-section").hidden, false);
    assert.equal(window.document.activeElement.id, "capture-efficiency-title");
    assert.equal(window.document.querySelector('#module-navigation a[href="#capture-efficiency-section"]').getAttribute("aria-current"), "page");
    assert.equal(window.document.querySelectorAll("#capture-efficiency-section .metric-card").length, 0,
      "daily use and forecast are combined into one clear summary");
    assert.equal(window.document.querySelectorAll("#capture-efficiency-section .scale-meter").length, 2);
    assert.match(window.document.querySelector("#capture-efficiency-section").textContent, /10m 0s of 10m 0s Browser Run minutes used today/);
    assert.match(window.document.querySelector("#capture-efficiency-section").textContent, /Current schedules are forecast to stay within the Ribbonfish daily budget/);
    assert.equal(window.document.querySelector("#capture-efficiency-section details.capture-efficiency-advanced").open, false);
    assert.match(window.document.querySelector("#capture-efficiency-section").textContent, /Cloudflare account-wide allowance/);
    assert.match(window.document.querySelector("#capture-efficiency-section").textContent, /fbo QA status/);
    assert.match(window.document.querySelector("#capture-efficiency-section").textContent, /10 site samples/);
    const recentOutcomes = window.document.querySelector("#capture-efficiency-section [data-table='capture-outcomes']");
    assert.match(recentOutcomes.textContent, /Browser Run time measured from response headers8m 0s/);
    assert.match(recentOutcomes.textContent, /Browser Run time estimated using the configured reserve2m 0s/);
    assert.doesNotMatch(window.document.querySelector("#capture-target-list").textContent, /Capture efficiency and Browser Run usage/);

    await navigate(window, () => { window.location.hash = "#fleet-insights"; });
    assert.equal(window.document.querySelector("#overview-section").hidden, false);
    assert.equal(window.document.activeElement.id, "fleet-insights-title");
    assert.equal(window.document.querySelector('#module-navigation a[href="#overview-section"]').getAttribute("aria-current"), "page");
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
    assert.match(card.textContent, /capture work 300 ms/);
    const latestCaptureDetails = card.querySelector(".capture-target__latest-details");
    assert.ok(latestCaptureDetails);
    assert.equal(latestCaptureDetails.open, false, "latest capture diagnostics stay out of the first-read summary");
    assert.deepEqual([...latestCaptureDetails.querySelectorAll("dt")].map((term) => term.textContent), [
      "Image last changed", "Latest PNG", "Last run",
    ]);
    assert.match(latestCaptureDetails.querySelectorAll("dd")[1].textContent, /122\.1 KB/);
    assert.match(card.textContent, /Efficiency · 8 recent jobs/);
    assert.match(card.textContent, /API fetch duration/);
    assert.match(card.textContent, /Capture work wall time/);
    assert.match(card.textContent, /1 render failure/);
    assert.match(card.textContent, /p50/);
    assert.match(card.textContent, /Worker CPU and memory/);
    assert.match(card.textContent, /Kuma: Disabled/);
    assert.match(card.textContent, /Status: Fresh/);
    assert.match(card.textContent, /Last-Modified|ETag/);
    const removeActions = [...card.querySelectorAll("details")].find((details) => details.querySelector("summary")?.textContent.includes("More actions"));
    assert.ok(removeActions);
    assert.equal(removeActions.open, false);
    assert.equal(removeActions.querySelector("button.button--danger")?.textContent, "Remove dashboard");
    assert.deepEqual([...window.document.querySelectorAll("#dashboards-section > .page-header .page-header__meta span")].map((item) => item.textContent), [
      "1 API dashboards", "0 need attention",
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

test("capture site summaries show each fact once and labelled filters match the site status", async () => {
  const { dom, window } = openConsole();
  try {
    await settle();
    const first = [...window.document.querySelectorAll("#capture-target-cards .capture-target")]
      .find((card) => card.dataset.search.includes("status.example"));
    assert.ok(first);
    assert.match(first.textContent, /fbo QA status/);
    assert.doesNotMatch(first.textContent, /https:\/\/status\.example/);
    assert.match(first.textContent, /Screenshot ready/);
    assert.match(first.textContent, /Last successful capture/);
    assert.match(first.textContent, /1920 × 1080 px/);
    assert.equal(first.querySelectorAll("details").length, 2, "the capture workbench and overflow menu use native disclosures");
    assert.equal(first.querySelectorAll(".capture-target__error").length, 0);
    assert.equal(first.querySelectorAll(".capture-target__url").length, 0);
    assert.equal((first.textContent.match(/1 day/g) ?? []).length, 1);
    assert.equal(first.querySelector("[data-capture-action=run]").textContent, "Take screenshot now");

    const second = [...window.document.querySelectorAll("#capture-target-cards .capture-target")]
      .find((card) => card.dataset.search.includes("new.example"));
    assert.match(second.textContent, /Schedule review needed/);
    assert.match(second.textContent, /No successful capture yet/);
    assert.doesNotMatch(second.textContent, /Screenshot error:/);

    const filters = window.document.querySelector("#capture-site-filters");
    assert.match(window.document.querySelector("#capture-site-counts").textContent, /2 screenshot sites · 1 need attention/);
    assert.match(filters.querySelector('[data-capture-filter="all"]').textContent, /2/);
    assert.match(filters.querySelector('[data-capture-filter="attention"]').textContent, /1/);
    assert.match(filters.querySelector('[data-capture-filter="ready"]').textContent, /1/);

    filters.querySelector('[data-capture-filter="attention"]').click();
    assert.equal(filters.querySelector('[data-capture-filter="attention"]').getAttribute("aria-pressed"), "true");
    assert.equal(first.hidden, true);
    assert.equal(second.hidden, false);
    assert.equal(window.document.querySelector("#capture-filter-empty").hidden, true);

    filters.querySelector('[data-capture-filter="all"]').click();
    const search = window.document.querySelector("#capture-search");
    search.value = "status.example";
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
    assert.equal([...window.document.querySelectorAll("#capture-target-cards .capture-target")].filter((card) => !card.hidden).length, 1);
    search.value = "";
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
  } finally {
    dom.window.close();
  }
});

test("one edit save sends only the changed fields to existing endpoints", async () => {
  const { dom, window, requests } = openConsole();
  try {
    await settle();
    const first = [...window.document.querySelectorAll("#capture-target-cards .capture-target")]
      .find((card) => card.dataset.search.includes("status.example"));
    first.querySelector("[data-edit-capture-site]").click();
    const dialog = window.document.querySelector("#capture-site-dialog");
    const form = window.document.querySelector("#capture-site-edit-form");
    assert.equal(dialog.open, true);
    assert.equal(window.document.querySelector("#capture-site-form").hidden, true);
    assert.equal(form.hidden, false);
    assert.equal(form.querySelector('[name="name"]').value, "fbo QA status");
    assert.equal(form.querySelector('[name="wait_for_selector"]').value, ".status-indicator");
    assert.equal(form.querySelectorAll("[data-save-site-changes]").length, 1);
    assert.match(form.querySelector("[data-save-site-changes]").textContent, /Save changes/);
    assert.equal((form.textContent.match(/schedule is shared/gi) ?? []).length, 1);

    form.querySelector('[name="name"]').value = "Operations screen";
    form.querySelector('[name="wait_for_selector"]').value = ".incident-list";
    form.dispatchEvent(new window.SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await settle();
    const changedRequests = requests.filter(({ path, options }) => path.includes("/captures/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") && options.method === "PATCH");
    assert.deepEqual(changedRequests.map(({ path, options }) => [path.split("/").at(-1), JSON.parse(options.body)]), [
      ["name", { name: "Operations screen" }],
      ["readiness", { wait_for_selector: ".incident-list" }],
    ]);
    assert.equal(dialog.open, false);
  } finally {
    dom.window.close();
  }
});

test("Confirm schedule reviews an unchanged interval and screenshot actions remain available", async () => {
  const { dom, window, requests } = openConsole();
  try {
    await settle();
    const second = [...window.document.querySelectorAll("#capture-target-cards .capture-target")]
      .find((card) => card.dataset.search.includes("new.example"));
    second.querySelector("[data-edit-capture-site]").click();
    const form = window.document.querySelector("#capture-site-edit-form");
    const save = form.querySelector("[data-save-site-changes]");
    assert.equal(save.textContent, "Confirm schedule");
    assert.equal(form.querySelector("#capture-site-schedule-note").hidden, false);
    assert.equal(form.querySelector('[name="capture_interval_seconds"]').value, "86400");
    form.dispatchEvent(new window.SubmitEvent("submit", { bubbles: true, cancelable: true }));
    await settle();
    const scheduleRequest = requests.find(({ path, options }) => path === "/admin/api/captures/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" && options.method === "PATCH");
    assert.deepEqual(JSON.parse(scheduleRequest.options.body), { capture_interval_seconds: 86400 });

    const first = [...window.document.querySelectorAll("#capture-target-cards .capture-target")]
      .find((card) => card.dataset.search.includes("status.example"));
    first.querySelector("[data-capture-action=run]").click();
    await settle();
    const runRequest = requests.find(({ path, options }) => path.endsWith("/run") && options.method === "POST");
    assert.deepEqual(JSON.parse(runRequest.options.body), {});
    assert.match(window.document.querySelector("#feedback-toast").textContent, /Screenshot job/);
  } finally {
    dom.window.close();
  }
});

test("A2UI capture workbench assesses and confirms an eligible skip while removal stays in the overflow menu", async () => {
  const { dom, window, requests } = openConsole();
  try {
    await settle();
    const first = [...window.document.querySelectorAll("#capture-target-cards .capture-target")]
      .find((card) => card.dataset.search.includes("status.example"));
    const overflow = first.querySelector("details.action-disclosure");
    assert.ok(overflow);
    assert.equal(overflow.open, false);
    first.querySelector("[data-a2ui-event='assess_capture']").click();
    await settle();
    assert.ok(first.querySelector("[data-a2ui-event='confirm_skip_once']"));
    assert.ok(requests.some(({ path, options }) => path === "/admin/api/jev/capture-assessment" && options.method === "POST"));
    first.querySelector("[data-a2ui-event='confirm_skip_once']").click();
    await settle();
    assert.ok(requests.some(({ path, options }) => path === "/admin/api/captures/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/skip-once" && options.method === "POST"));

    overflow.querySelector("summary").click();
    const remove = overflow.querySelector("[data-capture-action=remove]");
    assert.equal(remove.textContent, "Remove capture site");
    remove.click();
    await settle();
    const removeRequest = requests.find(({ path, options }) => path === "/admin/api/captures/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" && options.method === "DELETE");
    assert.ok(removeRequest);
  } finally {
    dom.window.close();
  }
});

test("capture sites offer a remembered list view from ten sites and tolerate unavailable localStorage", async () => {
  const targets = Array.from({ length: 10 }, (_, index) => ({
    ...overviewFixture().capture_targets[0],
    capture_id: `site-${index}`,
    display_url: `https://site-${index}.example/`,
    name: `Site ${index}`,
  }));
  const { dom, window } = openConsole([], { captureTargets: targets, storedCaptureView: "list" });
  try {
    await settle();
    const toggle = window.document.querySelector("#capture-site-view-toggle");
    assert.equal(toggle.hidden, false);
    assert.equal(toggle.querySelector('[data-capture-view="list"]').getAttribute("aria-pressed"), "true");
    const table = window.document.querySelector("#capture-target-table-view table");
    assert.equal(table.querySelector("caption").textContent, "Capture sites");
    assert.deepEqual([...table.querySelectorAll("thead th")].map((heading) => heading.textContent), ["Name", "Status", "Last capture", "Interval", "Actions"]);
    assert.ok([...table.querySelectorAll("thead th")].every((heading) => heading.getAttribute("scope") === "col"));
    assert.ok(table.closest(".table-scroll"));
    assert.equal(window.document.querySelectorAll("#capture-target-table-view .mobile-card-list .capture-target").length, 10);
    assert.equal(window.document.querySelector("#capture-target-cards").hidden, true);
    toggle.querySelector('[data-capture-view="cards"]').click();
    assert.equal(toggle.querySelector('[data-capture-view="cards"]').getAttribute("aria-pressed"), "true");
    assert.equal(window.localStorage.getItem("ribbonfish.capture-sites.view"), "cards");
    toggle.querySelector('[data-capture-view="list"]').click();
    assert.equal(toggle.querySelector('[data-capture-view="list"]').getAttribute("aria-pressed"), "true");
    assert.equal(window.localStorage.getItem("ribbonfish.capture-sites.view"), "list");
  } finally {
    dom.window.close();
  }

  const blocked = openConsole([], { captureTargets: targets, unavailableLocalStorage: true });
  try {
    await settle();
    assert.equal(blocked.window.document.querySelector("#capture-site-view-toggle").hidden, false);
    assert.equal(blocked.window.document.querySelector('#capture-site-view-toggle [data-capture-view="cards"]').getAttribute("aria-pressed"), "true");
  } finally {
    blocked.dom.window.close();
  }
});

test("operators can register a site and stage a playlist with an existing capture", async () => {
  const { dom, window, requests } = openConsole();
  try {
    await settle();
    window.document.querySelector("#add-capture-site").click();
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
    assert.equal(window.document.querySelector("#capture-site-dialog").open, false);

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
    assert.match(window.document.querySelector("#feedback-toast").textContent, /New version/);
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
    const siteOverflow = siteCard.querySelector("details.action-disclosure");
    assert.ok(siteOverflow);
    siteOverflow.querySelector("summary").click();
    const removeSiteButton = siteOverflow.querySelector("[data-capture-action=remove]");
    assert.ok(removeSiteButton);
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
    const operationsCards = window.document.querySelectorAll("#playlists-mobile .playlist-group:first-child .data-card");
    assert.deepEqual([...operationsCards].map((card) => card.querySelector("h3")?.textContent), ["rev-one", "rev-two"]);
    assert.equal(operationsCards[0].querySelector("dt")?.textContent, "Show each item for", "playlist ID is carried by the group heading instead of repeated in every revision card");

    setFailure(true);
    window.document.querySelector("#reload").click();
    await settle();
    const notice = window.document.querySelector("#feedback-toast");
    assert.equal(notice.hidden, false);
    assert.match(notice.textContent, /Refresh failed/);
    notice.querySelector("[data-dismiss-feedback]").click();
    assert.equal(notice.hidden, true);
  } finally {
    dom.window.close();
  }
});

test("playlist readiness renders affected devices, stores a shadow result, and preflights activation", async () => {
  const { dom, window, overview, requests } = openConsole();
  try {
    await settle();
    overview.playlists = [
      { playlist_id: "operations", revision: "rev-two", active: false, rotation_interval: "90s", asset_count: 1, created_at: 2 },
    ];
    window.document.querySelector("#reload").click();
    await settle();

    const row = [...window.document.querySelectorAll("#playlists tbody tr")]
      .find((item) => item.textContent.includes("rev-two"));
    assert.ok(row);
    const readiness = row.querySelector(".playlist-readiness-disclosure");
    readiness.querySelector("summary").click();
    await settle();
    assert.match(readiness.textContent, /Fresh captures\s*0 \/ 1/);
    assert.match(readiness.textContent, /pi-office/);
    assert.match(readiness.textContent, /stale captures/);

    readiness.querySelector("button").click();
    await settle();
    assert.match(readiness.textContent, /JEV shadow assessment/);
    assert.match(readiness.textContent, /Moderate risk/);
    assert.ok(requests.some(({ path, options }) => path === "/admin/api/jev/playlist-readiness-assessment" && options.method === "POST"));

    const activate = [...row.querySelectorAll("button")].find((item) => item.textContent === "Activate version");
    assert.ok(activate);
    activate.click();
    await settle();
    const readinessGets = requests.filter(({ path, options }) => path.endsWith("/readiness") && options.method === undefined);
    const activation = requests.find(({ path, options }) => path === "/admin/api/active-playlist" && options.method === "PUT");
    assert.ok(readinessGets.length >= 2, "activation loads a fresh deterministic readiness result");
    assert.ok(activation, "eligible revisions can still be activated after confirmation");
  } finally {
    dom.window.close();
  }
});

test("feedback toast auto-dismisses success and keeps errors until dismissed", async () => {
  const { dom, window, scheduledTimers, fireTimers, setFailure } = openConsole([], { fakeTimers: true });
  try {
    await settle();
    const toast = window.document.querySelector("#feedback-toast");
    window.document.querySelector("[data-capture-action=run]").click();
    await settle();
    assert.equal(toast.hidden, false);
    assert.match(toast.textContent, /Screenshot job/);
    assert.equal(toast.getAttribute("role"), "status");
    assert.equal(toast.getAttribute("aria-live"), "polite");
    assert.deepEqual([...scheduledTimers.values()].map(({ delay }) => delay), [5000]);
    fireTimers();
    assert.equal(toast.hidden, true, "successful messages expire after five seconds");

    setFailure(true);
    window.document.querySelector("#reload").click();
    await settle();
    assert.equal(toast.hidden, false);
    assert.match(toast.textContent, /Refresh failed/);
    assert.equal(toast.getAttribute("role"), "alert");
    assert.equal(toast.getAttribute("aria-live"), "assertive");
    assert.equal(scheduledTimers.size, 0, "errors are not scheduled for automatic dismissal");
    toast.querySelector("[data-dismiss-feedback]").click();
    assert.equal(toast.hidden, true);
  } finally {
    dom.window.close();
  }
});
