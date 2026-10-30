# Ribbonfish Agent Skills

Focused guidance for working in the Ribbonfish repository. The Go agent, authenticated device sync, and Cloudflare Access-protected production management UI/API are implemented. Capture scheduling and rendering code is present in the management Worker but has not been deployed; follow the rollout prerequisites in the Worker guide. DRM/KMS output is experimental and has been physically validated on one Pi 3 A Plus.

## Skills by domain

| Skill | Use it for |
| --- | --- |
| [go-agent-development](go-agent-development/SKILL.md) | Changes to the Go agent, including configuration, synchronization, and display backends |
| [offline-playback-cache](offline-playback-cache/SKILL.md) | Cache, playlist scheduling, simulator, and offline playback behavior |
| [container-smoke-testing](container-smoke-testing/SKILL.md) | Go CI, ARM container smoke checks, and interpreting what those checks prove |
| [raspberry-pi-deployment](raspberry-pi-deployment/SKILL.md) | Simulator use, Compose deployment, DRM/KMS setup, and hardware acceptance |
| [cloudflare-device-sync-enrollment](cloudflare-device-sync-enrollment/SKILL.md) | Device authentication, enrollment, playlist sync, and health telemetry |
| [cloudflare-management-console](cloudflare-management-console/SKILL.md) | Access-protected operator API/UI, playlist management, and local console development |
| [cloudflare-worker-operations](cloudflare-worker-operations/SKILL.md) | Wrangler environments, D1 migrations, secrets, deployment, and production rollout |
| [cloudflare-asset-lifecycle](cloudflare-asset-lifecycle/SKILL.md) | Private R2 assets, D1 references, retention, and reconciliation |
| [cloudflare-capture-design](cloudflare-capture-design/SKILL.md) | Capture workflow implementation, constraints, and production-readiness review |

## Where to start

- A Go behavior change: start with **go-agent-development**; use **offline-playback-cache** when cache or scheduling is involved.
- A CI or container failure: start with **container-smoke-testing**.
- A Pi setup or DRM question: start with **raspberry-pi-deployment** and keep simulator, emulation, and physical-device evidence distinct.
- Device identity, enrollment, or sync: start with **cloudflare-device-sync-enrollment**.
- Operator UI/API behavior: start with **cloudflare-management-console**.
- Worker configuration, migrations, or release sequencing: start with **cloudflare-worker-operations**.
- D1/R2 consistency or object deletion: start with **cloudflare-asset-lifecycle**.
- Browser capture or scheduling: start with **cloudflare-capture-design** and consult Worker operations before production enablement.

## Skill metadata

Each `SKILL.md` has YAML frontmatter with `name`, `description`, `tags`, and `relatedSkills`. Skill names match their directory names; related skill names link to sibling `SKILL.md` files.
