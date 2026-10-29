import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  createFleetOpenUI,
  OPENUI_STARTER_SOURCE,
} from "../public/admin/openui-core.js";
import {
  confirmBeforeAction,
  formatAuditDetails,
  formatAuditEventType,
  formatActorLabel,
  compactIdentifier,
  formatCaptureInterval,
  formatDeviceEnabledMessage,
  formatEnvironmentNotice,
  formatPlaylistState,
  playlistDeleteActionStates,
  formatScreenshotStatus,
  formatTimestamp,
  hasPageURLs,
  parsePageURLs,
} from "../public/admin/ui-utils.js";

// Contract source: ../README.md#local-development and ../README.md#management-api.

const overview = {
  devices: [{ enabled: 1 }, { enabled: 0 }],
  playlists: [{ active: true }, { active: false }],
  active_playlist: { playlist_id: "operations", revision: "r-test" },
  asset_health: { missing: [] },
};

test("management page uses the Ribbonfish favicon", async () => {
  const html = await readFile(new URL("../public/admin/index.html", import.meta.url), "utf8");
  assert.match(html, /<link rel="icon" type="image\/png" href="\/admin\/favicon\.png">/);
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

  const [devices, active, ready, health] = runtime.getView().root.props.children;
  assert.equal(devices.props.value, "2 enrolled");
  assert.equal(devices.props.detail, "1 enabled · 1 disabled");
  assert.equal(active.props.value, "operations / r-test");
  assert.equal(active.props.detail, "Ready for enrolled devices on their next sync");
  assert.equal(ready.props.value, "1 version ready to activate");
  assert.equal(health.props.body, "All active playlist images are available");
  assert.equal(overviewReads, 1);
  runtime.dispose();
});

test("OpenUI Core reports missing assets as a warning", async () => {
  const runtime = createFleetOpenUI({
    getOverview: async () => ({
      ...overview,
      asset_health: { missing: [{ sha256: "deadbeef" }] },
    }),
  });

  runtime.renderProgram(OPENUI_STARTER_SOURCE);
  await runtime.waitForQueries();

  const notice = runtime.getView().root.props.children[3];
  assert.equal(notice.props.tone, "warning");
  assert.equal(notice.props.body, "1 image missing from the active playlist");
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

  const [devices, active, ready, health] = runtime.getView().root.props.children;
  assert.equal(active.props.value, "No active playlist");
  assert.equal(active.props.detail, "No playlist is active for enrolled devices");
  assert.equal(ready.props.detail, "No versions are waiting to be activated");
  assert.equal(health.props.body, "No active playlist");
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

  const active = runtime.getView().root.props.children[1];
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

test("OpenUI runtime recognizes incomplete programs and validates merged fleet views", () => {
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
  assert.match(merged, /root = Dashboard\(\[deviceMetric, activeMetric\]\)/);
  assert.match(merged, /overview = Query\("get_fleet_overview"/);
  assert.doesNotMatch(merged, /stagedMetric/);
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

test("device management shows pending approval fingerprints and removes the enrollment-code form", async () => {
  const html = await readFile(new URL("../public/admin/index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../public/admin/app.js", import.meta.url), "utf8");
  assert.match(html, /id="pending-enrollments"/);
  assert.match(html, /id="pending-enrollments-mobile"/);
  assert.doesNotMatch(html, /id="enrollment-form"/);
  assert.match(app, /physical display shows the full fingerprint/);
  assert.match(app, /enrollment-requests\/\$\{request\.request_id\}\/approve/);
  assert.match(app, /enrollment-requests\/\$\{request\.request_id\}\/reject/);
  assert.doesNotMatch(app, /#enrollment-form/);
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

test("playlist editor adds scheduled page screenshots and reuses uploaded images", async () => {
  const html = await readFile(new URL("../public/admin/index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../public/admin/app.js", import.meta.url), "utf8");

  assert.match(html, /name="capture_urls"/);
  assert.match(html, /id="screenshot-settings"[^>]*disabled[^>]*hidden/);
  assert.match(html, /name="capture_interval_seconds"[^>]*min="60"/);
  assert.match(html, /id="playlist-current-captures"/);
  assert.match(html, /id="capture-targets"/);
  assert.match(app, /parsePageURLs\(form\.get\("capture_urls"\)\)/);
  assert.match(app, /syncScreenshotSettings\(\)/);
  assert.match(app, /api\("\/admin\/api\/assets"/);
  assert.match(app, /capture_interval_seconds/);
  assert.match(app, /\/admin\/api\/captures\/.*\/run/);
  assert.match(app, /Initial screenshots are queued after saving when capacity allows/);
  assert.doesNotMatch(app, /will start after activation/);
  assert.deepEqual(parsePageURLs("  https://one.example/  \n\nhttps://two.example/path\n"), [
    "https://one.example/",
    "https://two.example/path",
  ]);
  assert.equal(hasPageURLs(" \n  \n"), false);
  assert.equal(hasPageURLs("https://status.example.com"), true);
});

test("management keeps OpenUI behind the scenes and switches tables to cards before they cramp", async () => {
  const html = await readFile(new URL("../public/admin/index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../public/admin/app.js", import.meta.url), "utf8");
  const styles = await readFile(new URL("../public/admin/styles.css", import.meta.url), "utf8");

  assert.match(html, /href="#capture-targets">Page screenshots<\/a>/);
  assert.match(html, /id="capture-targets-title">Page screenshots<\/h3>/);
  assert.match(html, /id="playlist-title">Playlist versions<\/h2>/);
  assert.match(html, /id="device-title">Device fleet<\/h2>/);
  assert.match(html, /id="activity-title">Recent activity<\/h2>/);
  assert.match(html, /id="reload"[^>]*>Refresh data<\/button>/);
  assert.doesNotMatch(html, /Browser Run|Web captures|Webpage captures|content-addressed image store|scheduler tick/);

  assert.match(html, /id="fleet-summary"[^>]*aria-label="Fleet snapshot"/);
  assert.doesNotMatch(html, /developer-tools|openui-source|openui-prompt|OpenUI Lang|Merge patch|Restore starter|Copy prompt/i);
  assert.doesNotMatch(app, /openui-preview-button|openui-merge-button|openui-reset-button|openui-copy-prompt/);
  assert.match(app, /createFleetOpenUI/);
  assert.match(app, /playlistDeleteActionStates\(playlists\)/);
  assert.match(app, /remove\.disabled = true/);
  assert.match(app, /deleteAction\.hint/);

  assert.match(app, /new IntersectionObserver/);
  assert.match(app, /aria-current", "location"/);
  assert.match(app, /function renderResponsiveRecords\(/);
  assert.match(app, /function renderEmptyState\(/);
  assert.equal((app.match(/^  renderResponsiveRecords\(\{/gm) ?? []).length, 4);
  assert.doesNotMatch(app, /function renderPlaylistCard|function renderDeviceCard|function renderPendingRequestCard|function renderAuditCard/);
  assert.match(styles, /\.section-nav a\[aria-current="location"\]/);
  assert.match(styles, /--font-size-body:/);
  assert.match(styles, /\.data-card, \.capture-target/);
  assert.match(styles, /@media\s*\(max-width:\s*850px\)\s*\{[\s\S]*?\.desktop-data\s*\{\s*display:\s*none;/);
  assert.doesNotMatch(styles, /developer-tools|openui-prompt-details/);
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
