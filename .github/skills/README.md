# Ribbonfish Agent Skills

This directory contains focused guidance for working in the Ribbonfish repository. The Go agent, authenticated device sync, and Cloudflare Access-protected production management UI/API are implemented. Local management development uses Wrangler's D1/R2 emulators. Screenshot capture remains proposed, and physical DRM/KMS output is only partially validated.

## Skills by domain

| Skill | Use it for |
| --- | --- |
| [go-agent-development](go-agent-development/SKILL.md) | Changes to the local Go agent, its package boundaries, configuration, and lifecycle |
| [offline-playback-cache](offline-playback-cache/SKILL.md) | Cache, playlist, simulator, and offline playback behavior |
| [container-smoke-testing](container-smoke-testing/SKILL.md) | Go CI, ARM container smoke checks, and interpreting what those checks prove |
| [raspberry-pi-deployment](raspberry-pi-deployment/SKILL.md) | Simulator Compose use and review of the future Pi hardware template |
| [cloudflare-capture-design](cloudflare-capture-design/SKILL.md) | Future control-plane and screenshot-capture design work |

## Where to start

- A Go behavior change: start with **go-agent-development**; use **offline-playback-cache** when cache or scheduling is involved.
- A CI or container failure: start with **container-smoke-testing**.
- A Pi setup or DRM question: start with **raspberry-pi-deployment** and keep simulator evidence separate from hardware acceptance.
- Cloudflare scheduling or capture design: start with **cloudflare-capture-design**. Its guidance describes proposed architecture, not implemented services.

## Skill metadata

Each `SKILL.md` has YAML frontmatter with `name`, `description`, `tags`, and `relatedSkills`. Skill names match their directory names; related skill links point to sibling `SKILL.md` files.
