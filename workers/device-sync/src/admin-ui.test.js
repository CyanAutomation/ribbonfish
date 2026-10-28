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
  formatDeviceEnabledMessage,
  formatEnvironmentNotice,
  formatTimestamp,
} from "../public/admin/ui-utils.js";

// Contract source: ../README.md#local-development and ../README.md#management-api.

const overview = {
  devices: [{ enabled: 1 }, { enabled: 0 }],
  playlists: [{ active: true }, { active: false }],
  active_playlist: { playlist_id: "operations", revision: "r-test" },
  asset_health: { missing: [] },
};

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

  const [devices, active, staged, health] = runtime.getView().root.props.children;
  assert.equal(devices.props.value, "2 enrolled");
  assert.equal(devices.props.detail, "1 enabled · 1 disabled");
  assert.equal(active.props.value, "operations / r-test");
  assert.equal(active.props.detail, "Ready for enrolled devices on their next sync");
  assert.equal(staged.props.value, "1 staged");
  assert.equal(health.props.body, "All active assets available");
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
  assert.equal(notice.props.body, "1 missing active asset");
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

  const [devices, active, staged, health] = runtime.getView().root.props.children;
  assert.equal(active.props.value, "No active playlist");
  assert.equal(active.props.detail, "No playlist is active for enrolled devices");
  assert.equal(staged.props.detail, "No revisions are waiting to be activated");
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
  runtime.dispose();
});

test("OpenUI editor recognizes incomplete input and validates the merged fleet view", () => {
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
  assert.equal(formatAuditEventType("playlist.revision_created"), "Staged playlist revision");
  assert.equal(formatAuditEventType("playlist.deleted"), "Deleted playlist");
  assert.equal(formatAuditEventType("device.credential_rotated"), "Rotated device token");
  assert.equal(formatAuditEventType("development.bootstrap"), "Initial playlist seeded");
  assert.equal(formatAuditEventType("device.disabled"), "Disabled device");
  assert.deepEqual(formatAuditDetails({
    asset_count: 2,
    previous: { playlist_id: "default", revision: "r-old" },
  }), [
    { label: "Asset count", value: "2" },
    { label: "Previous", value: "Playlist ID: default; Revision: r-old" },
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

test("playlist editor adds scheduled webpage captures and reuses the content-addressed PNG asset flow", async () => {
  const html = await readFile(new URL("../public/admin/index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../public/admin/app.js", import.meta.url), "utf8");

  assert.match(html, /name="capture_urls"/);
  assert.match(html, /name="capture_interval_seconds"[^>]*min="60"/);
  assert.match(html, /id="playlist-current-captures"/);
  assert.match(html, /id="capture-targets"/);
  assert.match(app, /api\("\/admin\/api\/assets"/);
  assert.match(app, /capture_interval_seconds/);
  assert.match(app, /\/admin\/api\/captures\/.*\/run/);
});
