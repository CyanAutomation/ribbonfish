---
name: cloudflare-device-sync-enrollment
description: Implement or diagnose Ribbonfish device identity, enrollment approval, authenticated playlist sync, and bounded health telemetry.
tags: [ribbonfish, cloudflare, workers, device-sync, enrollment, authentication]
relatedSkills: [cloudflare-management-console, cloudflare-worker-operations, cloudflare-asset-lifecycle]
---

# Cloudflare Device Sync and Enrollment

Use this skill for `workers/device-sync/src/index.js`, device enrollment and authentication, playlist delivery, asset authorization, or `/v1/telemetry` changes. The device-sync Worker is a separate production entry point from the management Worker; its admin routes must remain disabled.

## Identity and enrollment invariants

- Device sync is authenticated per device. Preserve legacy token support only where compatibility requires it; new devices use a device-held private key and submit a signed enrollment request.
- A pending enrollment does not grant playlist or asset access. An operator must approve the exact pending public key through the management path.
- Keep private keys and legacy tokens out of D1, responses, logs, audit metadata, and screenshots. Store only the approved public key or a verifier/hash for legacy credentials.
- Approval, rejection, disablement, and credential rotation must be authenticated, auditable, and scoped to the target device/request.
- The globally active playlist is shared by enrolled devices. Device display profiles remain local; do not introduce per-device playlist assignment without changing the documented contract.

## Sync contract

- Snapshots are versioned and contain ordered asset digests and sizes, not arbitrary URLs or local paths.
- Keep asset reads private and authenticated. Validate the requesting device and its access to the requested digest before returning content.
- Preserve conditional requests and size limits. A failed, malformed, or incomplete candidate must not replace the last-good snapshot.
- Telemetry is schema-versioned, size-bounded, and uses fixed error codes. Do not accept logs, raw errors, credentials, or unbounded device supplied strings as health data.
- Keep telemetry and health-history retention bounded; avoid exposing one device's state to another device.

## Development and validation

From `workers/device-sync/`:

```sh
npm ci
npm test
npm run check:config
```

Add route and authorization tests beside the implementation. Cover missing, malformed, expired, revoked, and wrong-device credentials; pending versus approved enrollment; replay or duplicate requests; unauthorized asset access; oversized or invalid snapshots; telemetry schema limits; and failure preserving the previous active state. Use local Wrangler D1/R2 emulation for end-to-end development; it does not exercise production data.

Before changing a database contract, inspect `schema.sql`, ordered migration files, migration-ledger tests, and the Worker API documentation. Production migrations are applied separately; see [Cloudflare Worker Operations](../cloudflare-worker-operations/SKILL.md).

## References

- [Worker API and operational guide](../../../workers/device-sync/README.md)
- [Go agent architecture and sync contract](../../../docs/agent-foundation.md)
- [Management authorization](../cloudflare-management-console/SKILL.md)
- [Asset lifecycle](../cloudflare-asset-lifecycle/SKILL.md)
