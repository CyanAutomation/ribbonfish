import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { parse } from "parse5";
import postcss from "postcss";
import { renderCaptureUsageForecast } from "../public/admin/capture-forecast-view.ts";
import {
  confirmAction,
  confirmBeforeAction,
} from "../public/admin/ui-confirmation.ts";
import {
  createTransientNotice,
  createRetryableLoadOnce,
} from "../public/admin/ui-notices.ts";
import {
  formatAuditDetails,
  formatAuditEventType,
  formatActorLabel,
  compactIdentifier,
  formatCaptureInterval,
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
} from "../public/admin/ui-formatters.ts";
import { formatDeviceHealthDetails } from "../public/admin/health-details.ts";
import { buildFleetInsights } from "../public/admin/fleet-insights.ts";
import { formatTimestamp } from "../public/admin/admin-formatters.ts";
import { renderFindingCard, renderFindingList } from "../public/admin/ui-components.ts";
import { deviceNeedsReview } from "../public/admin/device-needs-review.ts";

// Contract source: ../README.md#local-development and ../README.md#management-api.
// Device health presentation contract: ../README.md#management-api.

const overview = {
  devices: [{ enabled: 1 }, { enabled: 0 }],
  playlists: [{ active: true }, { active: false }],
  active_playlist: { playlist_id: "operations", revision: "r-test" },
  asset_health: { missing: [] },
};

function descendants(node) {
  return [node, ...(node.childNodes ?? []).flatMap(descendants)];
}

function parseHTML(source) {
  return descendants(parse(source));
}

function attribute(node, name) {
  return node.attrs?.find((item) => item.name === name)?.value;
}

function byID(nodes, id) {
  return nodes.find((node) => attribute(node, "id") === id);
}

test("management page exposes accessible fleet and playlist sections", async () => {
  const html = await readFile(new URL("../public/admin/index.html", import.meta.url), "utf8");
  const nodes = parseHTML(html);
  for (const [id, label] of [
    ["fleet-summary", "Fleet overview metrics"],
    ["devices", "Enrolled devices"],
    ["playlists", "Playlist versions"],
  ]) {
    const region = byID(nodes, id);
    assert.equal(attribute(region, "role"), "region");
    assert.equal(attribute(region, "aria-label"), label);
  }
  for (const [sectionID, titleID] of [["device-section", "device-title"], ["playlist-section", "playlist-title"]]) {
    const section = byID(nodes, sectionID);
    const title = byID(nodes, titleID);
    assert.equal(attribute(section, "aria-labelledby"), titleID);
    assert.ok(title, `${sectionID} has a heading with an accessible name`);
  }
});

test("transient notices replace, pause, resume, and clear their expiry", () => {
  let nextID = 0;
  const timers = new Map();
  const expired = [];
  let now = 0;
  const notice = createTransientNotice({
    duration: 5000,
    nowFn: () => now,
    setTimeoutFn(callback, delay) {
      const id = ++nextID;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeoutFn(id) { timers.delete(id); },
    onExpire: () => expired.push("expired"),
  });

  notice.start();
  assert.equal(timers.size, 1);
  notice.start();
  assert.equal(timers.size, 1, "starting a new notice clears the previous timer");
  now = 4500;
  notice.pause();
  assert.equal(timers.size, 0);
  notice.resume();
  assert.equal(timers.size, 1);
  let [[timerID, timer]] = timers.entries();
  assert.equal(timer.delay, 500, "resume uses only the unelapsed duration");
  now = 4750;
  notice.pause();
  notice.resume();
  [[timerID, timer]] = timers.entries();
  assert.equal(timer.delay, 250, "repeated pauses continue to preserve the remaining duration");
  now = 5000;
  timers.delete(timerID);
  timer.callback();
  assert.deepEqual(expired, ["expired"]);
  assert.equal(timers.size, 0);

  notice.start();
  notice.clear();
  assert.equal(timers.size, 0, "manual dismissal clears the timer");
  notice.resume();
  assert.equal(timers.size, 0, "a cleared notice cannot be resumed");
});

test("feedback uses one fixed live toast and leaves re-rendered lists out of live regions", async () => {
  const html = await readFile(new URL("../public/admin/index.html", import.meta.url), "utf8");
  const styles = await readFile(new URL("../public/admin/styles.css", import.meta.url), "utf8");
  const nodes = parseHTML(html);
  assert.equal(nodes.filter((node) => attribute(node, "data-feedback-slot") !== undefined).length, 0);
  const toast = byID(nodes, "feedback-toast");
  assert.ok(toast);
  assert.equal(attribute(toast, "role"), "status");
  assert.equal(attribute(toast, "aria-live"), "polite");
  assert.equal(attribute(toast, "aria-atomic"), "true");
  assert.ok(descendants(toast).some((node) => attribute(node, "data-dismiss-feedback") !== undefined));
  assert.ok(byID(nodes, "secret-panel"), "the one-time credential panel remains available");
  for (const id of ["capture-target-list", "api-dashboard-list", "playlists", "devices", "audit", "fleet-attention", "capture-efficiency-content"]) {
    assert.equal(attribute(byID(nodes, id), "aria-live"), undefined, `${id} does not re-announce a full list on refresh`);
  }
  const stylesheet = postcss.parse(styles);
  let fixedToast = false;
  stylesheet.walkRules(".feedback-toast", (rule) => {
    fixedToast ||= rule.nodes.some((node) => node.type === "decl" && node.prop === "position" && node.value === "fixed");
  });
  assert.ok(fixedToast, "the toast does not shift page layout");
  let reducedMotionDisablesToastAnimation = false;
  stylesheet.walkAtRules("media", (media) => {
    if (!/prefers-reduced-motion\s*:\s*reduce/.test(media.params)) return;
    media.walkRules(".feedback-toast", (rule) => {
      reducedMotionDisablesToastAnimation ||= rule.nodes.some((node) =>
        node.type === "decl" && node.prop === "animation" && node.value === "none");
    });
  });
  assert.ok(reducedMotionDisablesToastAnimation);
});

test("management page prioritizes task navigation and defers optional panels", async () => {
  const html = await readFile(new URL("../public/admin/index.html", import.meta.url), "utf8");
  const nodes = parseHTML(html);
  for (const sectionID of ["sites-section", "playlist-section", "device-section"]) {
    assert.ok(nodes.some((node) => node.tagName === "a" && attribute(node, "href") === `#${sectionID}`));
    assert.ok(byID(nodes, sectionID));
  }
  for (const id of ["playlist-editor"]) {
    const panel = byID(nodes, id);
    assert.equal(panel.tagName, "details", `${id} can be opened on demand`);
    assert.equal(attribute(panel, "open"), undefined, `${id} starts collapsed`);
    assert.ok(descendants(panel).some((node) => node.tagName === "summary"));
  }
  for (const [sectionID, editorID, listID] of [
    ["dashboards-section", "api-dashboard-editor", "api-dashboard-list"],
    ["playlist-section", "playlist-editor", "playlists"],
  ]) {
    const section = byID(nodes, sectionID);
    const editor = byID(nodes, editorID);
    assert.equal(editor.tagName, "details");
    assert.match(attribute(editor, "class"), /editor-disclosure/);
    assert.equal(descendants(editor).some((node) => node.tagName === "summary"), true);
    assert.ok(descendants(section).indexOf(editor) < descendants(section).indexOf(byID(nodes, listID)),
      `${editorID} appears before its managed records`);
    const heading = descendants(section).find((node) => node.tagName === "div" && attribute(node, "class")?.includes("section-heading"));
    assert.ok(!descendants(heading).some((node) => node.tagName === "a" || node.tagName === "button"),
      `${sectionID} avoids repeating the editor trigger in its heading`);
  }
  const sites = byID(nodes, "sites-section");
  const siteEditor = byID(nodes, "capture-site-dialog");
  assert.equal(siteEditor.tagName, "dialog");
  assert.equal(attribute(siteEditor, "aria-labelledby"), "capture-site-dialog-title");
  assert.ok(descendants(siteEditor).some((item) => attribute(item, "id") === "capture-site-form"));
  assert.ok(descendants(sites).indexOf(byID(nodes, "add-capture-site")) < descendants(sites).indexOf(byID(nodes, "capture-target-list")),
    "the add site button appears before its records");
  assert.ok(byID(nodes, "fleet-attention"));
});

test("management navigation has a present, unique accessible name", async () => {
  const html = await readFile(new URL("../public/admin/index.html", import.meta.url), "utf8");
  const nodes = parseHTML(html);
  const navs = nodes.filter((node) => node.tagName === "nav");
  const labels = navs.map((node) => attribute(node, "aria-label"));

  assert.equal(navs.length, 1, "the management shell exposes its primary navigation");
  assert.deepEqual(labels, ["Management navigation"]);
  assert.equal(new Set(labels).size, navs.length, "every navigation region has a distinct name");
  assert.equal(attribute(byID(nodes, "module-navigation-toggle"), "aria-controls"), attribute(navs[0], "id"));
});

test("capture efficiency introduction describes runtime forecasts instead of monetary cost", async () => {
  const html = await readFile(new URL("../public/admin/index.html", import.meta.url), "utf8");
  const section = parseHTML(html).find((node) => attribute(node, "id") === "capture-efficiency-section");
  const copy = descendants(section).map((node) => node.value ?? "").join(" ");
  assert.match(copy, /forecast runtime for current schedules/i);
  assert.doesNotMatch(copy, /estimated cost/i);
});

test("pending enrollment details start collapsed in a native disclosure", async () => {
  const html = await readFile(new URL("../public/admin/index.html", import.meta.url), "utf8");
  const nodes = parseHTML(html);
  const pending = byID(nodes, "pending-enrollments-details");
  assert.equal(pending.tagName, "details");
  assert.equal(attribute(pending, "open"), undefined);
  assert.ok(descendants(pending).some((node) => node.tagName === "summary"));
});

test("JEV answer descriptions keep advisory and recommendation wording readable", () => {
  assert.equal(formatJevAnswerLabel("duration_review"), "Duration Review");
  assert.match(describeJevAnswer("duration_review", { type: "choice" }, "review_overestimate"), /possible overestimation/);
  assert.match(describeJevAnswer("duration_review", { type: "choice" }, "review_underestimate"), /possible underestimation/);
  assert.match(describeJevAnswer("duration_review", { type: "choice" }, "insufficient_data"), /not enough measured timing evidence/);
  assert.match(describeJevAnswer("duration_review", { type: "choice" }, "keep_current"), /Keep the current accounting reserve/);
  assert.equal(describeJevAnswer("recommendation", { type: "choice", choice: "skip_once" }), "Recommendation: skip once");
  assert.equal(describeJevAnswer("risk", { type: "score", score: 2, legend: { "2": "Moderate" } }), "Risk: Moderate");
  assert.equal(describeJevAnswer("risk", { type: "score", score: 2, legend: {} }), null);
});

test("fleet insights explain prioritized current issues with evidence and next actions", () => {
  const items = buildFleetInsights({
    devices: [
      { device_id: "offline", enabled: 1, health: { status: "offline", received_at: 90 } },
      { device_id: "behind", enabled: 1, health: { status: "degraded", sync_status: "failed", applied_playlist_id: "ops", applied_revision: "old", received_at: 100 } },
      { enabled: 0, health: { status: "offline" } },
    ],
    active_playlist: { playlist_id: "ops", revision: "current" },
    asset_health: {
      missing: [{ sha256: "a" }, { sha256: "b" }],
      integrity_issues: [{ sha256: "a" }, { sha256: "c" }],
    },
    capture_targets: [
      { name: "Problem site", last_error: "failed", last_attempt_at: 110 },
      { last_error: "still running", job_status: "queued", last_attempt_at: 115 },
      { name: "Unreviewed site", last_error: null, schedule_reviewed: false },
    ],
    generated_at: 120,
  }, [{ request_id: "r1", created_at: 105 }]);

  assert.deepEqual(items.map(({ key, title, severity, action }) => ({ key, title, severity, action })), [
    { key: "devices", title: "2 devices need a health or sync review", severity: "action", action: { label: "Review devices", href: "#device-section" } },
    { key: "assets", title: "3 active playlist assets have issues", severity: "action", action: { label: "Review playlist assets", href: "#playlist-section" } },
    { key: "captures", title: "1 screenshot capture failed", severity: "action", action: { label: "Review capture sites", href: "#sites-section" } },
    { key: "schedules", title: "1 capture schedule needs review", severity: "review", action: { label: "Review schedules", href: "#sites-section" } },
    { key: "enrollments", title: "1 device is waiting for approval", severity: "review", action: { label: "Review approvals", href: "#pending-enrollments-title" } },
  ]);
  assert.match(items[0].evidence, /1 offline device/);
  assert.match(items[0].evidence, /1 degraded device/);
  assert.match(items[0].evidence, /1 sync failure/);
  assert.match(items[0].evidence, /1 device behind the active playlist/);
  assert.match(items[0].evidence, /Affected devices: offline, behind/);
  assert.match(items[1].evidence, /2 missing/);
  assert.match(items[1].evidence, /2 integrity issues/);
  assert.match(items[2].evidence, /Latest failed attempt at .*1970/);
  assert.match(items[2].evidence, /Problem site/);
  assert.equal(items[2].updatedAt, 110);
  assert.match(items[3].evidence, /1 schedule has not been reviewed before adding its site/);
  assert.match(items[3].evidence, /Unreviewed site/);
  assert.match(items[4].evidence, /Verify each device fingerprint/);
});

test("fleet insights detect a missing active playlist and stay clear for a healthy fleet", () => {
  const missing = buildFleetInsights({ devices: [{ device_id: "pi-1", enabled: 1, health: { status: "healthy" } }] }, []);
  assert.equal(missing[0].key, "playlist");
  assert.match(missing[0].evidence, /1 enabled device/);
  assert.equal(missing[0].action.href, "#playlist-section");

  const clear = buildFleetInsights({
    devices: [{ device_id: "pi-1", enabled: 1, health: { status: "healthy", sync_status: "ok", applied_playlist_id: "ops", applied_revision: "current" } }],
    active_playlist: { playlist_id: "ops", revision: "current" },
    asset_health: { missing: [], integrity_issues: [] },
    capture_targets: [{ last_error: null, schedule_reviewed: true }],
  }, []);
  assert.deepEqual(clear, []);
});

test("fleet insights do not flag devices behind when the active revision is missing", () => {
  const insights = buildFleetInsights({
    devices: [{
      device_id: "pi-1",
      enabled: 1,
      health: { status: "healthy", sync_status: "ok", applied_playlist_id: "ops", applied_revision: "current" },
    }],
    active_playlist: { playlist_id: "ops" },
  });

  assert.deepEqual(insights, []);
});

test("fleet findings and device review use the active effective playlist revision", () => {
  const device = {
    enabled: 1,
    health: {
      status: "healthy",
      sync_status: "ok",
      applied_playlist_id: "ops",
      applied_revision: "content-hash",
    },
  };
  const activePlaylist = { playlist_id: "ops", revision: "r-stored", effective_revision: "content-hash" };

  assert.equal(deviceNeedsReview(device, activePlaylist), false);
  assert.deepEqual(buildFleetInsights({ devices: [device], active_playlist: activePlaylist }), []);
});

test("reusable finding components render accessible evidence, actions and responsive card styles", async () => {
  const dom = new JSDOM();
  const ownerDocument = dom.window.document;
  try {
    const finding = {
      key: "devices",
      title: "Devices need a health or sync review",
      severity: "action",
      evidence: "1 offline · 1 sync failure · last report 4 minutes ago",
      updatedAt: 1_700_000_000_000,
      action: { label: "Review devices", href: "#device-section" },
    };
    const card = renderFindingCard(finding, { ownerDocument });
    assert.equal(card.tagName, "ARTICLE");
    assert.equal(card.ownerDocument, ownerDocument);
    assert.match(card.className, /finding-card--action/);
    assert.match(card.textContent, /1 offline/);
    assert.match(card.textContent, /Updated/);
    assert.equal(card.querySelector('a[href="#device-section"]').textContent, "Review devices");
    assert.equal(card.getAttribute("aria-labelledby"), "finding-card-devices-title");

    const list = renderFindingList([finding], { ownerDocument });
    assert.equal(list.getAttribute("role"), "list");
    assert.equal(list.ownerDocument, ownerDocument);
    assert.equal(list.querySelectorAll("article").length, 1);
    assert.equal(list.querySelector("article").ownerDocument, ownerDocument);
    const empty = renderFindingList([], { emptyMessage: "Nothing needs attention.", ownerDocument });
    assert.equal(empty.ownerDocument, ownerDocument);
    assert.equal(empty.textContent, "Nothing needs attention.");

    const styles = await readFile(new URL("../public/admin/styles.css", import.meta.url), "utf8");
    const stylesheet = postcss.parse(styles);
    let findingListUsesResponsiveGrid = false;
    stylesheet.walkRules(".finding-list", (rule) => {
      findingListUsesResponsiveGrid ||= rule.nodes.some((node) => node.type === "decl" && node.prop === "display" && node.value === "grid");
      findingListUsesResponsiveGrid ||= rule.nodes.some((node) => node.type === "decl" && node.prop === "grid-template-columns" && node.value.includes("auto-fit"));
    });
    assert.ok(findingListUsesResponsiveGrid, "the reusable finding list adapts to available width");
  } finally {
    dom.window.close();
  }
});

test("fleet insights live in the overview and no longer open in a modal", async () => {
  const html = await readFile(new URL("../public/admin/index.html", import.meta.url), "utf8");
  const nodes = parseHTML(html);
  const overview = byID(nodes, "overview-section");
  const findings = byID(nodes, "fleet-attention");
  assert.ok(overview && descendants(overview).includes(findings));
  assert.ok(byID(nodes, "fleet-insights"), "the fleet findings deep link remains available");
  assert.equal(byID(nodes, "analysis-dialog"), undefined);
  assert.equal(byID(nodes, "run-fleet-analysis"), undefined);
});

test("management records switch to cards on narrow screens", async () => {
  const html = await readFile(new URL("../public/admin/index.html", import.meta.url), "utf8");
  const styles = await readFile(new URL("../public/admin/styles.css", import.meta.url), "utf8");
  const nodes = parseHTML(html);
  for (const id of ["playlists", "devices", "audit"]) {
    const desktop = byID(nodes, id);
    const mobile = byID(nodes, `${id}-mobile`);
    assert.ok(desktop, `desktop ${id} view exists`);
    assert.ok(mobile, `mobile ${id} view exists`);
    const desktopClasses = new Set((attribute(desktop, "class") ?? "").split(/\s+/));
    const mobileClasses = new Set((attribute(mobile, "class") ?? "").split(/\s+/));
    assert.ok(desktopClasses.has("desktop-data"), `${id} has a desktop table view`);
    assert.ok(mobileClasses.has("mobile-card-list"), `${id} has a mobile card view`);
  }
  const stylesheet = postcss.parse(styles);
  const responsiveRules = [];
  stylesheet.walkAtRules("media", (rule) => {
    if (/max-width\s*:\s*53\.125rem/.test(rule.params)) responsiveRules.push(rule);
  });
  const declarationsFor = (selector) => {
    const declarations = [];
    for (const rule of responsiveRules) {
      rule.walkRules(selector, (matching) => matching.walkDecls((declaration) => declarations.push(declaration)));
    }
    return declarations;
  };
  assert.ok(declarationsFor(".desktop-data").some((declaration) => declaration.prop === "display" && declaration.value === "none"));
  assert.ok(declarationsFor(".mobile-card-list").some((declaration) => declaration.prop === "display" && declaration.value === "grid"));
});

test("approval confirmation asks operators to compare the full device fingerprint", () => {
  assert.equal(formatEnrollmentApprovalPrompt({
    device_id: "pi-1",
    fingerprint: "abcd-1234",
    replaces_existing: true,
  }), "Only approve pi-1 if its physical display shows the full fingerprint abcd-1234. This will replace the existing credentials for pi-1.");
  assert.equal(formatEnrollmentApprovalPrompt({
    device_id: "pi-2",
    fingerprint: "efgh-5678",
    replaces_existing: false,
  }), "Only approve pi-2 if its physical display shows the full fingerprint efgh-5678.");
});

test("device health details present reported state, output faults, history, and host readings", () => {
  const details = formatDeviceHealthDetails({
    health_status: "degraded",
    received_at: 0,
    latest: {
      agent_version: "1.2.3",
      agent_uptime_seconds: 125,
      startup_error_code: "display_failed",
      sync: {
        status: "ok",
        last_success_age_seconds: 30,
        applied_playlist_id: "operations",
        applied_revision: "r-1",
      },
      outputs: [{
        display_id: "main",
        connector: "HDMI-A-1",
        status: "failed",
        last_frame_age_seconds: null,
        error_code: "connector_disconnected",
      }],
      host: { uptime_seconds: 3600, temperature_millicelsius: 39166, memory_available_bytes: 1048576 },
    },
  }, {
    events: [{
      received_at: 1000,
      event_type: "device.health_changed",
      metadata: { previous_health_status: "healthy", health_status: "degraded" },
      error_code: "connector_disconnected",
    }],
    samples: [{}, {}],
  });

  assert.deepEqual(details.summary, [
    "Fleet health degraded.",
    `Last report ${formatTimestamp(0)} · Agent 1.2.3 · Uptime 2m`,
    "Sync ok · last success 30s ago · operations / r-1",
    "Startup issue: display_failed",
  ]);
  assert.deepEqual(details.outputs, [
    "main (HDMI-A-1): failed · no successful frame yet · connector_disconnected",
  ]);
  assert.deepEqual(details.host, [
    "Host uptime 1h 0m",
    "Temperature 39.2°C",
    "Memory 1.0 MB available",
  ]);
  assert.deepEqual(details.events, [
    `${formatTimestamp(1000)} · device.health_changed · degraded (healthy → degraded) · connector_disconnected`,
  ]);
  assert.equal(details.sampleCount, 2);
});

test("device health details explain when no report or history is available", () => {
  assert.deepEqual(formatDeviceHealthDetails({ latest: null }, {}), {
    message: "This device has not reported health yet.",
  });
  const details = formatDeviceHealthDetails({
    health_status: "healthy",
    received_at: 0,
    latest: {
      agent_version: "1",
      agent_uptime_seconds: 0,
      sync: { status: "ok", last_success_age_seconds: null },
      outputs: [],
    },
  });
  assert.match(details.summary[2], /last success never$/);
  assert.deepEqual(details.events, []);
  assert.equal(details.sampleCount, 0);
});

test("device health details tolerate missing sync data in stored reports", () => {
  const latest = {
    agent_version: "1",
    agent_uptime_seconds: 0,
    outputs: [],
  };
  const missingSync = formatDeviceHealthDetails({
    health_status: "starting",
    received_at: 0,
    latest,
  });
  assert.equal(missingSync.summary[2], "Sync unknown · last success never");

  const missingAge = formatDeviceHealthDetails({
    health_status: "healthy",
    received_at: 0,
    latest: { ...latest, sync: { status: "ok" } },
  });
  assert.equal(missingAge.summary[2], "Sync ok · last success never");
});

test("health details loading can retry failures and caches the first success", async () => {
  const loader = createRetryableLoadOnce();
  let calls = 0;

  await assert.rejects(loader.load(async () => {
    calls += 1;
    throw new Error("temporary request failure");
  }), /temporary request failure/);
  assert.equal(loader.loaded, false);

  const value = await loader.load(async () => {
    calls += 1;
    return { report: "health" };
  });
  assert.deepEqual(value, { report: "health" });
  assert.equal(loader.loaded, true);

  const cached = await loader.load(async () => {
    calls += 1;
    return { report: "new health" };
  });
  assert.equal(cached, undefined);
  assert.equal(calls, 2);
});

test("concurrent health detail opens share one request", async () => {
  const loader = createRetryableLoadOnce();
  let calls = 0;
  let resolveRequest;
  const request = new Promise((resolve) => { resolveRequest = resolve; });
  const first = loader.load(() => { calls += 1; return request; });
  const second = loader.load(() => { calls += 1; return request; });
  resolveRequest("health");
  assert.deepEqual(await Promise.all([first, second]), ["health", "health"]);
  assert.equal(calls, 1);
});

test("audit timestamps are explicit UTC and preserve the Unix epoch", () => {
  assert.equal(formatTimestamp(null), "Never seen");
  assert.match(formatTimestamp(0, "en-GB"), /^1 Jan 1970, 00:00:00 UTC$/);
  assert.equal(
    formatAuditDetails({ expires_at: "2026-10-27T21:00:00.000Z" }, "en-GB")[0].value,
    "27 Oct 2026, 21:00:00 UTC",
  );
});

test("device enabled messages report the state just applied", () => {
  assert.equal(formatDeviceEnabledMessage("pi-1", true), "Device pi-1 is now enabled.");
  assert.equal(formatDeviceEnabledMessage("pi-1", false), "Device pi-1 is now disabled.");
});

test("audit events and metadata are presented as readable labels", () => {
  assert.equal(formatAuditEventType("playlist.revision_created"), "Created playlist version");
  assert.equal(formatAuditEventType("playlist.deleted"), "Deleted playlist");
  assert.equal(formatAuditEventType("device.credential_rotated"), "Rotated device token");
  assert.equal(formatAuditEventType("capture.skip_once_confirmed"), "Confirmed one screenshot skip");
  assert.equal(formatAuditEventType("capture.skip_once_applied"), "Skipped one scheduled screenshot");
  assert.equal(formatAuditEventType("capture.interval_updated"), "Updated screenshot interval");
  assert.equal(formatAuditEventType("capture.schedule_reviewed"), "Reviewed screenshot schedule");
  assert.equal(formatAuditEventType("capture.site_created"), "Added capture site");
  assert.equal(formatAuditEventType("capture.site_removed"), "Removed capture site");
  assert.equal(formatAuditEventType("capture.site_restored"), "Restored capture site");
  assert.equal(formatAuditEventType("device.deleted"), "Deleted device");
  assert.equal(formatAuditEventType("development.bootstrap"), "Created initial playlist");
  assert.equal(formatAuditEventType("device.disabled"), "Disabled device");
  assert.deepEqual(formatAuditDetails({
    asset_count: 2,
    previous: { playlist_id: "default", revision: "r-old" },
  }), [
    { label: "Image count", value: "2" },
    { label: "Previous", value: "Playlist ID: default; Version: r-old" },
  ]);
});

test("management environment copy shows attention on development and stays quiet for verified production", () => {
  const production = formatEnvironmentNotice("production");
  assert.equal(production.production, true);
  assert.equal(production.detail, "");

  const development = formatEnvironmentNotice("development");
  assert.equal(development.production, false);
  assert.match(development.detail, /sign-in is not configured/i);
});

test("audit actors use a consistent readable fallback", () => {
  assert.equal(formatActorLabel("anonymous"), "Unauthenticated");
  assert.equal(formatActorLabel("operator-7"), "operator-7");
  assert.equal(formatActorLabel(null), "Unknown");
});

test("consequential actions only run after explicit confirmation", async () => {
  let actions = 0;
  const declined = await confirmBeforeAction(() => Promise.resolve(false), "Disable device?", async () => {
    actions += 1;
  });
  assert.equal(declined, false);
  assert.equal(actions, 0);

  const accepted = await confirmBeforeAction(() => true, "Disable device?", async () => {
    actions += 1;
  });
  assert.equal(accepted, true);
  assert.equal(actions, 1);
});

test("confirmed actions return the token result and do not execute when declined", async () => {
  let actions = 0;
  const declined = await confirmAction(() => false, "Rotate token?", () => {
    actions += 1;
    return { device_token: "unused" };
  });
  assert.deepEqual(declined, { confirmed: false, result: undefined });
  assert.equal(actions, 0);

  const accepted = await confirmAction(() => true, "Rotate token?", async () => {
    actions += 1;
    return { device_token: "new-token" };
  });
  assert.deepEqual(accepted, { confirmed: true, result: { device_token: "new-token" } });
  assert.equal(actions, 1);
});

test("playlist state, screenshot status, and screenshot intervals use consistent labels", () => {
  assert.equal(formatPlaylistState(true), "Active");
  assert.equal(formatPlaylistState(false), "Ready to activate");
  assert.deepEqual(formatScreenshotStatus("running", null, null), { label: "Screenshot in progress", tone: "warning" });
  assert.deepEqual(formatScreenshotStatus("queued", null, null), { label: "Screenshot queued", tone: "warning" });
  assert.deepEqual(formatScreenshotStatus("idle", "Timed out", null), { label: "Needs attention", tone: "warning" });
  assert.deepEqual(formatScreenshotStatus("idle", null, 1), { label: "Screenshot ready", tone: "success" });
  assert.deepEqual(formatScreenshotStatus("idle", null, null), { label: "Waiting for first screenshot", tone: "neutral" });
  assert.equal(formatCaptureInterval(60), "Every minute");
  assert.equal(formatCaptureInterval(300), "Every 5 minutes");
  assert.equal(formatCaptureInterval(90), "Every 90 seconds");
});

test("playlist delete action is visible once per group and explains the active-playlist guard", () => {
  const playlists = [
    { playlist_id: "BBC", revision: "r-active", created_at: 20, revision_count: 3, active: true },
    { playlist_id: "BBC", revision: "r-latest-inactive", created_at: 30, revision_count: 3, active: false },
    { playlist_id: "BBC", revision: "r-old", created_at: 10, revision_count: 3, active: false },
    { playlist_id: "ops", revision: "r-ops", created_at: 40, revision_count: 1, active: false },
  ];
  const states = playlistDeleteActionStates(playlists);

  assert.deepEqual(states.map(({ visible, disabled, versionCount, hint }) => ({
    visible, disabled, versionCount, hint,
  })), [
    {
      visible: false,
      disabled: true,
      versionCount: 3,
      hint: "Activate another playlist first. Deleting removes all 3 saved versions.",
    },
    {
      visible: true,
      disabled: true,
      versionCount: 3,
      hint: "Activate another playlist first. Deleting removes all 3 saved versions.",
    },
    {
      visible: false,
      disabled: true,
      versionCount: 3,
      hint: "Activate another playlist first. Deleting removes all 3 saved versions.",
    },
    {
      visible: true,
      disabled: false,
      versionCount: 1,
      hint: "Deleting removes all 1 saved version.",
    },
  ]);

  const afterActivatingAnotherPlaylist = playlists.map((playlist) => ({
    ...playlist,
    active: playlist.playlist_id === "ops",
  }));
  const afterSwitchStates = playlistDeleteActionStates(afterActivatingAnotherPlaylist);
  assert.equal(afterSwitchStates[1].visible, true);
  assert.equal(afterSwitchStates[1].disabled, false);
  assert.equal(afterSwitchStates[1].hint, "Deleting removes all 3 saved versions.");
});

test('management UI does not display model confidence or probability percentages', async () => {
  const html = await readFile(new URL('../public/admin/index.html', import.meta.url), 'utf8');
  const script = await readFile(new URL('../public/admin/app.ts', import.meta.url), 'utf8');
  const visible = parseHTML(html).filter((item) => item.nodeName === '#text').map((item) => item.value).join(' ');
  assert.doesNotMatch(visible, /\bJEV\b/i);
  assert.doesNotMatch(visible, /confidence|probability/i);
  assert.doesNotMatch(script, /answer\.probabilities|answer\.confidence|result\.model|result\.usage/);
});

test("management shell provides grouped persistent navigation and an on-demand site form", async () => {
  const html = await readFile(new URL("../public/admin/index.html", import.meta.url), "utf8");
  const styles = await readFile(new URL("../public/admin/styles.css", import.meta.url), "utf8");
  const nodes = parseHTML(html);
  const shell = byID(nodes, "management-shell");
  assert.ok(shell, "the console content uses a shared application shell");
  const nav = byID(nodes, "module-navigation");
  assert.ok(nav);
  assert.equal(attribute(nav, "aria-label"), "Management navigation");
  assert.equal(attribute(nav, "class")?.includes("management-sidebar"), true);
  assert.equal(attribute(nav, "id"), attribute(byID(nodes, "module-navigation-toggle"), "aria-controls"));
  assert.equal(attribute(byID(nodes, "module-navigation-toggle"), "aria-expanded"), "true");
  assert.equal(attribute(byID(nodes, "module-navigation-toggle"), "hidden"), "");
  const links = descendants(nav).filter((item) => item.tagName === "a");
  for (const id of ["overview-section", "sites-section", "capture-efficiency-section", "playlist-section", "device-section", "activity-section"]) {
    assert.ok(links.some((link) => attribute(link, "href") === `#${id}`), `${id} is reachable`);
  }
  assert.equal(links.some((link) => attribute(link, "href") === "#fleet-insights"), false);
  assert.deepEqual(descendants(nav).filter((item) => item.tagName === "h2").map((item) => item.childNodes[0]?.value),
    ["Overview", "Capture", "Fleet"]);
  assert.equal(byID(nodes, "dashboard-tiles"), undefined);
  assert.ok(links.some((link) => attribute(link, "href") === "#capture-efficiency-section"), "capture efficiency has a sidebar destination");
  assert.equal(attribute(byID(nodes, "capture-efficiency-section"), "aria-labelledby"), "capture-efficiency-title");
  const siteEditor = byID(nodes, "capture-site-dialog");
  assert.equal(siteEditor.tagName, "dialog");
  assert.ok(descendants(siteEditor).some((item) => attribute(item, "id") === "capture-site-form"));
  const stylesheet = postcss.parse(styles);
  let desktopShell = false;
  let narrowShell = false;
  stylesheet.walkRules(".management-shell", (rule) => {
    desktopShell ||= rule.nodes.some((node) => node.type === "decl" && node.prop === "display" && node.value === "grid");
  });
  stylesheet.walkAtRules("media", (media) => {
    if (!/max-width:\s*56rem/.test(media.params)) return;
    media.walkRules(".management-shell", (rule) => {
      narrowShell ||= rule.nodes.some((node) => node.type === "decl" && node.prop === "grid-template-columns");
    });
  });
  assert.equal(desktopShell, true);
  assert.equal(narrowShell, true);
});

test("configuration forms separate dashboard details, sources, and playlist content into named groups", async () => {
  const html = await readFile(new URL("../public/admin/index.html", import.meta.url), "utf8");
  const nodes = parseHTML(html);
  for (const [formID, legend] of [
    ["api-dashboard-form", "Dashboard details"],
    ["playlist-form", "Playlist settings"],
  ]) {
    const form = byID(nodes, formID);
    assert.ok(descendants(form).some((item) => item.tagName === "legend" && item.childNodes[0]?.value === legend));
  }
  assert.ok(descendants(byID(nodes, "api-dashboard-form")).some((item) =>
    item.tagName === "details" && attribute(item, "id") === "api-dashboard-advanced-json"));
  assert.ok(descendants(byID(nodes, "playlist-form")).some((item) =>
    item.tagName === "fieldset" && attribute(item, "id") === "available-sites"));
});

test("capture sites and API dashboards are separate sidebar modules", async () => {
  const html = await readFile(new URL("../public/admin/index.html", import.meta.url), "utf8");
  const nodes = parseHTML(html);
  const nav = descendants(byID(nodes, "module-navigation"));
  assert.ok(nav.some((item) => item.tagName === "a" && attribute(item, "href") === "#dashboards-section"));
  assert.equal(byID(nodes, "dashboard-tiles"), undefined);
  assert.ok(byID(nodes, "dashboards-section"));
  assert.equal(byID(nodes, "api-dashboard-form").parentNode?.parentNode?.parentNode?.attrs?.some((item) => item.name === "id" && item.value === "sites-section"), false);
  assert.ok(descendants(byID(nodes, "dashboards-section")).some((item) => attribute(item, "id") === "api-dashboard-form"));
  assert.ok(descendants(byID(nodes, "sites-section")).some((item) => attribute(item, "id") === "capture-site-form"));
  assert.equal(descendants(byID(nodes, "sites-section")).some((item) => attribute(item, "id") === "api-dashboard-list"), false);
});

test("capture site management uses one edit dialog, labelled filter chips and an optional list view", async () => {
  const html = await readFile(new URL("../public/admin/index.html", import.meta.url), "utf8");
  const nodes = parseHTML(html);
  const sites = byID(nodes, "sites-section");
  assert.equal(byID(nodes, "capture-site-editor"), undefined);
  assert.equal(attribute(byID(nodes, "add-capture-site"), "type"), "button");

  const dialog = byID(nodes, "capture-site-dialog");
  assert.equal(dialog.tagName, "dialog");
  assert.equal(attribute(dialog, "aria-labelledby"), "capture-site-dialog-title");
  assert.ok(descendants(dialog).some((item) => attribute(item, "id") === "capture-site-form"));
  const editForm = byID(nodes, "capture-site-edit-form");
  assert.equal(attribute(editForm, "hidden"), "");
  assert.ok(descendants(editForm).some((item) => attribute(item, "name") === "name"));
  assert.ok(descendants(editForm).some((item) => attribute(item, "name") === "capture_interval_seconds"));
  assert.ok(descendants(editForm).some((item) => attribute(item, "name") === "wait_for_selector"));
  assert.equal(descendants(editForm).filter((item) => attribute(item, "type") === "submit").length, 1);
  assert.equal(descendants(editForm).filter((item) => item.tagName === "details").length, 0);
  assert.match(byID(nodes, "capture-site-shared-schedule-note").childNodes[0]?.value ?? "", /shared by playlists using the same site and screenshot size/i);

  const filterGroup = byID(nodes, "capture-site-filters");
  assert.equal(attribute(filterGroup, "role"), "group");
  assert.equal(attribute(filterGroup, "aria-label"), "Filter screenshot sites");
  assert.deepEqual(descendants(filterGroup).filter((item) => item.tagName === "button").map((item) => attribute(item, "data-capture-filter")), ["all", "attention", "ready"]);
  const viewGroup = byID(nodes, "capture-site-view-toggle");
  assert.equal(attribute(viewGroup, "role"), "group");
  assert.equal(attribute(viewGroup, "hidden"), "");
  assert.deepEqual(descendants(viewGroup).filter((item) => item.tagName === "button").map((item) => attribute(item, "data-capture-view")), ["cards", "list"]);
  assert.ok(descendants(sites).some((item) => attribute(item, "id") === "capture-target-list"));
});

test("API dashboard configuration defaults to structured source controls with optional JSON", async () => {
  const html = await readFile(new URL("../public/admin/index.html", import.meta.url), "utf8");
  const nodes = parseHTML(html);
  const form = byID(nodes, "api-dashboard-form");
  assert.ok(descendants(form).some((item) => attribute(item, "id") === "api-dashboard-source-list"));
  const advanced = byID(nodes, "api-dashboard-advanced-json");
  assert.equal(attribute(advanced, "open"), undefined);
  assert.ok(descendants(advanced).some((item) => item.tagName === "textarea" && attribute(item, "name") === "sources-json"));
});

test("fleet findings retain a direct deep link without a duplicate sidebar item", async () => {
  const html = await readFile(new URL("../public/admin/index.html", import.meta.url), "utf8");
  const nodes = parseHTML(html);
  assert.ok(byID(nodes, "fleet-insights"), "the existing fleet findings anchor remains available");
  const nav = descendants(byID(nodes, "module-navigation"));
  assert.equal(nav.filter((item) => item.tagName === "a" && attribute(item, "href") === "#overview-section").length, 1);
  assert.equal(nav.some((item) => item.tagName === "a" && attribute(item, "href") === "#fleet-insights"), false);
});

test("fleet landing page puts findings first, replaces module tiles, and keeps one overview destination", async () => {
  const html = await readFile(new URL("../public/admin/index.html", import.meta.url), "utf8");
  const nodes = parseHTML(html);
  const header = descendants(byID(nodes, "management-shell")).find((item) => item.tagName === "header");
  const heading = descendants(header).find((item) => item.tagName === "h1");
  assert.equal(descendants(heading).some((item) => attribute(item, "id") === "brand-lockup"), true);
  assert.equal(descendants(heading).find((item) => attribute(item, "class")?.split(/\s+/).includes("brand-lockup__name"))?.childNodes[0]?.value, "Ribbonfish");
  assert.equal(byID(nodes, "dashboard-tiles"), undefined);

  const overviewSection = byID(nodes, "overview-section");
  const findingsIndex = descendants(overviewSection).findIndex((item) => attribute(item, "id") === "fleet-insights");
  const metricsIndex = descendants(overviewSection).findIndex((item) => attribute(item, "id") === "fleet-summary");
  assert.ok(findingsIndex >= 0 && metricsIndex > findingsIndex, "findings come before the live metrics");
  assert.equal(byID(nodes, "overview-title")?.childNodes[0]?.value, "Fleet overview");

  const links = descendants(byID(nodes, "module-navigation")).filter((item) => item.tagName === "a");
  assert.equal(links.filter((link) => attribute(link, "href") === "#overview-section").length, 1);
  assert.equal(links.some((link) => attribute(link, "href") === "#fleet-insights"), false);
  assert.equal(links.some((link) => attribute(link, "href") === "#dashboard"), false);
  assert.ok(byID(nodes, "fleet-insights"), "the existing findings deep link remains available");
  for (const sectionID of ["overview-section", "sites-section", "dashboards-section", "capture-efficiency-section", "playlist-section", "device-section", "activity-section"]) {
    const section = byID(nodes, sectionID);
    const heading = descendants(section).find((item) => attribute(item, "class")?.includes("section-heading"));
    assert.equal(descendants(heading).some((item) => attribute(item, "class")?.split(/\s+/).includes("eyebrow")), false,
      `${sectionID} uses its heading as the only page title`);
  }
});

test("environment status lives in the header and production has no success notice", async () => {
  const html = await readFile(new URL("../public/admin/index.html", import.meta.url), "utf8");
  const nodes = parseHTML(html);
  const header = descendants(byID(nodes, "management-shell")).find((item) => item.tagName === "header");
  assert.ok(descendants(header).some((item) => attribute(item, "id") === "environment-tag"));
  const notice = descendants(header).find((item) => attribute(item, "id") === "environment-notice");
  assert.ok(notice);
  assert.equal(attribute(notice, "role"), "alert");
  assert.equal(attribute(notice, "hidden"), "");
  assert.equal(byID(nodes, "main-content")?.childNodes.some((item) => attribute(item, "id") === "environment-notice"), false);
});


test("capture issues are grouped and surfaced before healthy sites without changing input", () => {
  const targets = [
    { display_url: "healthy", last_success_at: 1 },
    { display_url: "first", last_error: "Budget reached", schedule_reviewed: true },
    { display_url: "second", last_error: "Budget reached", schedule_reviewed: true },
    { display_url: "review", schedule_reviewed: false },
  ];
  const originalTargets = targets.map((target) => ({ ...target }));
  assert.deepEqual(prioritizeCaptureTargets(targets).map((item) => item.display_url), ["first", "second", "review", "healthy"]);
  assert.deepEqual(summarizeCaptureErrors(targets), [{ message: "Budget reached", count: 2 }]);
  assert.deepEqual(targets, originalTargets);
});

test("Browser Run forecast component exposes actual usage, quota markers, and per-site estimates", () => {
  const dom = new JSDOM("<section id='forecast'></section>");
  const forecast = dom.window.document.querySelector("#forecast");
  const targets = [{
    capture_id: "hourly",
    display_label: "Hourly site",
    capture_interval_seconds: 3600,
    active_in_playlist: true,
    schedule_reviewed: true,
    average_browser_ms: 2000,
    browser_ms_samples: 4,
  }];
  const dailyUsage = { accounted_ms: 12_000, budget_ms: 540_000, free_plan_limit_ms: 600_000 };

  renderCaptureUsageForecast(forecast, targets, dailyUsage);

  assert.equal(forecast.querySelector("figure")?.getAttribute("aria-label"), "Daily Browser Run usage forecast");
  assert.match(forecast.querySelector("[data-testid='forecast-total']")?.textContent ?? "", /48s/);
  assert.match(forecast.textContent, /0m 12s of 10m 0s/);
  assert.match(forecast.querySelector(".browser-usage-budget-note")?.textContent ?? "", /forecast to stay within the.*daily budget/i);
  assert.ok(forecast.querySelector("[data-capture-id='hourly']"), "the forecast chart still segments usage by site");
  assert.match(forecast.textContent, /Cloudflare account-wide allowance/);
  assert.ok(forecast.querySelector("[data-quota-marker='free-plan']"));
  assert.ok(forecast.querySelector("[data-quota-marker='worker-budget']"));

  renderCaptureUsageForecast(forecast, targets, dailyUsage, new Map([["hourly", 21_600]]));
  assert.match(forecast.querySelector("[data-testid='forecast-total']")?.textContent ?? "", /8s/);
});

test("used-today meter scales from the larger limit plus 10 percent, independently of the forecast", () => {
  const dom = new JSDOM("<section id='forecast'></section>");
  const container = dom.window.document.querySelector("#forecast");
  const targets = [{
    capture_id: "long-running",
    display_label: "Long running site",
    capture_interval_seconds: 3600,
    active_in_playlist: true,
    schedule_reviewed: true,
    average_browser_ms: 394_625,
    browser_ms_samples: 1,
  }];
  const used = { accounted_ms: 600_000, budget_ms: 540_000, free_plan_limit_ms: 600_000 };
  const fillPercent = (meter) => parseFloat(meter.querySelector(".scale-meter__fill").style.width);
  const markerPercent = (meter, name) => parseFloat(meter.querySelector(`[data-quota-marker='${name}']`).style.left);

  renderCaptureUsageForecast(container, targets, used);

  const meters = [...container.querySelectorAll(".scale-meter")];
  const usedMeter = meters[0];
  const forecastMeter = meters[1];
  assert.match(usedMeter.getAttribute("aria-label"), /Scale from 0 to 11m 0s/);
  assert.ok(Math.abs(fillPercent(usedMeter) - (600_000 / 660_000 * 100)) < 0.001);
  assert.ok(Math.abs(markerPercent(usedMeter, "worker-budget") - (540_000 / 660_000 * 100)) < 0.001);
  assert.ok(Math.abs(markerPercent(usedMeter, "free-plan") - (600_000 / 660_000 * 100)) < 0.001);
  assert.match(usedMeter.nextElementSibling.textContent, /Scale: 11m 0s/);
  assert.match(forecastMeter.getAttribute("aria-label"), /Scale from 0 to 157m 51s/);
  assert.match(forecastMeter.nextElementSibling.textContent, /Scale: 157m 51s/);

  used.budget_ms = 720_000;
  used.accounted_ms = 720_000;
  renderCaptureUsageForecast(container, targets, used);

  const largerBudgetMeter = container.querySelector(".scale-meter");
  assert.match(largerBudgetMeter.getAttribute("aria-label"), /Scale from 0 to 13m 12s/);
  assert.ok(Math.abs(fillPercent(largerBudgetMeter) - (720_000 / 792_000 * 100)) < 0.001);
  assert.ok(Math.abs(markerPercent(largerBudgetMeter, "worker-budget") - (720_000 / 792_000 * 100)) < 0.001);
  assert.ok(Math.abs(markerPercent(largerBudgetMeter, "free-plan") - (600_000 / 792_000 * 100)) < 0.001);
  assert.match(largerBudgetMeter.nextElementSibling.textContent, /Scale: 13m 12s/);
});

test("Browser Run forecast component requests a sample before inventing a runtime", () => {
  const dom = new JSDOM("<section id='forecast'></section>");
  const forecast = dom.window.document.querySelector("#forecast");
  renderCaptureUsageForecast(forecast, [{
    capture_id: "new",
    display_label: "New site",
    capture_interval_seconds: 86400,
    active_in_playlist: true,
    schedule_reviewed: true,
    average_browser_ms: null,
    browser_ms_samples: 0,
  }], { accounted_ms: 0, budget_ms: 600_000, free_plan_limit_ms: 600_000 });

  assert.match(forecast.textContent, /Forecasts need a runtime sample from an active capture/);
  assert.match(forecast.querySelector(".browser-usage-budget-note")?.textContent ?? "", /incomplete.*cannot confirm whether it will stay within/i);
  assert.match(forecast.textContent, /New site/);
});

test("Browser Run forecast calls out when current schedules exceed the daily budget", () => {
  const dom = new JSDOM("<section id='forecast'></section>");
  const forecast = dom.window.document.querySelector("#forecast");
  renderCaptureUsageForecast(forecast, [{
    capture_id: "long-running",
    display_label: "Long-running site",
    capture_interval_seconds: 3600,
    active_in_playlist: true,
    schedule_reviewed: true,
    average_browser_ms: 1_000_000,
    browser_ms_samples: 10,
  }], { accounted_ms: 0, budget_ms: 600_000, free_plan_limit_ms: 600_000 });

  assert.match(forecast.querySelector(".browser-usage-budget-note")?.textContent ?? "", /forecast to exceed.*daily budget/i);
});

test("Browser Run forecast explains when no reviewed sites are active without repeating the missing-sample message", () => {
  const dom = new JSDOM("<section id='forecast'></section>");
  const forecast = dom.window.document.querySelector("#forecast");
  renderCaptureUsageForecast(forecast, [], { accounted_ms: 0, budget_ms: 600_000, free_plan_limit_ms: 600_000 });

  assert.match(forecast.querySelector(".browser-usage-budget-note")?.textContent ?? "", /no reviewed screenshot sites are active/i);
  assert.equal(forecast.querySelectorAll(".browser-usage-forecast__note").length, 1,
    "only the account-wide allowance note remains when there are no active sites");
  assert.match(forecast.querySelectorAll(".scale-meter__label")[1].textContent, /No reviewed active sites/);
});
