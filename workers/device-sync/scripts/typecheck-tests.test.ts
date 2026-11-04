import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkNodeTests } from "./typecheck-tests.ts";

// Node test globals stay separate from Worker bindings: ../README.md#local-development.
test("Node test typechecking accepts Node fixtures and rejects Worker globals or invalid Worker types", async (t) => {
  const source = await mkdtemp(join(tmpdir(), "ribbonfish-typecheck-fixture-"));
  t.after(() => rm(source, { recursive: true, force: true }));
  const fixture = join(source, "boundary.test.ts");
  await writeFile(fixture, 'import type { DeviceHealthReport } from "./device-health.ts";\nconst local = { caches: 1 };\nconst report: DeviceHealthReport | null = null;\nvoid [local.caches, report, process.version];\n');
  assert.equal(checkNodeTests(source).status, 0);
  await writeFile(fixture, [
    "void caches;",
    "void globalThis.caches;",
    'import type { DeviceHealthReport } from "./device-health.ts";',
    'const state: DeviceHealthReport["state"] = "invalid";',
    "void state;",
    "",
  ].join("\n"));
  const rejected = checkNodeTests(source);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.output, /Cannot find name 'caches'/);
  assert.match(rejected.output, /TS7017.*typeof globalThis/);
  assert.match(rejected.output, /Type '"invalid"' is not assignable/);
});
