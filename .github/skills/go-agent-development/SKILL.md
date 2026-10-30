---
name: go-agent-development
description: Implement and review Ribbonfish's Go device agent, authenticated synchronization, health reporting, and simulator or DRM/KMS output.
tags: [ribbonfish, go, agent, architecture]
relatedSkills: [offline-playback-cache, container-smoke-testing, raspberry-pi-deployment, device-contract-changes, cloudflare-device-sync-enrollment]
---

# Go Agent Development

Use this skill for changes under `agent/`, including configuration, enrollment and sync, health telemetry, playback orchestration, or simulator and DRM/KMS output.

## Current implementation

The Go module is `agent/` and targets the version in `agent/go.mod`. The executable supports bundled offline profiles, authenticated Worker/R2 content sync, key-based enrollment, health telemetry, a software simulator, and an experimental Linux DRM/KMS backend. A single-display Pi 3 A Plus has passed physical KMS/frame visibility checks; Pi 3B and Pi 4 dual-output remain unverified. Treat emulator, sysfs discovery, and simulator results as distinct from physical scanout.

Useful package boundaries:

| Package | Responsibility |
| --- | --- |
| `internal/config` | Version 2 JSON contract, validation, and config-relative path resolution |
| `internal/agent` | Compose cache, schedules, output, and cancellation-aware playback loops |
| `internal/cache` | Content-addressed image storage and recovery |
| `internal/playlist` | Deterministic per-display schedule calculations |
| `internal/display` | Replaceable output interface |
| `internal/display/simulator` | Atomic PNG frame output without graphics hardware |
| `internal/display/drm` | Linux DRM/KMS connector discovery, configuration, and frame scanout |
| `internal/syncer` | Authenticated playlist snapshot and asset synchronization |
| `internal/health` | Bounded host and agent health telemetry |
| `internal/logging` | Structured `log/slog` setup |

## Change guidelines

- Keep configuration local and versioned. `config.Load` rejects unknown fields and multiple JSON values; relative asset, cache, and output paths are resolved from the config file's directory.
- Keep the local versioned configuration contract separate from Worker state. Follow the existing enrollment and sync interfaces rather than introducing unvalidated environment-variable contracts.
- Preserve package seams. Playback should depend on cache, scheduler, clock, and output interfaces; sync and hardware work should remain behind their package boundaries.
- Thread `context.Context` through blocking or long-running work. The CLI handles SIGINT and SIGTERM and waits for playback and output shutdown.
- Preserve the per-output playback lifecycle. Current local and remote configurations supply the same playlist and rotation interval to each output; do not imply separately configurable playlists unless the contract changes. Preserve each output's last successful frame if a later asset or presentation fails.
- Keep private keys on-device and health reports bounded. Do not send secrets or raw error text as telemetry.
- Use the injected clock and explicit timestamps for schedule behavior. Avoid wall-clock sleeps in scheduler tests.
- Return errors with operation context. Log recoverable asset or frame failures and continue where the current behavior allows it.
- Update `docs/agent-foundation.md`, the agent README, or example config when changing an observable contract.

## Local development commands

From the repository root:

```sh
cd agent
test -z "$(gofmt -l .)"
go test ./...
go test -race ./...
go vet ./...
go build ./cmd/ribbonfish
```

Use the focused package test while iterating, then run the full module checks for a Go behavior change. The CI workflow also runs `govulncheck` and cross-compiles Linux ARMv7 and ARM64 binaries; see [container-smoke-testing](../container-smoke-testing/SKILL.md) for the complete CI map.
For a change that also affects the Worker protocol, use [device-contract-changes](../device-contract-changes/SKILL.md) and [Cloudflare Device Sync and Enrollment](../cloudflare-device-sync-enrollment/SKILL.md).

## References

- [Agent architecture](../../../docs/agent-foundation.md)
- [Agent README](../../../agent/README.md)
- [Repository Copilot instructions](../../copilot-instructions.md)
- [Worker device API and enrollment contract](../cloudflare-device-sync-enrollment/SKILL.md)
