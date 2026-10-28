import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL("../../../.github/workflows/deploy-device-sync.yml", import.meta.url);

test("production deployment follows validated Worker changes on the protected default branch", async () => {
  const workflow = await readFile(workflowUrl, "utf8");
  const deployStart = workflow.indexOf("  deploy:\n");
  const trigger = workflow.slice(0, workflow.indexOf("\npermissions:"));

  assert.notEqual(deployStart, -1, "workflow must define a deploy job");
  assert.match(
    workflow,
    /^on:\n  push:\n    branches:\n      - main\n    paths:/m,
    "production deployment must run automatically for changes pushed to main",
  );
  for (const path of [
    "workers/device-sync/src/index.js",
    "workers/device-sync/src/admin.js",
    "workers/device-sync/src/duration.js",
    "workers/device-sync/public/admin/**",
    "workers/device-sync/scripts/build-admin.mjs",
    "workers/device-sync/scripts/publish-admin-assets.mjs",
    "workers/device-sync/wrangler.toml",
    "workers/device-sync/wrangler.management.toml",
    "workers/device-sync/package.json",
    "workers/device-sync/package-lock.json",
  ]) {
    assert.ok(trigger.includes(`      - "${path}"`), `${path} changes must trigger deployment`);
  }
  assert.doesNotMatch(
    trigger,
    /README\.md|\.test\.js|\.github\/workflows/,
    "documentation, test, and workflow-only changes must not deploy",
  );
  assert.match(workflow, /^permissions:\n  contents: read$/m, "workflow permissions must stay read-only");

  const deployJob = workflow.slice(deployStart);
  const validateJob = workflow.slice(workflow.indexOf("  validate:\n"), deployStart);
  const expressionStart = String.fromCharCode(36) + "{{";

  assert.ok(validateJob.includes("npm test"), "deployment must follow the test suite");
  assert.ok(validateJob.includes("npm run check:config"), "deployment must follow Wrangler dry runs");
  assert.doesNotMatch(validateJob, /secrets\.CLOUDFLARE_/, "validation must not receive Cloudflare credentials");
  assert.match(deployJob, /^\s+needs: validate$/m, "deployment must wait for validation");
  assert.match(
    deployJob,
    /^\s+if:.*github\.ref.*default_branch.*github\.ref_protected/m,
    "deployment must require the protected default branch",
  );
  assert.match(deployJob, /^\s+environment:\n\s+name: production$/m, "deployment must use the production environment");
  assert.ok(deployJob.includes("npm run deploy:production"), "deployment must publish the device-sync Worker");
  assert.ok(deployJob.includes("npm run deploy:management"), "deployment must publish management assets and Worker");
  assert.ok(
    deployJob.includes("CLOUDFLARE_API_TOKEN: " + expressionStart + " secrets.CLOUDFLARE_API_TOKEN }}"),
    "deployment must use the repository API-token secret",
  );
  assert.ok(
    deployJob.includes("CLOUDFLARE_ACCOUNT_ID: " + expressionStart + " secrets.CLOUDFLARE_ACCOUNT_ID }}"),
    "deployment must use the repository account-ID secret",
  );
  assert.doesNotMatch(deployJob, /migrate:management/, "D1 migrations must remain a separate explicit operation");
});
