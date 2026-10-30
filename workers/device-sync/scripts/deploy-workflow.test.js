import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

// Release contract: ../README.md#local-development and ../../../README.md#deployment-model.
const root = new URL("../../../", import.meta.url);

async function readYaml(path) {
  const source = await readFile(new URL(path, root), "utf8");
  return parse(source, { uniqueKeys: true });
}

function stepNamed(job, name) {
  const step = job.steps?.find((item) => item.name === name);
  assert.ok(step, `expected workflow step: ${name}`);
  return step;
}

test("production deployment validates relevant Worker changes before protected-main release", async () => {
  const workflow = await readYaml(".github/workflows/deploy-device-sync.yml");
  const paths = workflow.on.push.paths;
  const validate = workflow.jobs.validate;
  const deploy = workflow.jobs.deploy;

  assert.deepEqual(workflow.on.push.branches, ["main"]);
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
  ]) assert.ok(paths.includes(path), `changes to ${path} must trigger deployment`);
  assert.equal(paths.some((path) => /README|\.test\.js/.test(path)), false);

  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.match(stepNamed(validate, "Test Worker routes and authorization").run, /npm test/);
  assert.match(stepNamed(validate, "Validate production Worker bundles").run, /check:config/);
  assert.doesNotMatch(JSON.stringify(validate), /secrets\.CLOUDFLARE_/);
  assert.equal(deploy.needs, "validate");
  assert.match(deploy.if, /default_branch/);
  assert.match(deploy.if, /ref_protected/);
  assert.equal(deploy.environment.name, "production");
  assert.match(stepNamed(deploy, "Deploy device-sync Worker").run, /deploy:production/);
  assert.match(stepNamed(deploy, "Publish management assets and deploy Worker").run, /deploy:management/);
  assert.equal(stepNamed(deploy, "Deploy device-sync Worker").env.CLOUDFLARE_API_TOKEN, "${{ secrets.CLOUDFLARE_API_TOKEN }}");
  assert.equal(stepNamed(deploy, "Deploy device-sync Worker").env.CLOUDFLARE_ACCOUNT_ID, "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}");
  assert.doesNotMatch(JSON.stringify(deploy), /migrate:management/);
});

test("container publishers wait for shared validation and avoid promoting stale builds", async () => {
  const workflows = [
    ["docker-publish.yml", "Docker Hub"],
    ["publish-agent.yml", "GitHub Container Registry"],
  ];

  for (const [file, registry] of workflows) {
    const workflow = await readYaml(`.github/workflows/${file}`);
    const publish = workflow.jobs.publish;
    assert.deepEqual(workflow.on.push.branches, ["main"]);
    assert.ok(workflow.on.push.paths.includes("agent/**"));
    assert.ok(workflow.on.push.paths.includes(`.github/workflows/${file}`));
    assert.equal(workflow.jobs.verify.uses, "./.github/workflows/verify-agent.yml");
    assert.equal(publish.needs, "verify");
    assert.match(publish.if, /ref_protected/);
    const promotion = publish.steps.find((step) => /Promote current main image/.test(step.name));
    assert.ok(promotion, `${registry} image promotion step must exist`);
    assert.match(promotion.run, /main_sha/);
    assert.match(promotion.run, /IMAGE_SHA/);
    assert.match(promotion.run, /exit 0/);
  }

  const ghcr = await readYaml(".github/workflows/publish-agent.yml");
  const metadata = ghcr.jobs.publish.steps.find((step) => step.id === "metadata");
  assert.match(metadata.with.tags, /type=sha,format=long/);
  assert.match(ghcr.jobs.publish.steps.find((step) => /Promote current main image/.test(step.name)).run,
    /ribbonfish:main/);

  const dockerHub = await readYaml(".github/workflows/docker-publish.yml");
  const promotion = dockerHub.jobs.publish.steps.find((step) => /Promote current main image/.test(step.name));
  assert.equal(promotion.env.GH_TOKEN, "${{ github.token }}");
  assert.match(promotion.run, /ribbonfish:latest/);
});

test("Go and workflow validation run on pull requests through their intended jobs", async () => {
  const agent = await readYaml(".github/workflows/agent.yml");
  assert.ok(Object.hasOwn(agent.on, "pull_request"), "Go checks must run for pull requests");
  assert.equal(agent.jobs["test-and-cross-compile"].uses, "./.github/workflows/verify-agent.yml");

  const lint = await readYaml(".github/workflows/workflow-lint.yml");
  assert.ok(Object.hasOwn(lint.on, "pull_request"), "workflow lint must run for pull requests");
  assert.ok(lint.on.push.paths.includes(".github/workflows/**"));
  const lintCommand = lint.jobs.actionlint.steps.find((step) => /Check workflow syntax/.test(step.name));
  assert.match(lintCommand.run, /actionlint/);
});

test("workflow caches include each workflow's tool pins and Go module inputs", async () => {
  const cases = [
    ["verify-agent.yml", "golang.org/x/vuln/cmd/govulncheck@v1.1.4"],
    ["workflow-lint.yml", "github.com/rhysd/actionlint/cmd/actionlint@v1.7.12"],
  ];
  for (const [file, tool] of cases) {
    const workflow = await readYaml(`.github/workflows/${file}`);
    const setupGo = Object.values(workflow.jobs).flatMap((job) => job.steps ?? [])
      .find((step) => step.uses?.startsWith("actions/setup-go@"));
    assert.ok(setupGo);
    assert.match(setupGo.with["cache-dependency-path"], /agent\/go\.mod/);
    assert.ok(setupGo.with["cache-dependency-path"].includes(`.github/workflows/${file}`));
    assert.ok(JSON.stringify(workflow).includes(tool));
  }
});

test("dependency updates cover the shipped npm package and container base images stay digest-pinned", async () => {
  const dependabot = await readYaml(".github/dependabot.yml");
  assert.ok(dependabot.updates.some((update) =>
    update["package-ecosystem"] === "npm" && update.directory === "/workers/device-sync"));
  assert.ok(dependabot.updates.some((update) =>
    update["package-ecosystem"] === "docker" && update.directory === "/agent"));

  const dockerfile = await readFile(new URL("../../../agent/Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /^FROM --platform=\$BUILDPLATFORM golang:\d+\.\d+\.\d+-alpine@sha256:[a-f0-9]{64} AS build$/m);
  assert.match(dockerfile, /^FROM gcr\.io\/distroless\/static-debian12:nonroot@sha256:[a-f0-9]{64}$/m);
});
