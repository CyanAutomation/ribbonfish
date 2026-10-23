# Ribbonfish agent foundation

This directory contains the hardware-independent Go agent. It defines a
versioned local JSON contract, structured logging, cancellation-aware process
lifecycle, deterministic per-display playlist scheduling, and a persistent
content-verified image cache. Display output and synchronization remain
replaceable interfaces.

The runnable two-display demo and its instructions are in
[`../examples/agent/simulator/README.md`](../examples/agent/simulator/README.md).
The agent module uses the Go standard library only. See
[`../docs/agent-foundation.md`](../docs/agent-foundation.md) for architecture
decisions and hardware questions. The simulator is a software backend; it is
not evidence of physical display support.

Build and test the module with:

```sh
go test ./...
go build ./cmd/ribbonfish
```

Run the software demo using the instructions linked above.
