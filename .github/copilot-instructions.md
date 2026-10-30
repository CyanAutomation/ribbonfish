# Copilot Instructions for Ribbonfish

## Project Overview

**Ribbonfish** is a Cloudflare-native platform for centrally managing information-only screens on lightweight Linux devices (primarily Raspberry Pi 3B/4). It renders websites remotely, distributes versioned screenshots, and displays them through Linux DRM/KMS without requiring a browser or desktop environment on the device.

**Status:** The repository includes the Go agent, authenticated Cloudflare device sync and enrollment, and a production playlist/device management UI and API protected by Cloudflare Access. The device-sync Worker keeps management routes disabled. Local console work uses Wrangler's local D1/R2 emulation; no public development Worker is deployed. Capture scheduling and rendering code is implemented in the management Worker but has not been deployed; production queues and D1 migrations must be prepared first. DRM/KMS is experimental and physically validated on one Pi 3 A Plus; Pi 3B and Pi 4 dual-output remain unverified.

## Key Architectural Principles

### Core Constraint: Serial Capture Execution
- **At most one screenshot capture executes at any moment** across the entire deployment
- All captures pass through a single Cloudflare Queue with `max_concurrency: 1`
- Minimum supported capture interval: **60 seconds** (enforced at API and validation boundaries)
- Device count should not multiply rendering work; assets are safely shared across devices

### Three Independent Clocks
1. **Capture Interval:** How often Cloudflare creates a fresh screenshot (min. 60s)
2. **Rotation Duration:** How long an image displays before advancing to the next item
3. **Device Sync Interval:** How frequently the agent checks for config updates and new manifests

These are independent settings; devices can rotate between cached images every 20s even if captures run daily.

### Screenshot Retention Policy
- **Hard limit:** Max 10 most recent captures per render variant
- **Time limit:** Never retain older than 30 days
- Whichever limit is reached first applies
- Retention is enforced in capture workflow + periodic reconciliation (not R2 lifecycle rules alone)

## Repository Structure

This is a **proposed monorepo layout** for the full implementation (not yet in place):

```
/
├── apps/
│   ├── control-plane/      # Cloudflare Worker API + management UI
│   └── renderer/           # Browser Run integration for screenshot capture
├── agent/                  # Go device agent + DRM/KMS display backends
├── packages/
│   └── contracts/          # API schemas, versioned manifests, type definitions
├── infrastructure/         # Wrangler config, D1 schema, Queue setup
├── docs/                   # Architecture docs, security policies, operations guides, ADRs
├── tests/                  # Contract, integration, system tests
├── examples/               # Docker Compose templates, config examples
└── README.md
```

Current state: the Go agent and device-sync Worker are implemented. The production management API supports playlist revisions, key-based enrollment approval, device controls, legacy token rotation, audit events, and asset health behind Cloudflare Access. Capture scheduling and rendering code is present but not deployed. The DRM/KMS backend still needs Pi 3B and Pi 4 dual-output acceptance.

## Cloudflare Services and Responsibilities

| Service | Role |
|---------|------|
| **Workers** | Authenticated device endpoints and an Access-protected production management API/UI; capture code is implemented but not deployed |
| **D1** | Playlists, devices, enrollment, telemetry, audit events, capture state, and asset reconciliation metadata |
| **Browser Run** | Quick Action capture integration in the management Worker; production use awaits operational prerequisites |
| **R2** | Private content-addressed PNG assets for uploads and captures; capture retention and reconciliation are implemented in code |
| **Queues** | Single-consumer, single-message capture execution with bounded retries |
| **Cron (Scheduled Worker)** | Runs every minute; enqueues deduplicated due-variant captures from D1 |

**Key point:** Queue consumer concurrency is the primary serialization control; application logic must also prevent concurrent Browser Run invocations via idempotency, job leases, and ownership checks in D1.

## Capture Workflow and Budget Controls

1. Cron trigger queries D1 for due variants
2. Dispatcher atomically claims eligible jobs and enqueues them
3. Coalesce already queued/running variants (one per variant max)
4. Check **daily browser-time budget** before starting captures
5. Queue consumer processes one message, awaits full browser capture → R2 publication → manifest update
6. On success: write immutable versioned screenshot, update D1 metadata, prune to 10-capture max, then cleanup 30-day-old captures
7. On failure: preserve last-known-good image, apply bounded retries + exponential backoff, distinguish transient vs. terminal errors

**Budget enforcement:**
- Define configurable daily browser-time budget in D1
- Track Browser Sessions creation rate limits and Quick Actions request limits separately (different Cloudflare APIs)
- When budget/quota exhausted: defer work until reset, **do not retry in a tight loop**, surface stale-image age
- Track queue depth, capture duration, time since last successful screenshot, skipped/deferred captures, remaining budget

## Optional JEV Adaptive Scheduling (Future Experiment)

The JEV decision engine sits **after hard eligibility checks and before the serial queue**:
```
Cron + D1 due → rule checks/cache probes → optional JEV → serial Queue → Browser Run → R2
```

- **Inputs:** compact operational data (not images by default), capture history, prior durations, recent failures, cached-image age, budget/queue state
- **Outputs:** typed decision schema (`retry`, `defer`, `use_cache`, `escalate`) with validation and strict timeouts
- **Constraints:** JEV never bypasses the global one-at-a-time queue, 60s minimum, retention limits, authz boundaries, or daily budget
- **Fallback:** Fail open to deterministic scheduling if JEV unavailable
- **Data safety:** Prefer metadata-only decisions; explicit opt-in before sending authenticated/private dashboard pixels
- **Delivery:** Direct guarded integration (no shadow mode); feature flag/kill switch; measure browser seconds per 1,000 opportunities

Do not proceed with JEV until deterministic foundation (budget, coalescing, freshness timestamps, retries) is solid.

## Render Variants

A **site** is a URL; a **render variant** is a specific screenshot contract for that site. Variants can differ in:
- Viewport dimensions
- Authentication context
- Wait policy (e.g., network-idle-or-timeout, selector-or-timeout)
- Image format
- Capture cadence

Variants are **keyed by rendering inputs + access permissions**; reuse across displays is allowed only when inputs and auth scope match. Playlists reference variants, not sites.

## Device Software

### Deployment Model
- **Default:** Docker Compose on Raspberry Pi OS Lite (no desktop, Chromium, X11, Wayland)
- **Images:** Protected `main` pushes that change `agent/**` publish `cyanautomation/ribbonfish` to Docker Hub for AMD64, ARM64, and ARMv7 with an immutable `sha-<SHA>` tag; GHCR receives ARMv7 and ARM64 images with `main` and `sha-<SHA>` tags
- **Releases:** GitHub Releases and version tags remain manually managed through the GitHub UI; image publishing follows relevant changes to protected `main`
- **Updates:** Docker Hub's `latest` tag moves only when the published commit is still the `main` tip; pin an immutable SHA tag or digest for repeatable deployments and rollback

### Agent Responsibilities
1. Identify available DRM/KMS connectors, supported modes, output identities
2. Authenticate to control plane; retrieve versioned configuration
3. Download changed screenshots with integrity checks and atomic cache replacement
4. Decode and present images through DRM/KMS display backend (no X11, Wayland, Chromium)
5. Independently rotate playlists on each physical output
6. Report bounded health telemetry and recover after reboot/disconnection

### Key Constraints
- **No `privileged: true`** as production default
- Minimal required DRM/KMS device mappings (typically `/dev/dri/card*`)
- **DRM master ownership inside containers not yet proven** for Pi 4 dual-HDMI
- Mount only required device nodes; grant minimum graphics permissions
- Atomic cache operations; interrupted downloads must never replace valid images
- Continue using last-known-good config/cached images during Cloudflare/network outages

### Offline Capability
- Display last-known-good content indefinitely when disconnected
- Expose configurable stale-content indicator
- Resume sync without blanking display on reconnection
- Fallback image/status screen for missing initial content

## Security Principles

- Per-device identities, TLS transport, credential rotation and revocation
- Per-device authorization is implemented. Production administration is protected by Cloudflare Access plus a Worker-side email allowlist; the device-sync Worker keeps admin routes disabled.
- No secrets in screenshots, configs, logs, or repository history
- Allow-listed render targets; SSRF protection (private networks, metadata endpoints)
- Isolate credentials for protected pages; no credential reuse across unrelated scopes
- Authenticated/narrowly-scoped R2 delivery (not public by default)
- Validate image dimensions, formats, sizes, and hashes before decoding on device
- Minimal privileges for agent; document DRM permissions and container hardening
- Signed, reproducible release artifacts with releases and version tags managed manually through the GitHub UI; explicit update/rollback strategy
- Prevent command replay; no unapproved software updates
- Devices cannot access other devices' protected assets

## Testing and Validation

**Hardware acceptance criteria for Phase 0:**
- [ ] Container displays local PNG via DRM/KMS on Pi 3B
- [ ] Different images display simultaneously on both Pi 4 HDMI outputs
- [ ] Least-privilege graphics access validated
- [ ] Scaling, aspect ratio, rotation, hotplug, monitor sleep/wake tested
- [ ] Power loss, restart, offline caching verified
- [ ] CPU, RAM, image-switch latency measured
- [ ] Cache persistence, network loss, Cloudflare failure scenarios tested
- [ ] Malformed images, failed captures, low disk space handled gracefully
- [ ] Mixed monitor resolutions and dual-output operation proven

The ARM container smoke workflow under `.github/workflows/arm-container-smoke.yml`
builds and runs the ARMv7 single-display and ARM64 dual-display simulator
profiles under QEMU. This verifies container architecture and startup behavior;
it does not satisfy physical hardware acceptance criteria.

**Cost modeling:** Actual browser time per capture × capture frequency × daily captures = daily browser-minute usage. **One-at-a-time execution controls concurrency, not total daily usage.** Example: one variant captured every 60s = 1,440 captures/day; 1s per capture = 24 browser-minutes/day. Validate against current Cloudflare plan limits before claiming Free-plan compatibility.

## Documentation Priorities

1. **ADRs (Architecture Decision Records):** Record constraints (serial capture, 60s minimum, retention policy), trade-offs, and reasoning
2. **API contracts:** Worker endpoint schemas, D1 schema, Queue message format, device manifest format
3. **Operations guide:** Fleet management, device provisioning, credential rotation, troubleshooting
4. **Security policy:** Threat model, allowed render targets, secrets management, audit logging
5. **Deployment template updates:** Reflect validated hardware, DRM permissions, multi-output behavior as PoC proves feasibility

## Common Patterns and Anti-Patterns

### ✓ DO
- Enforce 60-second minimum in input validation (API boundaries, config upload)
- Coalesce due captures per variant; deduplicate before queuing
- Persist last-known-good image; surface its age and stale-content status to users
- Use D1 scheduling state + atomic claims to avoid duplicate work across Cron retries
- Model distinct Cloudflare API quotas (Browser Sessions, Quick Actions) separately
- Test boundary conditions: network loss, quota exhaustion, image validation failures

### ✗ DON'T
- Don't use sub-minute timers, delayed-message loops, or Durable Objects for scheduling
- Don't assume one-at-a-time Queue concurrency bypasses Browser Sessions or Quick Actions rate limits
- Don't send protected screenshot pixels to JEV without explicit opt-in
- Don't delete current manifest pointers before verifying replacement writes to R2
- Don't commit secrets, device tokens, or screenshot content to the repository

## Repository skills

Use the focused guides under [`.github/skills`](skills/README.md) for agent development, device sync and enrollment, management, worker operations, asset lifecycle, capture workflows, and Pi deployment.

## Links

- **Architecture:** `/README.md` (comprehensive design doc with constraints, workflows, hardware criteria)
- **Deployment template:** `/examples/raspberry-pi/` (Docker Compose proof of concept)
- **Current status:** Device sync and Access-protected production management controls are implemented; screenshot capture remains proposed
