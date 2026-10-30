---
name: device-fleet-operations
description: Provision, approve, monitor, disable, and recover Ribbonfish devices using the management console and on-device diagnostics.
tags: [ribbonfish, fleet, enrollment, telemetry, operations]
relatedSkills: [cloudflare-device-sync-enrollment, cloudflare-management-console, device-contract-changes, raspberry-pi-deployment]
---

# Device Fleet Operations

Use this skill for device provisioning, enrollment approval, health triage, credential changes, or recovery after network and power outages.

## Enrollment and access

- New devices with sync configured create a persistent Ed25519 identity, display a device ID and grouped fingerprint, and wait for approval. Compare the complete fingerprint shown on the physical display with the pending request before approving that exact key.
- Approval binds the key to the device ID and replaces any previous legacy token. Reject unexpected or mismatched requests; pending requests expire after 24 hours.
- Legacy one-time enrollment codes are still supported. Handle the returned credential as a secret and rotate/revoke it if exposed.
- Disabling a device blocks access. Key-based device identity changes require a new approval; token rotation applies to legacy token devices.

## Health triage

1. Check device enabled state, last report time, and current derived health in the management console.
2. Inspect health history for the transition and stable error code. Telemetry intentionally excludes logs, credentials, and raw error messages.
3. On the device, inspect structured agent logs and `-list-displays` / `-check-displays` output. Those commands report sysfs state only; they do not prove KMS scanout.
4. For sync problems, verify URL, device ID, identity file permissions, network reachability, approval state, and whether the active playlist assets are available.
5. For display problems, distinguish sync/cache failure from connector, permission, DRM master, and physical scanout failure. Use [Raspberry Pi Deployment](../raspberry-pi-deployment/SKILL.md) for hardware evidence.

Reports are sent at startup, on health changes, every minute, and best-effort at shutdown. The console considers a report stale after 3 minutes and offline after 5 minutes; allow for network failure before treating a single missed report as a device fault.

## Safe recovery

- Preserve the state volume when restarting; it holds cache, last-good playlist state, and device identity.
- A network outage should leave verified cached content displaying. Restore connectivity without deleting the state volume or re-enrolling unless identity loss is confirmed.
- Do not copy private keys or device tokens into issue reports. Use audit events to confirm admin actions.

## References

- [Device and management API](../../../workers/device-sync/README.md)
- [Cloudflare Device Sync and Enrollment](../cloudflare-device-sync-enrollment/SKILL.md)
- [Cloudflare Management Console](../cloudflare-management-console/SKILL.md)
- [Device protocol and contract changes](../device-contract-changes/SKILL.md)
- [Raspberry Pi deployment](../raspberry-pi-deployment/SKILL.md)
