import test from "node:test";
import assert from "node:assert/strict";
import { assessPlaylistReadiness } from "./playlist-readiness.ts";
import { buildPlaylistReadinessState } from "./jev-use-cases.ts";

const revision = { playlist_id: "office", revision: "rev-2" };

test("playlist readiness separates blocking asset issues, stale captures, and recipients", () => {
  const result = assessPlaylistReadiness({
    revision,
    assets: [{ position: 0, present: true }, { position: 1, present: false }],
    captures: [
      { capture_id: "capture-1", fresh: true, enabled: true, schedule_reviewed: true, asset_present: true },
      { capture_id: "capture-2", fresh: false, enabled: true, schedule_reviewed: true, asset_present: true },
    ],
    devices: [
      { device_id: "pi-current", enabled: true, applied_playlist_id: "office", applied_revision: "rev-2" },
      { device_id: "pi-old", enabled: true, applied_playlist_id: "office", applied_revision: "rev-1" },
      { device_id: "pi-disabled", enabled: false, applied_playlist_id: null, applied_revision: null },
    ],
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.summary.missing_assets, 1);
  assert.equal(result.summary.stale_captures, 1);
  assert.equal(result.summary.devices_to_update, 1);
  assert.deepEqual(result.devices_to_update.map(({ device_id }) => device_id), ["pi-old"]);
  assert.deepEqual(result.blockers, ["missing_assets"]);
  assert.deepEqual(result.warnings, ["stale_captures"]);
});

test("playlist readiness treats unreported enabled devices as recipients and empty checks honestly", () => {
  const result = assessPlaylistReadiness({
    revision,
    assets: [],
    captures: [],
    devices: [{ device_id: "pi-new", enabled: true, applied_playlist_id: null, applied_revision: null }],
  });

  assert.equal(result.status, "ready");
  assert.equal(result.summary.total_items, 0);
  assert.equal(result.summary.devices_to_update, 1);
  assert.equal(result.devices_to_update[0]?.sync_status, "unreported");
});

test("playlist readiness warns about unreviewed schedules and blocks disabled capture items", () => {
  const result = assessPlaylistReadiness({
    revision,
    assets: [],
    captures: [
      { capture_id: "capture-disabled", fresh: false, enabled: false, schedule_reviewed: false, asset_present: true },
      { capture_id: "capture-review", fresh: true, enabled: true, schedule_reviewed: false, asset_present: true },
    ],
    devices: [],
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.summary.disabled_captures, 1);
  assert.equal(result.summary.stale_captures, 0);
  assert.equal(result.summary.unreviewed_schedules, 1);
  assert.deepEqual(result.blockers, ["disabled_captures"]);
  assert.deepEqual(result.warnings, ["unreviewed_schedules"]);
});

test("JEV playlist readiness state contains only sanitized aggregate signals", () => {
  const readiness = assessPlaylistReadiness({
    revision: { playlist_id: "private-playlist", revision: "private-revision" },
    assets: [{ position: 0, present: false }],
    captures: [{ capture_id: "private-capture-id", fresh: false, enabled: true, schedule_reviewed: true, asset_present: true }],
    devices: [{ device_id: "private-device-id", enabled: true, applied_playlist_id: null, applied_revision: null }],
  });
  const state = buildPlaylistReadinessState(readiness);
  assert.deepEqual(JSON.parse(state), {
    deterministic_status: "blocked",
    total_items: 2,
    total_captures: 1,
    fresh_captures: 0,
    missing_assets: 1,
    stale_captures: 1,
    disabled_captures: 0,
    unreviewed_schedules: 0,
    devices_to_update: 1,
  });
  assert.doesNotMatch(state, /private-playlist|private-revision|private-capture|private-device/);
});
