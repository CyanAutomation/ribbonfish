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

test("audit timestamps are explicit UTC and preserve the Unix epoch", () => {
  assert.equal(formatTimestamp(null), "Never seen");
  assert.match(formatTimestamp(0, "en-GB"), /^1 Jan 1970, 00:00:00 UTC$/);
});

test("audit events and metadata are presented as readable labels", () => {
  assert.equal(formatAuditEventType("playlist.revision_created"), "Staged playlist revision");
  assert.equal(formatAuditEventType("device.credential_rotated"), "Rotated device token");
  assert.equal(formatAuditEventType("sync.detected"), "Sync detected");
  assert.deepEqual(formatAuditDetails({
    asset_count: 2,
    previous: { playlist_id: "default", revision: "r-old" },
  }), [
    { label: "Asset count", value: "2" },
    { label: "Previous", value: "Playlist ID: default; Revision: r-old" },
  ]);
});

test("consequential actions only run after explicit confirmation", async () => {
  let actions = 0;
  const declined = await confirmBeforeAction(() => false, "Disable device?", async () => {
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
