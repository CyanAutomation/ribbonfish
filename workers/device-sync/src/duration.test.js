import test from "node:test";
import assert from "node:assert/strict";
import { isValidPositiveDuration } from "./duration.js";

test("accepts positive Go durations within the time.Duration range", () => {
  for (const value of ["1ns", "0.5s", "1h30m", "9223372036854775807ns"]) {
    assert.equal(isValidPositiveDuration(value), true, value);
  }
});

test("rejects zero, sub-nanosecond, malformed, and overflowing durations", () => {
  for (const value of ["0s", "0.1ns", "999999999999999999999h", "1s2", "", null]) {
    assert.equal(isValidPositiveDuration(value), false, String(value));
  }
});
