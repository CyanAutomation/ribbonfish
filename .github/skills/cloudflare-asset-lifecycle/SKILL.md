---
name: cloudflare-asset-lifecycle
description: Change Ribbonfish's private content-addressed R2 assets and D1 references while preserving playlist availability and safe reconciliation.
tags: [ribbonfish, cloudflare, r2, d1, assets, retention, reconciliation]
relatedSkills: [cloudflare-device-sync-enrollment, cloudflare-management-console, cloudflare-worker-operations, cloudflare-capture-design]
---

# Cloudflare Asset Lifecycle

Use this skill for `asset-store.js`, `asset-registry.js`, `asset-maintenance.js`, playlist asset references, upload/capture publication, retention, or reconciliation. R2 holds private content-addressed PNGs; D1 tracks playlist, capture, and asset references.

## Data safety invariants

- Address assets by verified content digest and validate image type, size, and digest before accepting or serving them.
- Keep R2 objects private. Authorize a device or operator before returning asset bytes; never make the bucket public to simplify delivery or previews.
- Do not remove an object while a current playlist, retained revision, holding image, active capture, or write lease still protects it.
- A new asset must be written and verified before D1 pointers or playlist references move to it. Preserve the last-known-good image when capture or publication fails.
- Treat D1 and R2 updates as a recoverable multi-step workflow, not a single atomic transaction. Operations must tolerate retries and interrupted writes/deletes.
- Capture history has an upper bound of 10 images per target and 30 days, whichever limit is reached first. Device cache limits are separate and must not be changed by capture retention work.

## Reconciliation and deletion

- Keep sweeps restartable and paginated. Persist cursors and use leases/claims so concurrent writers and cleanup cannot create dangling references or delete newly referenced content.
- Protect uploads and captures while writes and D1 reference updates are in progress. Apply documented staging and grace periods to untracked objects.
- Reconcile both directions: detect missing R2 objects referenced by D1 and orphaned R2 objects without live references. Repair or report according to the documented policy; do not silently rewrite immutable playlist revisions.
- Make deletes idempotent, bounded, and retryable. A failed R2 delete should remain visible for later cleanup.
- Keep active playlist assets and holding images available through cleanup. Verify the replacement exists before changing the active pointer.

## Tests and commands

From `workers/device-sync/`:

```sh
npm test
npm run check:config
```

Add tests for shared references, active-playlist protection, write/delete interruption, duplicate delivery, lease expiry, stale sweep cursors, missing objects, delayed orphan cleanup, and retry after R2 errors. Use Wrangler's local D1/R2 emulation for development; verify production migration and bucket assumptions separately.

## References

- [Asset, retention, and reconciliation behavior](../../../workers/device-sync/README.md)
- [Capture publication and retention](../cloudflare-capture-design/SKILL.md)
- [Device authorization for asset reads](../cloudflare-device-sync-enrollment/SKILL.md)
- [Migration and rollout sequence](../cloudflare-worker-operations/SKILL.md)
