import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkNodeTests } from "./typecheck-tests.ts";

test("Node test typechecking rejects Worker globals but accepts local mocks and Worker types", async (t) => {
  const source = await mkdtemp(join(tmpdir(), "ribbonfish-typecheck-fixture-"));
  t.after(() => rm(source, { recursive: true, force: true }));
  const fixture = join(source, "boundary.test.ts");
  await writeFile(fixture, 'import type { DeviceHealthReport } from "./device-health.ts";\nconst local = { caches: 1 };\nconst report: DeviceHealthReport | null = null;\nvoid [local.caches, report, process.version];\n');
  assert.equal(checkNodeTests(source).status, 0);
  await writeFile(fixture, 'void caches;\n');
  const rejected = checkNodeTests(source);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.output, /Cannot find name 'caches'/);
  await writeFile(fixture, "void globalThis.caches;\n");
  assert.notEqual(checkNodeTests(source).status, 0);
  await writeFile(fixture, 'import type { DeviceHealthReport } from "./device-health.ts";\nconst state: DeviceHealthReport["state"] = "invalid";\nvoid state;\n');
  assert.notEqual(checkNodeTests(source).status, 0);
});
