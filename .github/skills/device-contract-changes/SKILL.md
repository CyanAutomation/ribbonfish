---
name: device-contract-changes
description: Change Ribbonfish device enrollment, authentication, playlist, asset, or telemetry contracts across the Go agent and Cloudflare Worker.
tags: [ribbonfish, api, contracts, compatibility, go, cloudflare]
relatedSkills: [go-agent-development, cloudflare-device-sync-enrollment, cloudflare-worker-operations, device-fleet-operations]
---

# Device Contract Changes

Use this skill when a change crosses the agent/Worker boundary or changes persisted playlist, enrollment, asset, or telemetry data.

## Contract map

- Agent behavior and bundled profiles: `agent/internal/config`, `agent/internal/syncer`, `agent/internal/health`, and `agent/internal/agent`.
- Worker device routes and persistence: `workers/device-sync/src/index.js` plus the focused modules and tests under `workers/device-sync/src/`.
- Management and operational API details: [`workers/device-sync/README.md`](../../../workers/device-sync/README.md).
- D1 schema: `workers/device-sync/schema.sql` and ordered migrations under `workers/device-sync/migrations/`.

## Change both sides deliberately

- Write down the compatibility behavior before changing fields, status codes, authentication proofs, playlist revisions, ETags, or error codes.
- Keep request and response validation bounded and versioned. Preserve maximum body sizes, stable error codes, and explicit authorization checks.
- Add Worker tests for accepted and rejected requests, and Go tests for parsing, verification, persistence, and failure recovery. Add cross-component fixtures or examples when a field must agree exactly.
- For D1 changes, add a migration, update `schema.sql` for new local databases, and verify existing rows remain readable during rollout. Production deploy automation does not apply migrations.
- Keep device private keys on-device; the Worker stores only approved public keys. Do not expose token values, raw keys, or raw telemetry errors in management responses or audit records.
- Preserve conditional playlist polling and content-addressed asset integrity. A failed update must leave the last-good snapshot available.

## Verification

Run the focused Go tests and `cd workers/device-sync && npm test && npm run check:config`. For full Go verification and CI boundaries, see [Go Agent Development](../go-agent-development/SKILL.md) and [Container Smoke Testing](../container-smoke-testing/SKILL.md).

## References

- [Worker API and schema documentation](../../../workers/device-sync/README.md)
- [Agent foundation](../../../docs/agent-foundation.md)
- [Cloudflare Device Sync and Enrollment](../cloudflare-device-sync-enrollment/SKILL.md)
- [Cloudflare Worker Operations](../cloudflare-worker-operations/SKILL.md)
