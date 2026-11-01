---
name: github-actions-release
description: Maintain Ribbonfish CI, protected-branch deployment, and multi-architecture agent image publishing workflows.
tags: [ribbonfish, github-actions, ci, release, docker, supply-chain]
relatedSkills: [container-smoke-testing, cloudflare-worker-operations, raspberry-pi-deployment]
---

# GitHub Actions and Image Publishing

Use this skill for changes to `.github/workflows/`, CI triggers, deployment automation, or container image tags.

## Workflow map

- `agent.yml` runs Go checks for agent changes and pull requests.
- `arm-container-smoke.yml` validates Compose and runs simulator profiles in ARM containers; it is not physical hardware acceptance.
- `device-sync.yml` builds admin assets, tests the Worker, and dry-runs both Worker configurations.
- `deploy-device-sync.yml` validates and then deploys both Workers and publishes the management panel on protected `main` pushes matching its path filter. It checks migration readiness but does not apply D1 migrations.
- `publish-agent.yml` calls `verify-agent.yml`, and the ARM smoke workflow, then publishes ARM images to GHCR on protected `main` pushes affecting `agent/**`.
- `docker-publish.yml` handles Docker Hub multi-architecture publication and latest-tag promotion.
- `workflow-lint.yml` runs actionlint on workflow changes.

## Workflow change checklist

- Keep workflows least-privilege (`contents: read` by default); grant package-write or deployment secrets only to the job that needs them.
- Pin third-party actions to full commit SHAs and retain a readable version comment.
- Keep pull-request validation available independently of production credentials. Do not execute untrusted PR code in a job with deploy secrets.
- Update `paths` filters whenever a required source/config input changes, and ensure the validation workflow reports on every PR if it is a required check.
- Keep production deployment behind the protected default branch and serialize deploy/publish jobs that mutate shared production state or tags.
- Preserve immutable SHA image tags. Promote moving tags only after checking that the published agent tree still matches current `main`.
- Run actionlint and the relevant called workflow checks. Report QEMU and simulator evidence as container compatibility, never as DRM/KMS hardware validation.

## References

- [Cloudflare Worker operations](../cloudflare-worker-operations/SKILL.md)
- [Container smoke testing](../container-smoke-testing/SKILL.md)
- [Agent image workflows](../../workflows/publish-agent.yml)
