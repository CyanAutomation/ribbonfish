import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse } from "parse5";
import postcss from "postcss";
import {
  createFleetOpenUI,
  OPENUI_STARTER_SOURCE,
} from "../public/admin/openui-core.js";
import {
  confirmAction,
  confirmBeforeAction,
  createTransientNotice,
  formatAuditDetails,
  formatAuditEventType,
  formatActorLabel,
  compactIdentifier,
  createRetryableLoadOnce,
  formatCaptureInterval,
  formatDeviceEnabledMessage,
  formatDeviceHealthDetails,
  formatEnrollmentApprovalPrompt,
  formatEnvironmentNotice,
  formatPlaylistState,
  playlistDeleteActionStates,
  formatScreenshotStatus,
  formatTimestamp,
  summarizeFleetAttention,
  hasPageURLs,
  parsePageURLs,
} from "../public/admin/ui-utils.js";

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
    ["fleet-summary", "Fleet snapshot"],
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

test("feedback locations have contextual announcements and dismissal controls", async () => {
  const html = await readFile(new URL("../public/admin/index.html", import.meta.url), "utf8");
  const styles = await readFile(new URL("../public/admin/styles.css", import.meta.url), "utf8");
  const nodes = parseHTML(html);
  for (const name of ["global", "overview", "playlist", "device", "activity", "credential"]) {
    const slot = nodes.find((node) => attribute(node, "data-feedback-slot") === name);
    assert.ok(slot, `feedback for ${name} has a dedicated location`);
    assert.equal(attribute(slot, "role"), "status");
    assert.equal(attribute(slot, "aria-live"), "polite");
    assert.ok(descendants(slot).some((node) => attribute(node, "data-dismiss-feedback") !== undefined));
  }
  const stylesheet = postcss.parse(styles);
  const bannerRules = [];
  stylesheet.walkRules(".status-banner", (rule) => bannerRules.push(rule));
  assert.ok(bannerRules.some((rule) => rule.nodes.some((node) =>
    node.type === "decl" && node.prop === "display" && node.value === "flex")));
  assert.ok(bannerRules.every((rule) => !rule.nodes.some((node) =>
    node.type === "decl" && node.prop === "position" && ["fixed", "absolute"].includes(node.value))));
  let reducedMotionDisablesBannerAnimation = false;
  stylesheet.walkAtRules("media", (media) => {
    if (!/prefers-reduced-motion\s*:\s*reduce/.test(media.params)) return;
    media.walkRules(".status-banner", (rule) => {
      reducedMotionDisablesBannerAnimation ||= rule.nodes.some((node) =>
        node.type === "decl" && node.prop === "animation" && node.value === "none");
    });
  });
  assert.ok(reducedMotionDisablesBannerAnimation);
});

test("management page prioritizes task navigation and defers optional panels", async () => {
  const html = await readFile(new URL("../public/admin/index.html", import.meta.url), "utf8");
  const nodes = parseHTML(html);
  for (const sectionID of ["playlist-section", "device-section"]) {
    assert.ok(nodes.some((node) => node.tagName === "a" && attribute(node, "href") === `#${sectionID}`));
    assert.ok(byID(nodes, sectionID));
  }
  for (const id of ["analysis-section", "playlist-editor"]) {
    const panel = byID(nodes, id);
    assert.equal(panel.tagName, "details", `${id} can be opened on demand`);
    assert.equal(attribute(panel, "open"), undefined, `${id} starts collapsed`);
    assert.ok(descendants(panel).some((node) => node.tagName === "summary"));
  }
  assert.ok(byID(nodes, "fleet-attention"));
});

test("pending enrollment details start collapsed in a native disclosure", async () => {
  const html = await readFile(new URL("../public/admin/index.html", import.meta.url), "utf8");
  const nodes = parseHTML(html);
  const pending = byID(nodes, "pending-enrollments-details");
  assert.equal(pending.tagName, "details");
  assert.equal(attribute(pending, "open"), undefined);
  assert.ok(descendants(pending).some((node) => node.tagName === "summary"));
});

test("fleet attention shows only actionable health and content issues", () => {
  const items = summarizeFleetAttention({
    devices: [
      { enabled: 1, health: { status: "healthy" } },
      { enabled: 1, health: { status: "offline" } },
      { enabled: 1, health: { status: "unknown" } },
      { enabled: 0, health: { status: "offline" } },
    ],
    asset_health: {
      missing: [{ sha256: "a" }, { sha256: "b" }],
      integrity_issues: [{ sha256: "a" }, { sha256: "c" }],
    },
    capture_targets: [
      { last_error: "failed" },
      { last_error: null, job_status: "queued" },
      { last_error: "old failure", job_status: "queued" },
      { last_error: null },
    ],
  }, [{ request_id: "r1" }]);

  assert.deepEqual(items, [
    { key: "enrollments", count: 1, singular: "device awaiting approval", plural: "devices awaiting approval", href: "#pending-enrollments-title" },
    { key: "devices", count: 2, singular: "device needing health review", plural: "devices needing health review", href: "#device-section" },
    { key: "assets", count: 3, singular: "image availability issue", plural: "image availability issues", href: "#asset-health" },
    { key: "captures", count: 1, singular: "screenshot needing attention", plural: "screenshots needing attention", href: "#capture-targets" },
  ]);
  assert.deepEqual(summarizeFleetAttention({ devices: [], asset_health: { missing: [] }, capture_targets: [] }, []), []);
});

test("fleet analysis is an optional advisory action that does not change fleet state", async () => {
  const html = await readFile(new URL("../public/admin/index.html", import.meta.url), "utf8");
  const nodes = parseHTML(html);
  const analysis = byID(nodes, "analysis-section");
  assert.equal(analysis.tagName, "details");
  assert.ok(nodes.some((node) => node.tagName === "a" && attribute(node, "href") === "#analysis-section"));
  const button = byID(nodes, "run-fleet-analysis");
  assert.equal(button.tagName, "button");
  assert.equal(attribute(button, "type"), "button");
  const visibleCopy = nodes.filter((node) => node.nodeName === "#text").map((node) => node.value).join(" ");
  assert.match(visibleCopy, /Recommendations are advisory and do not change fleet state/i);
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
    if (/max-width\s*:\s*850px/.test(rule.params)) responsiveRules.push(rule);
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

test("OpenUI Core parses and evaluates a read-only fleet view", async () => {
  let overviewReads = 0;
  const runtime = createFleetOpenUI({
    getOverview: async () => {
      overviewReads += 1;
      return overview;
    },
  });

  const initial = runtime.renderProgram(OPENUI_STARTER_SOURCE);
  assert.equal(initial.root.typeName, "Dashboard");
  assert.deepEqual(initial.parseResult.meta.errors, []);
  await runtime.waitForQueries();

  const [devices, fleetHealth, active, ready, health] = runtime.getView().root.props.children;
  assert.equal(devices.props.value, "2 enrolled");
  assert.equal(devices.props.detail, "1 enabled · 1 disabled");
  assert.equal(fleetHealth.props.label, "Device health");
  assert.equal(fleetHealth.props.value, "0 healthy · 0 degraded · 0 stale/offline");
  assert.equal(fleetHealth.props.detail, "1 unknown · 0 starting/stopping · 1 disabled");
  assert.equal(active.props.value, "operations / r-test");
  assert.equal(active.props.detail, "Ready for enrolled devices on their next sync");
  assert.equal(ready.props.value, "1 version ready to activate");
  assert.equal(health.props.label, "Image availability");
  assert.equal(health.props.value, "All available");
  assert.equal(health.props.detail, "All images in the active playlist are available");
  assert.equal(overviewReads, 1);
  runtime.dispose();
});

test("OpenUI fleet health keeps degraded, stale, offline, unknown, and disabled counts distinct", async () => {
  const statuses = ["healthy", "degraded", "stale", "offline", "starting", "stopping", "unknown"];
  const runtime = createFleetOpenUI({
    getOverview: async () => ({
      ...overview,
      devices: statuses.map((status, index) => ({ device_id: `pi-${index}`, enabled: 1, health: { status } }))
        .concat({ device_id: "pi-disabled", enabled: 0, health: { status: "healthy" } }),
    }),
  });
  runtime.renderProgram(OPENUI_STARTER_SOURCE);
  await runtime.waitForQueries();
  const health = runtime.getView().root.props.children[1];
  assert.equal(health.props.value, "1 healthy · 1 degraded · 2 stale/offline");
  assert.equal(health.props.detail, "1 unknown · 2 starting/stopping · 1 disabled");
  runtime.dispose();
});

test("OpenUI Core summarizes missing assets as a compact metric", async () => {
  const runtime = createFleetOpenUI({
    getOverview: async () => ({
      ...overview,
      asset_health: { missing: [{ sha256: "deadbeef" }] },
    }),
  });

  runtime.renderProgram(OPENUI_STARTER_SOURCE);
  await runtime.waitForQueries();

  const imageHealth = runtime.getView().root.props.children[4];
  assert.equal(imageHealth.props.label, "Image availability");
  assert.equal(imageHealth.props.value, "1 missing");
  assert.equal(imageHealth.props.detail, "1 image is missing from the active playlist");
  runtime.dispose();
});

test("fleet snapshot is concise and accurate when no playlist is active", async () => {
  const runtime = createFleetOpenUI({
    getOverview: async () => ({
      ...overview,
      playlists: [],
      active_playlist: null,
      asset_health: { missing: [] },
    }),
  });

  runtime.renderProgram(OPENUI_STARTER_SOURCE);
  await runtime.waitForQueries();

  const [devices, fleetHealth, active, ready, health] = runtime.getView().root.props.children;
  assert.equal(active.props.value, "No active playlist");
  assert.equal(active.props.detail, "No playlist is active for enrolled devices");
  assert.equal(ready.props.detail, "No versions are waiting to be activated");
  assert.equal(health.props.value, "No active playlist");
  assert.equal(health.props.detail, "No images can be checked until a playlist is active");
  runtime.dispose();
});

test("fleet view compacts long revisions and keeps short or missing identifiers readable", async () => {
  const runtime = createFleetOpenUI({
    getOverview: async () => ({
      ...overview,
      active_playlist: { playlist_id: "operations", revision: "r-0123456789abcdef0123456789abcd" },
    }),
  });

  runtime.renderProgram(OPENUI_STARTER_SOURCE);
  await runtime.waitForQueries();

  const active = runtime.getView().root.props.children[2];
  assert.equal(active.props.value, "operations / r-01234567…89abcd");
  assert.equal(compactIdentifier("r-short"), "r-short");
  assert.equal(compactIdentifier(null), "—");
  runtime.dispose();
});

test("OpenUI fleet view follows the documented read-only contract", () => {
  let overviewReads = 0;
  const runtime = createFleetOpenUI({
    getOverview: async () => {
      overviewReads += 1;
      return overview;
    },
  });

  assert.throws(() => runtime.renderProgram(
    'data = Query("create_enrollment_code", {}, {})\nroot = Dashboard([])',
  ), /only support the read-only get_fleet_overview query/i);
  assert.throws(() => runtime.renderProgram(
    'root = Dashboard([])\nchange = Mutation("disable_device", {})',
  ), /mutations are disabled/i);
  assert.equal(overviewReads, 0);
  assert.match(runtime.prompt, /Use only the get_fleet_overview read-only query/i);
  assert.match(runtime.prompt, /Do not emit Mutation statements, actions/i);
  assert.match(runtime.prompt, /do not expose credentials or tokens/i);
  assert.doesNotMatch(runtime.prompt, /Mutation\("disable_device"/i);
  assert.doesNotMatch(runtime.prompt, /## Mutation|Mutation.*write examples/i);
  assert.ok(runtime.prompt.length < 4_000, "the behind-the-scenes prompt should stay concise");
  runtime.dispose();
});

test("OpenUI runtime recognizes incomplete programs and preserves selected fleet metrics when merging", async () => {
  const runtime = createFleetOpenUI({ getOverview: async () => overview });
  const partial = runtime.inspectProgram('root = Dashboard([deviceMetric');
  assert.equal(partial.incomplete, true);

  const merged = runtime.mergePatch(
    OPENUI_STARTER_SOURCE,
    "root = Dashboard([deviceMetric, activeMetric])",
  );
  const result = runtime.inspectProgram(merged);
  assert.equal(result.incomplete, false);
  assert.deepEqual(result.errors, []);
  runtime.renderProgram(merged);
  await runtime.waitForQueries();
  const [devices, active] = runtime.getView().root.props.children;
  assert.equal(devices.props.value, "2 enrolled");
  assert.equal(active.props.value, "operations / r-test");
  assert.equal(runtime.getView().root.props.children.length, 2, "the merged view excludes the replaced metrics");
  runtime.dispose();
});

test("waitForQueries rejects when the runtime is disposed during a pending query", async () => {
  let resolveOverview;
  let markOverviewStarted;
  const overviewStarted = new Promise((resolve) => { markOverviewStarted = resolve; });
  const runtime = createFleetOpenUI({
    getOverview: () => {
      markOverviewStarted();
      return new Promise((resolve) => { resolveOverview = resolve; });
    },
  });

  runtime.renderProgram(OPENUI_STARTER_SOURCE);
  await overviewStarted;
  const waiting = runtime.waitForQueries();
  runtime.dispose();

  await assert.rejects(waiting, /disposed/i);
  resolveOverview(overview);
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

test("management environment copy accurately describes Access and local sign-in", () => {
  const production = formatEnvironmentNotice("production");
  assert.equal(production.production, true);
  assert.match(production.detail, /Cloudflare Access/i);

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

test("playlist URL input trims blank lines and preserves each submitted page", () => {
  assert.deepEqual(parsePageURLs("  https://one.example/  \n\nhttps://two.example/path\n"), [
    "https://one.example/",
    "https://two.example/path",
  ]);
  assert.equal(hasPageURLs(" \n  \n"), false);
  assert.equal(hasPageURLs("https://status.example.com"), true);
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

test('visible analysis copy is branded as Ribbonfish and omits provider metadata', async () => {
  const html = await readFile(new URL('../public/admin/index.html', import.meta.url), 'utf8');
  const script = await readFile(new URL('../public/admin/app.js', import.meta.url), 'utf8');
  const visible = parseHTML(html).filter((item) => item.nodeName === '#text').map((item) => item.value).join(' ');
  assert.doesNotMatch(visible, /\bJEV\b/i);
  assert.match(visible, /Ribbonfish reviews/i);
  assert.doesNotMatch(script, /result\.model|result\.usage/);
});
