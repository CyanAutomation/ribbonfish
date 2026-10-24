---
name: cloudflare-capture-design
description: Design future Ribbonfish Cloudflare capture and scheduling services while preserving serial execution, quota, retention, and security constraints.
tags: [ribbonfish, cloudflare, architecture, scheduling, capture]
relatedSkills: [raspberry-pi-deployment, go-agent-development]
---

# Cloudflare Capture Design

Use this skill only when planning or implementing the proposed control plane, scheduler, renderer, queues, or screenshot publication flow. These services are not currently implemented in this repository. Confirm current Cloudflare product limits and API behavior before treating proposal details as provider guarantees.

## Non-negotiable architecture constraints

- Enforce a minimum screenshot capture interval of 60 seconds at every input boundary. Capture cadence is best-effort, not a real-time freshness guarantee.
- Keep the clocks separate: capture interval, local playlist rotation, and device sync interval are independent settings. The 60-second minimum applies only to screenshot capture.
- Allow at most one Ribbonfish capture to execute at a time across the deployment. Route scheduled, manual, and retry work through one Queue consumer with batch size and concurrency set to one; await the complete capture and publication flow before acknowledging.
- Do not rely on Queue configuration alone. Use deduplication, idempotency, D1-backed leases/ownership checks, and safe handling of duplicate delivery or lease expiry to prevent overlapping browser work.
- Durable Objects are out of scope for scheduling, presence, push commands, or display coordination. Do not introduce sub-minute timers or delayed-message loops.
- Coalesce due work so that each render variant has at most one queued or running capture. Bound pending age, queue depth, retries, and backoff; do not let a failed variant block all others indefinitely.
- Keep Browser Sessions creation limits, Quick Actions request limits, and daily browser-time budgets as distinct controls. Serial concurrency does not bypass account-wide rate or usage limits. Defer or skip work when exhausted; do not retry quota failures in a tight loop.
- Publish immutable versioned screenshots, update metadata/pointers only after the new object is verified, then enforce retention at no more than 10 captures per variant and no older than 30 days, whichever limit is reached first.
- Scope render-variant reuse to matching rendering inputs and authorization scope. Protect private screenshots and credentials; allow-list render targets and block private-network and metadata-service SSRF paths.

## Workflow shape

1. A once-per-minute Cron dispatcher reads due variants and atomically claims eligible work.
2. It deduplicates/coalesces work and enqueues a bounded message; it does not call Browser Run directly.
3. The single Queue consumer checks lease ownership, timeouts, quotas, and remaining budget.
4. It awaits rendering, validates output, writes the versioned R2 object, updates D1 state, and applies retention in a recoverable order.
5. Failures preserve the last-known-good image, record stale age and cause, and use bounded retries only for transient errors.

Record operational signals for queue depth, capture duration, last successful capture age, deferred/skipped work, budget remaining, and provider rate-limit responses. Size capacity from aggregate render time and budget; a one-slot queue can make nominal 60-second schedules late.

## References

- [Repository architecture and capture policy](../../../README.md)
- [Copilot project constraints](../../copilot-instructions.md)
- [Current implementation status](../../../docs/agent-foundation.md)
