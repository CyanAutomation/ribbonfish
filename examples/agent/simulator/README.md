# Two-display software demo

This demo runs the Go agent without a Raspberry Pi, DRM/KMS device, Docker, or
network connection. Each configured display gets an independent playlist and
rotation interval. The simulator writes its current frame as an atomically
replaced PNG file.

From the repository root:

```sh
cd agent
go run ./cmd/ribbonfish -config ../examples/agent/simulator/config.json
```

The example rotates the left display every 15 seconds and the right display
every 9 seconds. Watch the structured logs or open these files while it runs:

- `examples/agent/simulator/var/frames/display-left.png`
- `examples/agent/simulator/var/frames/display-right.png`

Press Ctrl-C to stop. The agent handles the signal, finishes the current
write, and exits. The content-addressed cache remains under
`examples/agent/simulator/var/cache`, so startup can reuse verified local
assets after a restart without downloading anything.

To check ARM container startup under QEMU, run from the repository root:

```sh
sh agent/scripts/smoke-container.sh linux/arm/v7 pi3b
sh agent/scripts/smoke-container.sh linux/arm64 pi4
```

On an amd64 machine, the container smoke harness can also be checked without
QEMU using `sh agent/scripts/smoke-container.sh linux/amd64 pi4`. That confirms
the container's simulator behavior but does not test ARM compatibility.

The checks verify that the ARM image starts, loads the configured local PNGs,
and writes valid output frames. They do not emulate Raspberry Pi OS or validate
DRM/KMS, GPIO, display timing, or physical hardware behavior. CI runs the same
checks for both profiles.

The four sample PNGs are local files under `examples/raspberry-pi/assets/`; no URLs are fetched.
Missing or corrupt playlist items are logged and skipped, and a display keeps
its last successfully written frame if none of its configured assets can be
loaded. A cache directory that cannot be opened prevents startup. If the cache
is full, the agent keeps playable cached items, reports skipped assets, and
does not evict images protected by active playlists.

Runtime files are ignored by Git. Delete `var/` to clear the simulator output
and local device cache.
