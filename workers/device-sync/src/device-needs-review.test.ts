import test from "node:test";
import assert from "node:assert/strict";
import { deviceNeedsReview } from "../public/admin/device-needs-review.ts";

const activePlaylist = { playlist_id: "playlist-a", revision: 4 };

test("device review signal covers health, sync, and playlist drift while ignoring disabled devices", () => {
  const healthy = {
    enabled: true,
    health: {
      status: "healthy",
      sync_status: "ok",
      applied_playlist_id: activePlaylist.playlist_id,
      applied_revision: "4",
    },
  };

  assert.equal(deviceNeedsReview(healthy, activePlaylist), false);
  assert.equal(deviceNeedsReview({ ...healthy, health: { ...healthy.health, status: "stale" } }, activePlaylist), true);
  assert.equal(deviceNeedsReview({ ...healthy, health: { ...healthy.health, sync_status: "error" } }, activePlaylist), true);
  assert.equal(deviceNeedsReview({ ...healthy, health: { ...healthy.health, applied_revision: 3 } }, activePlaylist), true);
  assert.equal(deviceNeedsReview({ ...healthy, health: { ...healthy.health, applied_playlist_id: null } }, activePlaylist), true);
  assert.equal(deviceNeedsReview({ ...healthy, enabled: false, health: { ...healthy.health, status: "offline" } }, activePlaylist), false);
});
