# Ribbonfish Agent Skills

These focused instructions describe current repository workflows and implementation boundaries. The Go agent, authenticated device sync, and Access-protected management Worker/UI are implemented. Screenshot capture code is implemented but has not been deployed to production. DRM/KMS support is experimental: Pi 3 A+ single-display output has passed visible-frame acceptance; Pi 3B and Pi 4 dual-output acceptance remain open.

## Skills by domain

| Skill | Use it for |
| --- | --- |
| [go-agent-development](go-agent-development/SKILL.md) | Go agent behavior, package boundaries, configuration, sync, telemetry, and display output |
| [offline-playback-cache](offline-playback-cache/SKILL.md) | Persistent cache, playlist scheduling, simulator output, and offline behavior |
| [container-smoke-testing](container-smoke-testing/SKILL.md) | Go CI, ARM container smoke checks, and interpreting their evidence |
| [raspberry-pi-deployment](raspberry-pi-deployment/SKILL.md) | Simulator Compose, DRM/KMS setup, and physical hardware acceptance |
| [cloudflare-device-sync-enrollment](cloudflare-device-sync-enrollment/SKILL.md) | Device identity, enrollment approval, authenticated playlist sync, and health telemetry |
| [cloudflare-management-console](cloudflare-management-console/SKILL.md) | Access-protected management API/UI, operator authorization, and auditability |
| [cloudflare-worker-operations](cloudflare-worker-operations/SKILL.md) | Wrangler environments, D1 migrations, secrets, and Worker rollout |
| [cloudflare-asset-lifecycle](cloudflare-asset-lifecycle/SKILL.md) | Private R2 assets, D1 references, retention, and reconciliation |
| [cloudflare-capture-design](cloudflare-capture-design/SKILL.md) | Capture scheduling, publication constraints, implementation review, and future design |
| [device-contract-changes](device-contract-changes/SKILL.md) | Changes crossing the Go agent and Worker API/data boundary |
| [device-fleet-operations](device-fleet-operations/SKILL.md) | Enrollment approval, health triage, credential lifecycle, and device recovery |
| [github-actions-release](github-actions-release/SKILL.md) | CI workflows, protected deployment, and multi-architecture image publishing |

## Where to start

- Go-only behavior: start with **go-agent-development**; add **offline-playback-cache** for cache or playback changes.
- Agent/Worker protocol or schema changes: use **device-contract-changes** and the relevant implementation guides.
- Device identity, enrollment, and health endpoints: use **cloudflare-device-sync-enrollment**. For operator triage, use **device-fleet-operations**.
- Management UI/API changes: use **cloudflare-management-console**. For Worker configuration, migrations, and rollout, use **cloudflare-worker-operations**.
- Asset publication, deletion, or reconciliation: use **cloudflare-asset-lifecycle**.
- Capture implementation: use **cloudflare-capture-design** and the relevant Worker guides. Capture code exists but is not production-deployed.
- CI, image publishing, or workflow changes: use **github-actions-release**; use **container-smoke-testing** for simulator/ARM evidence.
- Pi deployment and physical display questions: use **raspberry-pi-deployment**. Keep QEMU/simulator results separate from hardware acceptance.

## Skill metadata and validation

Each skill has YAML frontmatter containing `name`, `description`, `tags`, and `relatedSkills`. The `name` matches its directory; related skill names refer to sibling skills. Local Markdown links should resolve within the checkout.

Run the repository check with:

```sh
node --test .github/scripts/tests/validate-skills.test.mjs
node .github/scripts/validate-skills.mjs
```

The validator checks required metadata, directory/name agreement, related-skill targets, and local links. See [Copilot repository instructions](../copilot-instructions.md) for shared project constraints.
