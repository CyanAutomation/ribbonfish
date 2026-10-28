import test from "node:test";
import assert from "node:assert/strict";
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
  assert.equal(active.props.detail, "No playlist is being sent to devices");
  assert.equal(staged.props.detail, "No revisions are waiting to be activated");
  assert.equal(health.props.body, "No active playlist");
  runtime.dispose();
});

test("fleet snapshot compacts long active playlist revisions", async () => {
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
  runtime.dispose();
});

test("OpenUI view permits only the existing overview query and no mutations", () => {
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
  runtime.dispose();
});

test("OpenUI prompt documents the library and read-only overview query", () => {
  const runtime = createFleetOpenUI({ getOverview: async () => overview });
  assert.match(runtime.prompt, /get_fleet_overview/);
  assert.match(runtime.prompt, /Metric/);
  assert.match(runtime.prompt, /read-only/i);
  runtime.dispose();
});

test("OpenUI Core streaming parser accepts partial programs and Core merges patches", () => {
  const runtime = createFleetOpenUI({ getOverview: async () => overview });
  const partial = runtime.inspectProgram('root = Dashboard([deviceMetric');
  assert.equal(partial.incomplete, true);

  const merged = runtime.mergePatch(
    OPENUI_STARTER_SOURCE,
    "root = Dashboard([deviceMetric, activeMetric])",
  );
  assert.match(merged, /activeMetric/);
  assert.doesNotMatch(merged, /stagedMetric/);
  runtime.dispose();
});

test("waitForQueries rejects when the runtime is disposed during a pending query", async () => {
  let resolveOverview;
  const runtime = createFleetOpenUI({
    getOverview: () => new Promise((resolve) => { resolveOverview = resolve; }),
  });

  runtime.renderProgram(OPENUI_STARTER_SOURCE);
  const waiting = runtime.waitForQueries().then(
    () => "resolved",
    (error) => error.message,
  );
  runtime.dispose();

  const outcome = await Promise.race([
    waiting,
    new Promise((resolve) => setTimeout(() => resolve("still pending"), 25)),
  ]);
  resolveOverview(overview);
  assert.match(outcome, /disposed/i);
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
  assert.equal(formatAuditEventType("device.credential_rotated"), "Rotated device token");
  assert.equal(formatAuditEventType("development.bootstrap"), "Initial playlist seeded");
  assert.equal(formatAuditEventType("sync.detected"), "Sync detected");
  assert.deepEqual(formatAuditDetails({
    asset_count: 2,
    previous: { playlist_id: "default", revision: "r-old" },
  }), [
    { label: "Asset count", value: "2" },
    { label: "Previous", value: "Playlist ID: default; Revision: r-old" },
  ]);
});

test("management environment copy accurately describes Access and local sign-in", () => {
  assert.deepEqual(formatEnvironmentNotice("production"), {
    production: true,
    label: "Production",
    heading: "Production environment.",
    detail: "Your session is verified through Cloudflare Access.",
  });
  assert.deepEqual(formatEnvironmentNotice("development"), {
    production: false,
    label: "Development",
    heading: "Development environment.",
    detail: "Administrator sign-in is not configured for this deployment.",
  });
  assert.doesNotMatch(formatEnvironmentNotice("development").detail, /test data only/i);
});

test("audit actors use a consistent readable fallback", () => {
  assert.equal(formatActorLabel("anonymous"), "Unauthenticated");
  assert.equal(formatActorLabel("operator-7"), "operator-7");
  assert.equal(formatActorLabel(null), "Unknown");
});

test("long identifiers are compacted without hiding their distinguishing ends", () => {
  assert.equal(compactIdentifier("r-short"), "r-short");
  assert.equal(
    compactIdentifier("r-080e675162b7477d9a8a96a3a9281a09"),
    "r-080e6751…281a09",
  );
  assert.equal(compactIdentifier(null), "—");
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
