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
    "workers/device-sync/src/asset-store.js",
    "workers/device-sync/src/asset-registry.js",
    "workers/device-sync/src/asset-maintenance.js",
    "workers/device-sync/src/capture.js",
    "workers/device-sync/src/capture-workflow.js",
    "workers/device-sync/src/duration.js",
    "workers/device-sync/migrations/**",
    "workers/device-sync/public/admin/**",
    "workers/device-sync/schema.sql",
    "workers/device-sync/scripts/build-admin.mjs",
    "workers/device-sync/scripts/publish-admin-assets.mjs",
    "workers/device-sync/.nvmrc",
    "workers/device-sync/wrangler.toml",
    "workers/device-sync/wrangler.management.toml",
    "workers/device-sync/package.json",
    "workers/device-sync/package-lock.json",
    ".github/workflows/deploy-device-sync.yml",
  ]) {
    assert.ok(trigger.includes(`      - "${path}"`), `${path} changes must trigger deployment`);
  }
  assert.doesNotMatch(
    trigger,
    /README\.md|\.test\.js/,
    "documentation and test-only changes must not deploy",
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

test("both image publishers run only for relevant changes pushed to main", async () => {
  const workflows = [
    ["docker-publish.yml", new URL("../../../.github/workflows/docker-publish.yml", import.meta.url)],
    ["publish-agent.yml", new URL("../../../.github/workflows/publish-agent.yml", import.meta.url)],
  ];

  for (const [name, url] of workflows) {
    const workflow = await readFile(url, "utf8");
    const trigger = workflow.slice(0, workflow.indexOf("\npermissions:"));

    assert.match(trigger, /^on:\n  push:\n    branches:\n      - main\n    paths:/m, `${name} must publish on main pushes`);
    assert.ok(trigger.includes('      - "agent/**"'), `${name} must run for agent changes`);
    assert.ok(trigger.includes(`      - ".github/workflows/${name}"`), `${name} must run when its workflow changes`);
    assert.doesNotMatch(trigger, /pull_request|tags:/, `${name} must not publish from PR-close or tag events`);
    assert.match(workflow, /verify:\n    uses: \.\/\.github\/workflows\/verify-agent\.yml/m, `${name} must call shared validation`);
    assert.match(workflow, /publish:\n    needs: verify/m, `${name} must publish only after validation`);
    assert.match(workflow, /publish:\n    needs: verify\n    if: github\.ref_protected/m, `${name} must only publish from protected main`);
  }

  const ghcr = await readFile(workflows[1][1], "utf8");
  assert.match(ghcr, /type=sha,format=long/, "GHCR should publish an immutable full commit tag");
  assert.match(ghcr, /--tag ghcr\.io\/cyanautomation\/ribbonfish:main/, "GHCR should publish a stable main tag");
  assert.match(ghcr, /if \[ "\$main_sha" != "\$IMAGE_SHA" \]; then/, "stale runs must not promote GHCR main");

  const dockerHub = await readFile(workflows[0][1], "utf8");
  assert.match(dockerHub, /GH_TOKEN: .*github\.token/, "latest promotion must use the read-only GitHub token");
  assert.match(dockerHub, /if \[ "\$main_sha" != "\$IMAGE_SHA" \]; then/, "stale runs must not promote latest");
});

test("the Go CI workflow delegates its checks to the shared reusable workflow", async () => {
  const workflow = await readFile(new URL("../../../.github/workflows/agent.yml", import.meta.url), "utf8");

  assert.match(workflow, /test-and-cross-compile:\n    uses: \.\/\.github\/workflows\/verify-agent\.yml/m);
});

test("workflow linting runs for pull requests and main workflow changes", async () => {
  const workflow = await readFile(new URL("../../../.github/workflows/workflow-lint.yml", import.meta.url), "utf8");
  const trigger = workflow.slice(0, workflow.indexOf("\npermissions:"));

  assert.match(trigger, /^on:\n  push:\n    branches:\n      - main\n    paths:/m);
  assert.ok(trigger.includes('      - ".github/workflows/**"'));
  assert.match(trigger, /^  pull_request:$/m, "workflow lint must run for every pull request");
  assert.match(workflow, /actionlint@v1\.7\.12/);
});

test("Go workflow caches invalidate when their pinned go-run tools change", async () => {
  const workflows = [
    ["verify-agent.yml", "golang.org/x/vuln/cmd/govulncheck@v1.1.4"],
    ["workflow-lint.yml", "github.com/rhysd/actionlint/cmd/actionlint@v1.7.12"],
  ];

  for (const [name, tool] of workflows) {
    const workflow = await readFile(new URL(`../../../.github/workflows/${name}`, import.meta.url), "utf8");
    const cachePath = workflow.match(/cache-dependency-path: \|\n((?:\s+.+\n)+)/)?.[1] ?? "";

    assert.match(cachePath, /agent\/go\.mod/, `${name} cache must follow Go module requirements`);
    assert.ok(cachePath.includes(`.github/workflows/${name}`), `${name} cache must follow its pinned Go tool version`);
    assert.ok(workflow.includes(tool), `${name} must keep the Go tool version explicit`);
  }
});

test("Dependabot updates npm and pinned Docker base images", async () => {
  const dependabot = await readFile(new URL("../../../.github/dependabot.yml", import.meta.url), "utf8");
  const dockerfile = await readFile(new URL("../../../agent/Dockerfile", import.meta.url), "utf8");

  assert.match(dependabot, /package-ecosystem: npm\n    directory: \/workers\/device-sync/);
  assert.match(dependabot, /package-ecosystem: docker\n    directory: \/agent/);
  assert.match(dockerfile, /^FROM --platform=\$BUILDPLATFORM golang:\d+\.\d+\.\d+-alpine@sha256:[a-f0-9]{64} AS build$/m);
  assert.match(dockerfile, /^FROM gcr\.io\/distroless\/static-debian12:nonroot@sha256:[a-f0-9]{64}$/m);
});
