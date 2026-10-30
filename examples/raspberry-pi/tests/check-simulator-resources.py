#!/usr/bin/env python3
"""Assert resource limits in normalized Docker Compose JSON."""

import json
import sys


def main():
    if len(sys.argv) != 3:
        raise SystemExit(
            f"usage: {sys.argv[0]} <expected_cpus> <expected_memory_bytes>"
        )
    expected_cpus = float(sys.argv[1])
    expected_memory = int(sys.argv[2])
    service = json.load(sys.stdin)["services"]["agent"]
    actual_cpus = float(service.get("cpus", -1))
    actual_memory = int(service.get("mem_limit", -1))
    if actual_cpus != expected_cpus:
        raise SystemExit(f"agent CPU limit is {actual_cpus}, expected {expected_cpus}")
    if actual_memory != expected_memory:
        raise SystemExit(f"agent memory limit is {actual_memory}, expected {expected_memory}")


if __name__ == "__main__":
    main()
