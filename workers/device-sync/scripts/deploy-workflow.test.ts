import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

// Release contract: ../README.md#local-development and ../../../README.md#deployment-model.
const root = new URL("../../../", import.meta.url);

interface WorkflowStep {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, string | number>;
  env?: Record<string, string>;
}
interface WorkflowJob {
  steps?: WorkflowStep[];
  uses?: string;
  needs?: string | string[];
  if?: string;
  environment?: { name: string } | string;
  permissions?: Record<string, string>;
}
interface WorkflowDocument {
  on: {
    pull_request?: unknown;
    workflow_call?: unknown;
    push?: { paths?: string[]; branches?: string[] };
  };
  jobs: Record<string, WorkflowJob>;
  permissions?: Record<string, string>;
  updates?: { "package-ecosystem": string; directory: string }[];
}

async function readYaml(path: string): Promise<WorkflowDocument> {
  const source = await readFile(new URL(path, root), "utf8");
  return parse(source, { uniqueKeys: true });
}

function stepNamed(job: WorkflowJob, name: string) {
  const step = job.steps?.find((item) => item.name === name);
  assert.ok(step, `expected workflow step: ${name}`);
  return step;
}

function calledJob(job: WorkflowJob, expected: string) {
  assert.equal(job.uses, expected);
}

function environmentName(job: WorkflowJob) {
  return typeof job.environment === "string" ? job.environment : job.environment?.name;
}

test("Worker validation and protected-main deployment share one validated workflow", async () => {
  const workflow = await readYaml(".github/workflows/device-sync.yml");
  const paths = workflow.on.push?.paths ?? [];
  const validate = workflow.jobs.validate;
  const deploy = workflow.jobs.deploy;

  assert.deepEqual(workflow.on.push?.branches, ["main"]);
  assert.ok(paths.includes("workers/device-sync/**"));
  assert.ok(paths.includes(".github/workflows/deploy-device-sync.yml"));
  assert.ok(paths.includes(".github/scripts/release-freshness.mts"));
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.match(stepNamed(validate, "Test Worker routes and authorization").run ?? "", /npm test/);
  assert.match(stepNamed(validate, "Validate production Worker bundles").run ?? "", /check:config/);
  assert.doesNotMatch(JSON.stringify(validate), /secrets\.CLOUDFLARE_/);
  assert.equal(deploy.needs, "validate");
  assert.match(deploy.if ?? "", /default_branch/);
  assert.match(deploy.if ?? "", /ref_protected/);
  assert.equal(environmentName(deploy), "production");

  const steps = deploy.steps ?? [];
  const freshness = steps.findIndex((step) => step.name === "Check current Worker inputs");
  const install = steps.findIndex((step) => step.name === "Install dependencies");
  const migration = steps.findIndex((step) => step.name === "Check production migration readiness");
  const deviceDeploy = steps.findIndex((step) => step.name === "Deploy device-sync Worker");
  const managementDeploy = steps.findIndex((step) => step.name === "Publish management assets and deploy Worker");
  const health = steps.findIndex((step) => step.name === "Check deployed Worker readiness");

  assert.ok(freshness >= 0 && freshness < install && install < migration);
  assert.ok(migration < deviceDeploy && migration < managementDeploy && managementDeploy < health);
  assert.match(steps[migration].if ?? "", /steps\.freshness\.outputs\.current == 'true'/);
  for (const index of [deviceDeploy, managementDeploy]) {
    assert.match(steps[index].if ?? "", /steps\.migration\.outcome == 'success'/);
  }
  assert.equal(steps[deviceDeploy].env?.CLOUDFLARE_API_TOKEN, "${{ secrets.CLOUDFLARE_API_TOKEN }}");
  assert.equal(steps[deviceDeploy].env?.CLOUDFLARE_ACCOUNT_ID, "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}");
  assert.match(steps[health].run ?? "", /\/healthz/);
  assert.equal(existsSync(new URL(".github/workflows/deploy-device-sync.yml", root)), false);
});

test("Node runtime setup consistently targets Node 26", async () => {
  const packageJson = JSON.parse(await readFile(new URL("workers/device-sync/package.json", root), "utf8"));
  const lockfile = JSON.parse(await readFile(new URL("workers/device-sync/package-lock.json", root), "utf8"));
  const nodeVersion = (await readFile(new URL("workers/device-sync/.nvmrc", root), "utf8")).trim();

  assert.equal(nodeVersion, "26");
  assert.equal(packageJson.engines.node, "26.x");
  assert.match(packageJson.devDependencies["@types/node"], /^\^26\./);
  assert.equal(lockfile.packages[""].engines.node, packageJson.engines.node);
  assert.equal(lockfile.packages[""].devDependencies["@types/node"], packageJson.devDependencies["@types/node"]);

  for (const file of ["workflow-lint.yml", "skill-validation.yml"]) {
    const workflow = await readYaml(`.github/workflows/${file}`);
    const setup = Object.values(workflow.jobs).flatMap((job) => job.steps ?? [])
      .find((step) => step.uses?.startsWith("actions/setup-node@"));
    assert.ok(setup, `${file} must set up Node`);
    assert.equal(setup.with?.["node-version"], 26, `${file} must use Node 26`);
  }

  const publisher = await readYaml(".github/workflows/publish-agent.yml");
  for (const jobName of ["publish-ghcr", "publish-dockerhub"]) {
    const setup = publisher.jobs[jobName].steps?.find((step) => step.uses?.startsWith("actions/setup-node@"));
    assert.ok(setup, `${jobName} must set up Node for the freshness check`);
    assert.equal(setup.with?.["node-version"], 26);
    assert.equal(setup.with?.["package-manager-cache"], false);
  }

  const worker = await readYaml(".github/workflows/device-sync.yml");
  const setupSteps = Object.values(worker.jobs).flatMap((job) => job.steps ?? [])
    .filter((step) => step.uses?.startsWith("actions/setup-node@"));
  assert.ok(setupSteps.length > 0);
  assert.ok(setupSteps.every((step) => step.with?.["node-version-file"] === "workers/device-sync/.nvmrc"));
});

test("agent release runs shared verification once and gates both registry promotions", async () => {
  const workflow = await readYaml(".github/workflows/publish-agent.yml");
  assert.deepEqual(workflow.on.push?.branches, ["main"]);
  const paths = workflow.on.push?.paths ?? [];
  assert.ok(paths.includes("agent/**"));
  assert.ok(paths.includes(".github/workflows/docker-publish.yml"));
  calledJob(workflow.jobs.verify, "./.github/workflows/verify-agent.yml");
  calledJob(workflow.jobs.smoke, "./.github/workflows/arm-container-smoke.yml");

  for (const [jobName, registry, platformRule] of [
    ["publish-ghcr", "ghcr.io/cyanautomation/ribbonfish", /linux\/arm\/v7,linux\/arm64/],
    ["publish-dockerhub", "docker.io", /linux\/amd64,linux\/arm64,linux\/arm\/v7/],
  ] as const) {
    const publish = workflow.jobs[jobName];
    assert.deepEqual(publish.needs, ["verify", "smoke"]);
    assert.match(publish.if ?? "", /ref_protected/);

    const steps = publish.steps ?? [];
    const metadata = steps.find((step) => step.id === "metadata");
    assert.ok(metadata);
    assert.match(String(metadata.with?.tags), /type=sha,format=long/);
    const build = steps.find((step) => step.id === "build");
    assert.ok(build);
    assert.match(String(build.with?.platforms), platformRule);
    assert.match(build.uses ?? "", /^docker\/build-push-action@[a-f0-9]{40}/);

    const scans = steps.filter((step) => step.name?.startsWith("Scan published"));
    const attestation = steps.find((step) => step.name?.startsWith("Attest "));
    const smoke = steps.find((step) => step.name?.startsWith("Smoke test"));
    const freshness = steps.find((step) => step.id === "freshness");
    const promotion = steps.find((step) => step.name?.startsWith("Promote current main image"));
    const expectedPlatforms = jobName === "publish-ghcr"
      ? ["linux/arm/v7", "linux/arm64"]
      : ["linux/amd64", "linux/arm64", "linux/arm/v7"];
    assert.equal(scans.length, expectedPlatforms.length);
    assert.deepEqual(scans.map((step) => step.env?.TRIVY_PLATFORM), expectedPlatforms);
    assert.ok(attestation && smoke && freshness && promotion);
    for (const scan of scans) {
      assert.ok(steps.indexOf(scan) < steps.indexOf(attestation));
      assert.match(scan.uses ?? "", /^aquasecurity\/trivy-action@[a-f0-9]{40}/);
      assert.match(String(scan.with?.["image-ref"]), /@\$\{\{ steps\.build\.outputs\.digest \}\}/);
      assert.equal(scan.with?.severity, "CRITICAL,HIGH");
    }
    assert.ok(steps.indexOf(attestation) < steps.indexOf(smoke));
    assert.ok(steps.indexOf(smoke) < steps.indexOf(freshness));
    assert.ok(steps.indexOf(freshness) < steps.indexOf(promotion));
    assert.match(attestation.uses ?? "", /^actions\/attest-build-provenance@[a-f0-9]{40}/);
    assert.equal(attestation.with?.["subject-digest"], "${{ steps.build.outputs.digest }}");
    assert.match(smoke.run ?? "", /@\$\{IMAGE_DIGEST\}/);
    assert.equal(freshness.env?.GH_TOKEN, "${{ github.token }}");
    assert.equal(promotion.if, "steps.freshness.outcome == 'success' && steps.freshness.outputs.current == 'true'");
    assert.match(promotion.run ?? "", /IMAGE_SHA/);
    assert.equal(publish.permissions?.["id-token"], "write");
    assert.equal(publish.permissions?.attestations, "write");
  }

  assert.ok(workflow.jobs["publish-ghcr"].permissions?.packages === "write");
  assert.equal(environmentName(workflow.jobs["publish-dockerhub"]), "docker");
  assert.equal(existsSync(new URL(".github/workflows/docker-publish.yml", root)), false);
});

test("Go, container, dependency, and workflow checks run on pull requests", async () => {
  const agent = await readYaml(".github/workflows/agent.yml");
  assert.ok(Object.hasOwn(agent.on, "pull_request"));
  assert.equal(agent.on.push, undefined, "main Go checks are part of the shared publish workflow");
  calledJob(agent.jobs["test-and-cross-compile"], "./.github/workflows/verify-agent.yml");

  const smoke = await readYaml(".github/workflows/arm-container-smoke.yml");
  assert.ok(Object.hasOwn(smoke.on, "pull_request"));
  assert.ok(Object.hasOwn(smoke.on, "workflow_call"));
  assert.ok(smoke.on.push?.paths?.includes("examples/raspberry-pi/**"));
  assert.ok(smoke.on.push?.paths?.includes("examples/agent/simulator/**"));
  assert.ok(!smoke.on.push?.paths?.includes("agent/**"));
  assert.ok(smoke.jobs.smoke.steps?.some((step) => step.run?.includes("prepare-smoke-image.test.sh")));

  const dependencyReview = await readYaml(".github/workflows/dependency-review.yml");
  assert.ok(Object.hasOwn(dependencyReview.on, "pull_request"));
  assert.deepEqual(dependencyReview.permissions, { contents: "read", "pull-requests": "read" });
  const dependencyAction = dependencyReview.jobs.review.steps?.[0];
  assert.match(dependencyAction?.uses ?? "", /^actions\/dependency-review-action@[a-f0-9]{40}/);
  assert.equal(dependencyAction?.with?.["fail-on-severity"], "high");

  const lint = await readYaml(".github/workflows/workflow-lint.yml");
  assert.ok(Object.hasOwn(lint.on, "pull_request"));
  assert.ok(lint.on.push?.paths?.includes(".github/workflows/**"));
  const lintCommand = lint.jobs.actionlint.steps?.find((step) => step.name?.includes("workflow syntax"));
  assert.ok(lintCommand);
  assert.match(lintCommand.run ?? "", /actionlint/);
});

test("dependency updates cover Go, npm, and container base images", async () => {
  const dependabot = await readYaml(".github/dependabot.yml");
  assert.ok(dependabot.updates?.some((update) =>
    update["package-ecosystem"] === "npm" && update.directory === "/workers/device-sync"));
  assert.ok(dependabot.updates?.some((update) =>
    update["package-ecosystem"] === "gomod" && update.directory === "/agent"));
  assert.ok(dependabot.updates?.some((update) =>
    update["package-ecosystem"] === "docker" && update.directory === "/agent"));

  const dockerfile = await readFile(new URL("../../../agent/Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /^FROM --platform=\$BUILDPLATFORM golang:\d+\.\d+\.\d+-alpine@sha256:[a-f0-9]{64} AS build$/m);
  assert.match(dockerfile, /^FROM gcr\.io\/distroless\/static-debian12:nonroot@sha256:[a-f0-9]{64}$/m);
});

test("worker and image release safeguards check current inputs before sensitive promotion", async () => {
  const worker = await readYaml(".github/workflows/device-sync.yml");
  const deploySteps = worker.jobs.deploy.steps ?? [];
  const freshnessIndex = deploySteps.findIndex((step) => step.name === "Check current Worker inputs");
  const migrationIndex = deploySteps.findIndex((step) => step.name === "Check production migration readiness");
  const deployIndex = deploySteps.findIndex((step) => step.name === "Deploy device-sync Worker");
  assert.ok(freshnessIndex < migrationIndex && migrationIndex < deployIndex);
  assert.equal(deploySteps[migrationIndex].env?.CLOUDFLARE_API_TOKEN, "${{ secrets.CLOUDFLARE_API_TOKEN }}");
  assert.ok(deploySteps.some((step) => step.name === "Check deployed Worker readiness" && step.run?.includes("/healthz")));

  const skills = await readFile(new URL(".github/skills/github-actions-release/SKILL.md", root), "utf8");
  assert.doesNotMatch(skills, /deploy-device-sync\.yml|docker-publish\.yml/);
  const smokeTest = await readFile(new URL("agent/scripts/tests/prepare-smoke-image.test.sh", root), "utf8");
  assert.match(smokeTest, /pull --platform/);
  assert.match(smokeTest, /buildx build/);
});

test("workflow caches include each pinned tool and Go module inputs", async () => {
  const cases = [
    ["verify-agent.yml", "golang.org/x/vuln/cmd/govulncheck@v1.1.4", "Check for known Go vulnerabilities"],
    ["workflow-lint.yml", "github.com/rhysd/actionlint/cmd/actionlint@v1.7.12", "Check workflow syntax and expressions"],
  ] as const;
  for (const [file, tool, validationStepName] of cases) {
    const workflow = await readYaml(`.github/workflows/${file}`);
    const setupGo = Object.values(workflow.jobs).flatMap((job) => job.steps ?? [])
      .find((step) => step.uses?.startsWith("actions/setup-go@"));
    assert.ok(setupGo);
    const cacheInputs = String(setupGo.with?.["cache-dependency-path"]).split(/\r?\n/)
      .map((input) => input.trim()).filter(Boolean);
    assert.ok(cacheInputs.includes("agent/go.mod"), `${file} cache includes Go module inputs`);
    assert.ok(cacheInputs.includes(`.github/workflows/${file}`), `${file} cache invalidates when its workflow changes`);
    const validationStep = Object.values(workflow.jobs).flatMap((job) => job.steps ?? [])
      .find((step) => step.name === validationStepName);
    assert.ok(validationStep, `${file} includes its validation step`);
    assert.ok(validationStep.run?.includes(tool), `${file} runs its pinned validation tool`);
  }
});
