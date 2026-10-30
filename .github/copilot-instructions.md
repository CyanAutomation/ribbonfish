# Copilot Instructions for Ribbonfish

## Project and implementation status

Ribbonfish manages information-only screens on lightweight Linux devices. The Go agent displays locally cached or synchronized images through a simulator or experimental Linux DRM/KMS output. Cloudflare Workers provide authenticated device sync and an Access-protected management UI/API.

- The Go agent, enrollment/sync, telemetry, management API/UI, and screenshot capture implementation are present in the repository.
- Screenshot capture code is **not deployed to production**. Production capture requires queues, D1 migrations, Browser Run access/quotas, and an exact capture hostname allowlist.
- The management Worker is configured for production with Cloudflare Access and `ADMIN_ALLOWED_EMAILS`; the device-sync Worker keeps admin routes disabled. Local management development uses Wrangler's local D1/R2 emulation. There is no public development Worker.
- DRM/KMS is experimental. Single-display 1080p output has been visibly confirmed on a Pi 3 A+. Pi 3B and Pi 4 dual-output acceptance remain open.
- Read the repository README, [agent foundation](../docs/agent-foundation.md), and [Worker README](../workers/device-sync/README.md) for current details. When status differs, report **implemented**, **production-deployed**, and **hardware-validated** separately.

## Repository map

| Path | Responsibility |
| --- | --- |
| `agent/` | Go device agent, profiles, cache, sync, telemetry, simulator, and DRM/KMS backend |
| `workers/device-sync/` | Device and management Workers, D1 schema/migrations, R2 asset handling, capture pipeline, UI, and tests |
| `examples/` | Simulator and Raspberry Pi deployment examples |
| `docs/` | Agent architecture and validation notes |
| `.github/skills/` | Focused implementation and operations guidance |
| `.github/workflows/` | Go, Worker, container, deployment, and image publication workflows |

## Architecture constraints

### Capture and scheduling

- Capture interval, local playlist rotation, and device sync interval are independent clocks. The 60-second minimum applies to capture only.
- Reject capture intervals below 60 seconds at validation boundaries. Retain no more than 10 capture images per target and no older than 30 days; enforce both limits in application cleanup, not R2 lifecycle rules alone.
- Capture requests use the single Queue consumer and bounded, coalesced jobs. Preserve serialization, idempotency/lease checks, bounded retries, quota handling, and last-known-good images.
- Capture intervals are best-effort, not a freshness guarantee. The production capture path is not enabled until its infrastructure and security prerequisites are verified.
- Keep Browser Run request limits, daily application budget, and any provider quota distinct. Do not retry quota deferrals in a tight loop.
- Durable Objects and sub-minute timers/delayed-message loops are out of scope for scheduling, presence, push commands, and display coordination.
- Capture targets require exact-host allowlisting and URL validation. Revalidate before Browser Run. The Worker cannot by itself constrain redirects and browser subresource requests; confirm network-level protections before enabling production capture.
- JEV is a future experiment, not a current dependency. Do not add it until deterministic scheduling, budgets, coalescing, freshness, and retry behavior are stable; any future decision path must not bypass capture limits or send private screenshot pixels without explicit opt-in.

### Device and playback

- Devices use authenticated sync with per-device authorization; key-based enrollment stores the public key in the Worker and keeps the private key on-device.
- Preserve verified local content and the last-good playlist through network, parsing, and storage failures. Keep API, cache, and device telemetry bodies bounded.
- A device's state volume contains cache, last-good state, and device identity. Avoid recovery steps that delete it unless data loss is intended.
- Keep output access least-privileged. Do not use `privileged: true` as a shortcut; map only needed DRM nodes and numeric groups.
- Sysfs display inspection, Compose validation, QEMU, and simulator output do not prove DRM master acquisition, modesetting, or physical scanout.

### Data and UI

- Playlist revisions are immutable; activation points to an existing revision. Validate uploaded and captured PNGs through the shared content-addressed asset path.
- Keep private assets scoped to authorized active-playlist references. Do not expose device secrets, private keys, or raw telemetry errors in responses or audit metadata.
- Do not commit credentials, device tokens, private keys, screenshots, or generated runtime output. Validate image size, format, dimensions, and digest before installing or decoding content.
- Production management requests require both Cloudflare Access and the Worker email allowlist. Local Access bypasses are local-only.
- D1 production migrations are not applied by the deploy workflow. Add a migration and update `schema.sql` for fresh local databases; apply required production migrations before merging dependent code.

## Validation and changes

- Go changes: run focused tests, then `cd agent && go test ./...`, `go test -race ./...`, `go vet ./...`, and formatting checks as applicable.
- Worker changes: from `workers/device-sync/`, run `npm ci`, `npm test`, `npm run build:admin` for panel changes, and `npm run check:config`.
- Workflow changes: run actionlint; keep third-party actions pinned to full commit SHAs and permissions least-privileged.
- Skill changes: run `node --test .github/scripts/tests/validate-skills.test.mjs` and `node .github/scripts/validate-skills.mjs`.
- Do not describe simulator or emulation checks as hardware acceptance. For actual Pi results, record model, OS/kernel, connector/mode, permissions, and observed output.

Use the focused guides in `.github/skills/` for domain workflows. Use `cloudflare-device-sync-enrollment` for device endpoints, `cloudflare-management-console` for admin UI/API changes, `cloudflare-worker-operations` for migrations and rollout, and `cloudflare-asset-lifecycle` for R2/D1 asset consistency. Use `device-contract-changes` when a change crosses the Go/Worker boundary, `device-fleet-operations` for enrollment and incident triage, and `github-actions-release` for CI or image publication.
