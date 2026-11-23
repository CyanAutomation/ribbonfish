// @typecheck-node-test
import assert from "node:assert/strict";
import { test } from "node:test";
import { formatAge, formatDetailedAge } from "../public/admin/admin-formatters.ts";

test("compact and detailed age formats share thresholds while preserving their wording", () => {
  const cases: Array<[number, string, string]> = [
    [59, "59s", "59 sec"],
    [60, "1m", "1 min"],
    [3_660, "1h 1m", "1 hr 1 min"],
    [90_000, "1d 1h", "1 days 1 hr"],
  ];

  for (const [seconds, compact, detailed] of cases) {
    assert.equal(formatAge(seconds), compact);
    assert.equal(formatDetailedAge(seconds), detailed);
  }
  assert.equal(formatAge(-1), "unknown");
  assert.equal(formatDetailedAge(-1), "unknown age");
});
