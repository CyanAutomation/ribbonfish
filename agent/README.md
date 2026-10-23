# Ribbonfish agent foundation

This directory contains the hardware-independent Go agent. The first
implementation phase defines a versioned local JSON contract, structured
logging, cancellation-aware process lifecycle, and interfaces for display
output, image caching, playlist scheduling, and synchronization.

The agent module uses the Go standard library only. See
[`../docs/agent-foundation.md`](../docs/agent-foundation.md) for architecture
decisions and hardware questions. The runnable two-display simulator and its
configuration are added in the demonstration phase.

Build and run the current foundation with:

```sh
go test ./...
go build ./cmd/ribbonfish
```
