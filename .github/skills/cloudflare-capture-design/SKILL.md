---
name: cloudflare-capture-design
description: Implement, review, or plan Ribbonfish Cloudflare screenshot capture and scheduling while preserving serial execution, quota, retention, and security constraints.
tags: [ribbonfish, cloudflare, workers, architecture, scheduling, capture]
relatedSkills: [cloudflare-worker-operations, cloudflare-management-console, cloudflare-asset-lifecycle]
---

# Cloudflare Capture Design

Use this skill when implementing, reviewing, or planning the management Worker's screenshot scheduler, Browser Run Quick Actions, queues, or capture publication flow. Capture code is implemented but has not been deployed to production; production activation requires prerequisites documented in the Worker guide. Device sync and the Access-protected management UI/API are implemented separately. Confirm current Cloudflare product limits and API behavior before treating configured limits as provider guarantees.

## Non-negotiable architecture constraints

- Enforce a minimum screenshot capture interval of 60 seconds at every input boundary. Capture cadence is best-effort, not a real-time freshness guarantee.
- Keep the clocks separate: capture interval, local playlist rotation, and device sync interval are independent settings. The 60-second minimum applies only to screenshot capture.
- Allow at most one Ribbonfish capture to execute at a time across the deployment. Route scheduled, manual, and retry work through one Queue consumer with batch size and concurrency set to one; await the complete capture and publication flow before acknowledging.
- Do not rely on Queue configuration alone. Use deduplication, idempotency, D1-backed leases/ownership checks, and safe handling of duplicate delivery or lease expiry to prevent overlapping browser work.
- Durable Objects are out of scope for scheduling, presence, push commands, or display coordination. Do not introduce sub-minute timers or delayed-message loops.
- Coalesce due work so that each current capture target has at most one queued or running capture. Bound pending age, queue depth, retries, and backoff; do not let a failed target block all others indefinitely.
- The current implementation uses Quick Actions. Keep its request spacing/rate limits and daily browser-time budget distinct; serial concurrency does not bypass account-wide usage limits. If persistent Browser Sessions are introduced later, model their quotas separately. Defer or skip work when exhausted; do not retry quota failures in a tight loop.
- Publish immutable content-addressed PNGs, update playlist capture state only after the new object is verified, then enforce retention at no more than 10 images per target and no older than 30 days, whichever limit is reached first.
- Scope render-variant reuse to matching rendering inputs and authorization scope. Protect private screenshots and credentials; allow-list render targets and block private-network and metadata-service SSRF paths.

## Workflow shape

1. A once-per-minute Cron dispatcher reads due variants and atomically claims eligible work.
2. It deduplicates/coalesces work and enqueues a bounded message; it does not call Browser Run directly.
3. The single Queue consumer checks lease ownership, timeouts, quotas, and remaining budget.
4. It awaits rendering, validates output, writes the versioned R2 object, updates D1 state, and applies retention in a recoverable order.
5. Failures preserve the last-known-good image, record stale age and cause, and use bounded retries only for transient errors.

Record operational signals for queue depth, capture duration, last successful capture age, deferred/skipped work, budget remaining, and provider rate-limit responses. Size capacity from aggregate render time and budget; a one-slot queue can make nominal 60-second schedules late.

## Current implementation and checks

The application models reusable URL/viewport capture targets; it does not implement the broader authenticated render-variant model described in some architecture notes. Capture target validation, interval validation, scheduling state, queue processing, publication, retention, and reconciliation live under `workers/device-sync/src/` and are covered by the Worker test suite. From `workers/device-sync/`, run:

```sh
npm test
npm run check:config
```

Review `capture.test.js`, `capture-workflow.test.js`, and the asset maintenance tests when changing those paths. Local Wrangler development uses local D1/R2 but may invoke the remote Browser binding, which consumes the configured account's usage. Do not enable production capture until the required queues, migrations, host allowlist, Browser binding, and quota checks are in place.

## References

- [Repository architecture and capture policy](../../../README.md)
- [Copilot project constraints](../../copilot-instructions.md)
- [Worker implementation and production prerequisites](../../../workers/device-sync/README.md)
- [Current implementation status](../../../README.md)
