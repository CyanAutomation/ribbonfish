---
name: go-agent-development
description: Implement and review changes to Ribbonfish's local Go agent while preserving its package boundaries, strict local contract, and offline lifecycle.
tags: [ribbonfish, go, agent, architecture]
relatedSkills: [offline-playback-cache, container-smoke-testing, raspberry-pi-deployment]
---

# Go Agent Development

Use this skill for changes under `agent/`, including configuration, command-line behavior, playback orchestration, and display or sync interfaces.

## Current implementation

The Go module is `agent/` and targets Go 1.25.8. It uses the standard library only. The current executable loads a local JSON file, verifies and caches local images, rotates independent playlists, and writes PNG frames through the simulator. It does not enroll with a control plane, read the proposed hardware environment variables, or present frames through DRM/KMS.

Useful package boundaries:

| Package | Responsibility |
| --- | --- |
| `internal/config` | Version 1 JSON contract, validation, and config-relative path resolution |
| `internal/agent` | Compose cache, schedules, output, and cancellation-aware playback loops |
| `internal/cache` | Content-addressed image storage and recovery |
| `internal/playlist` | Deterministic per-display schedule calculations |
| `internal/display` | Replaceable output interface |
| `internal/display/simulator` | Atomic PNG frame output without graphics hardware |
| `internal/display/drm` | Read-only Linux sysfs connector discovery |
| `internal/syncer` | Future synchronization boundary; not a working control-plane client |
| `internal/logging` | Structured `log/slog` setup |

## Change guidelines

- Keep configuration local and versioned. `config.Load` rejects unknown fields and multiple JSON values; relative asset, cache, and output paths are resolved from the config file's directory.
- Keep hardware and Cloudflare settings out of the local config until their interfaces are implemented. In particular, do not imply that `RIBBONFISH_API_URL`, `RIBBONFISH_DEVICE_ID`, `RIBBONFISH_TOKEN_FILE`, or `RIBBONFISH_CACHE_DIR` are currently consumed.
- Preserve package seams. Playback should depend on the cache, scheduler, clock, and output interfaces instead of acquiring network or hardware behavior in orchestration code.
- Thread `context.Context` through blocking or long-running work. The CLI handles SIGINT and SIGTERM and waits for playback and output shutdown.
- Keep per-display rotation independent and preserve a last successful frame if a later asset or presentation fails.
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

## References

- [Agent architecture](../../../docs/agent-foundation.md)
- [Agent README](../../../agent/README.md)
- [Repository Copilot instructions](../../copilot-instructions.md)
