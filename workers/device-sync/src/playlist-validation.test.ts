import test from "node:test";
import assert from "node:assert/strict";
import { validatePlaylist } from "./playlist-validation.ts";

const valid = () => ({ version: 2, revision: "rev-1", id: "playlist-1", rotation_interval: "90s", assets: [{ sha256: "a".repeat(64), size: 100 }] });

test("playlist validator accepts a valid envelope and rejects malformed data", () => {
  assert.doesNotThrow(() => validatePlaylist(valid()));
  assert.throws(() => validatePlaylist({ ...valid(), version: 1 }), /invalid playlist envelope/);
  assert.throws(() => validatePlaylist({ ...valid(), assets: [] }), /invalid playlist envelope/);
  assert.throws(() => validatePlaylist({ ...valid(), unexpected: true }), /invalid playlist envelope/);
  assert.throws(() => validatePlaylist({ ...valid(), assets: [{ sha256: "x", size: 100 }] }), /invalid asset reference/);
  assert.throws(() => validatePlaylist({ ...valid(), assets: [{ sha256: "a".repeat(64), size: 0 }] }), /invalid asset reference/);
});
