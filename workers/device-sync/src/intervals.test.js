import test from "node:test";
import assert from "node:assert/strict";
import {
  CAPTURE_INTERVALS,
  DEFAULT_CAPTURE_INTERVAL_SECONDS,
  DEFAULT_ROTATION_INTERVAL,
  ROTATION_INTERVALS,
  isSupportedCaptureInterval,
  isSupportedRotationInterval,
} from "./intervals.js";

test("interval contract defines five choices and the product defaults", () => {
  assert.deepEqual(CAPTURE_INTERVALS.map(({ value }) => value), [900, 1800, 3600, 21600, 86400]);
  assert.deepEqual(ROTATION_INTERVALS.map(({ value }) => value), ["30s", "60s", "90s", "120s", "5m"]);
  assert.equal(DEFAULT_CAPTURE_INTERVAL_SECONDS, 86400);
  assert.equal(DEFAULT_ROTATION_INTERVAL, "90s");
});

test("interval helpers accept only the defined values", () => {
  assert.equal(isSupportedCaptureInterval(900), true);
  assert.equal(isSupportedCaptureInterval(300), false);
  assert.equal(isSupportedRotationInterval("90s"), true);
  assert.equal(isSupportedRotationInterval("15s"), false);
});
