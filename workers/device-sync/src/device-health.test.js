import test from "node:test";
import assert from "node:assert/strict";
import { deriveDeviceHealth, validateDeviceHealthReport } from "./device-health.js";

const report = {
  schema_version: 1,
  instance_id: "boot-0123456789abcdef",
  agent_version: "sha-0123456789ab",
  state: "degraded",
  agent_uptime_seconds: 120,
  startup_error_code: null,
  sync: { status: "ok", applied_playlist_id: "operations", applied_revision: "r-1", last_success_age_seconds: 15, error_code: null },
  outputs: [{ display_id: "main", connector: "HDMI-A-1", status: "failed", last_frame_age_seconds: null, error_code: "connector_disconnected" }],
  host: { uptime_seconds: 3600, load_1m: 0.1, memory_available_bytes: 200_000_000, state_disk_free_bytes: 20_000_000_000, temperature_millicelsius: 39_166 },
};

test("health report accepts bounded version 1 data and rejects unknown or unsafe fields", () => {
  assert.deepEqual(validateDeviceHealthReport(report), report);
  assert.equal(validateDeviceHealthReport({ ...report, token: "secret" }), null);
  assert.equal(validateDeviceHealthReport({ ...report, outputs: [{ ...report.outputs[0], error_code: "token at /var/lib/ribbonfish/device-token" }] }), null);
  assert.equal(validateDeviceHealthReport({ ...report, outputs: Array(9).fill(report.outputs[0]) }), null);
});

test("fleet health uses server receive time and retains reported faults", () => {
  const receivedAt = 1_000_000;
  assert.equal(deriveDeviceHealth(null, receivedAt, receivedAt), "unknown");
  assert.equal(deriveDeviceHealth({ state: "ready", sync: { status: "ok" }, outputs: [] }, receivedAt, receivedAt + 1000), "healthy");
  assert.equal(deriveDeviceHealth({ state: "ready", sync: { status: "unknown" }, outputs: [{ status: "unknown" }] }, receivedAt, receivedAt + 1000), "starting");
  assert.equal(deriveDeviceHealth(report, receivedAt, receivedAt + 1000), "degraded");
  assert.equal(deriveDeviceHealth({ state: "ready", sync: { status: "ok" }, outputs: [] }, receivedAt, receivedAt + 181_000), "stale");
  assert.equal(deriveDeviceHealth({ state: "ready", sync: { status: "ok" }, outputs: [] }, receivedAt, receivedAt + 301_000), "offline");
});
