import { isRecord } from "./validation.ts";

export interface DeviceHealthReport extends Record<string, unknown> {
  schema_version: 1;
  instance_id: string;
  agent_version: string;
  state: "starting" | "ready" | "degraded" | "startup_failed" | "stopping";
  agent_uptime_seconds: number;
  startup_error_code?: string | null;
  sync: { status: "unknown" | "ok" | "failed"; applied_playlist_id: string | null; applied_revision: string | null; last_success_age_seconds: number | null; error_code: string | null };
  outputs: Array<{ display_id: string; connector: string | null; status: "unknown" | "ready" | "failed"; last_frame_age_seconds: number | null; error_code: string | null }>;
  host?: { uptime_seconds?: number; load_1m?: number; memory_available_bytes?: number; state_disk_free_bytes?: number; temperature_millicelsius?: number };
}

type HealthSnapshot = Pick<DeviceHealthReport, "state" | "startup_error_code"> & {
  sync?: Pick<DeviceHealthReport["sync"], "status" | "error_code">;
  outputs?: Array<Pick<DeviceHealthReport["outputs"][number], "status" | "error_code">>;
};

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const ERROR_CODES = new Set([
  "asset_unavailable", "cache_full", "configuration_invalid", "connector_disconnected",
  "connector_mode_unsupported", "display_start_failed", "drm_open_failed", "frame_present_failed",
  "no_playable_assets", "sync_rejected", "sync_unavailable", "unknown",
]);
const STALE_AFTER_MS = 3 * 60 * 1000;
const OFFLINE_AFTER_MS = 5 * 60 * 1000;

export function validateDeviceHealthReport(value: unknown): DeviceHealthReport | null {
  if (!isRecord(value) || !exactKeys(value,
    ["schema_version", "instance_id", "agent_version", "state", "agent_uptime_seconds", "sync", "outputs"],
    ["startup_error_code", "host"])) return null;
  if (value.schema_version !== 1 || !matches(value.instance_id, VERSION_PATTERN) ||
      !matches(value.agent_version, VERSION_PATTERN) ||
      !(typeof value.state === "string" && ["starting", "ready", "degraded", "startup_failed", "stopping"].includes(value.state)) ||
      !uint(value.agent_uptime_seconds, 10_000_000_000) ||
      value.startup_error_code !== undefined && !errorCode(value.startup_error_code, true) ||
      value.host !== undefined && !validHost(value.host) || !validSync(value.sync) ||
      !Array.isArray(value.outputs) || value.outputs.length > 8) return null;
  const ids = new Set<string>();
  for (const output of value.outputs) {
    if (!isRecord(output) || !exactKeys(output,
      ["display_id", "connector", "status", "last_frame_age_seconds", "error_code"]) ||
      !matches(output.display_id, ID_PATTERN) || output.connector !== null && !matches(output.connector, ID_PATTERN) ||
      !(typeof output.status === "string" && ["unknown", "ready", "failed"].includes(output.status)) ||
      !nullableUInt(output.last_frame_age_seconds, 31_536_000) || !errorCode(output.error_code, true) ||
      ids.has(output.display_id)) return null;
    ids.add(output.display_id);
  }
  return value as DeviceHealthReport;
}

export function deriveDeviceHealth(report: HealthSnapshot | null, receivedAt: number | undefined, now = Date.now()) {
  if (!report || typeof receivedAt !== "number" || !Number.isSafeInteger(receivedAt)) return "unknown";
  const age = Math.max(0, now - receivedAt);
  if (age > OFFLINE_AFTER_MS) return "offline";
  if (age > STALE_AFTER_MS) return "stale";
  if (report.state === "starting") return "starting";
  if (report.state === "stopping") return "stopping";
  if (report.state === "degraded" || report.state === "startup_failed" || report.sync?.status === "failed" ||
      report.startup_error_code || report.sync?.error_code ||
      report.outputs?.some((item) => item.status === "failed" || item.error_code)) return "degraded";
  if (report.outputs?.some((item) => item.status === "unknown")) return "starting";
  return "healthy";
}

function healthKey(report: DeviceHealthReport) {
  return JSON.stringify({
    state: report.state,
    startup_error_code: report.startup_error_code ?? null,
    sync_status: report.sync.status,
    sync_error_code: report.sync.error_code,
    outputs: report.outputs.map(({ display_id, status, error_code }) => [display_id, status, error_code] as const).sort((a, b) => a[0].localeCompare(b[0])),
  });
}

export async function persistDeviceHealth(db: D1Database, deviceID: string, report: DeviceHealthReport, receivedAt: number) {
  const key = healthKey(report);
  const healthStatus = deriveDeviceHealth(report, receivedAt, receivedAt);
  const error = report.startup_error_code ?? report.sync.error_code ?? report.outputs.find((item) => item.error_code)?.error_code ?? null;
  const metadata = JSON.stringify({ state: report.state, health_status: healthStatus, error_code: error });
  const json = JSON.stringify(report);
  const eventID = crypto.randomUUID();
  const bucketAt = Math.floor(receivedAt / (5 * 60 * 1000)) * 5 * 60 * 1000;
  await db.batch([
    db.prepare(
      "INSERT INTO device_health_events (event_id, device_id, instance_id, received_at, event_type, reported_state, error_code, metadata_json) " +
      "SELECT ?, ?, ?, ?, CASE WHEN NOT EXISTS (SELECT 1 FROM device_health_latest WHERE device_id = ?) THEN 'device.first_report' " +
      "WHEN EXISTS (SELECT 1 FROM device_health_latest WHERE device_id = ? AND instance_id <> ?) THEN 'device.agent_restarted' " +
      "ELSE 'device.health_changed' END, ?, ?, ? WHERE NOT EXISTS " +
      "(SELECT 1 FROM device_health_latest WHERE device_id = ? AND instance_id = ? AND health_key = ? AND health_status = ?)",
    ).bind(eventID, deviceID, report.instance_id, receivedAt, deviceID, deviceID, report.instance_id, report.state, error, metadata,
      deviceID, report.instance_id, key, healthStatus),
    db.prepare(
      "INSERT INTO device_health_samples (device_id, bucket_at, received_at, report_json) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(device_id, bucket_at) DO UPDATE SET received_at = excluded.received_at, report_json = excluded.report_json " +
      "WHERE device_health_samples.received_at <= excluded.received_at",
    ).bind(deviceID, bucketAt, receivedAt, json),
    db.prepare(
      "INSERT INTO device_health_latest (device_id, instance_id, received_at, reported_state, health_status, health_key, agent_version, sync_status, applied_playlist_id, applied_revision, report_json) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET " +
      "instance_id = excluded.instance_id, received_at = excluded.received_at, reported_state = excluded.reported_state, health_status = excluded.health_status, " +
      "health_key = excluded.health_key, agent_version = excluded.agent_version, sync_status = excluded.sync_status, " +
      "applied_playlist_id = excluded.applied_playlist_id, applied_revision = excluded.applied_revision, report_json = excluded.report_json " +
      "WHERE device_health_latest.received_at <= excluded.received_at",
    ).bind(deviceID, report.instance_id, receivedAt, report.state, healthStatus, key, report.agent_version, report.sync.status,
      report.sync.applied_playlist_id, report.sync.applied_revision, json),
  ]);
  return { received_at: receivedAt };
}

// refreshDeviceHealthStatuses persists stale/offline transitions even when a
// device stops reporting, and records the condition before the next report.
export async function refreshDeviceHealthStatuses(db: D1Database, now: number) {
  const candidates = await db.prepare(
    "SELECT h.device_id, h.instance_id, h.received_at, h.reported_state, h.report_json, h.health_status " +
    "FROM device_health_latest h JOIN devices d ON d.device_id = h.device_id " +
    "WHERE d.enabled = 1 AND h.received_at <= ? AND h.health_status <> 'offline' " +
    "ORDER BY h.received_at LIMIT 500",
  ).bind(now - 3 * 60 * 1000).all<{ device_id: string; instance_id: string; received_at: number; reported_state: string; report_json: string; health_status: string }>();
  const statements: D1PreparedStatement[] = [];
  for (const row of candidates.results ?? []) {
    const report = parseReport(row.report_json);
    const status = deriveDeviceHealth(report, row.received_at, now);
    if (status !== "stale" && status !== "offline" || status === row.health_status) continue;
    const eventID = crypto.randomUUID();
    const metadata = JSON.stringify({
      previous_health_status: row.health_status,
      health_status: status,
      state: row.reported_state,
      error_code: null,
    });
    statements.push(db.prepare(
      "INSERT INTO device_health_events (event_id, device_id, instance_id, received_at, event_type, reported_state, error_code, metadata_json) " +
      "SELECT ?, ?, ?, ?, 'device.health_changed', ?, NULL, ? WHERE EXISTS " +
      "(SELECT 1 FROM device_health_latest WHERE device_id = ? AND received_at = ? AND health_status <> ?)",
    ).bind(eventID, row.device_id, row.instance_id, now, row.reported_state, metadata,
      row.device_id, row.received_at, status));
    statements.push(db.prepare(
      "UPDATE device_health_latest SET health_status = ? WHERE device_id = ? AND received_at = ? AND health_status <> ?",
    ).bind(status, row.device_id, row.received_at, status));
  }
  if (!statements.length) return 0;
  const result = await db.batch(statements);
  return result.reduce((count, item, index) => count + (index % 2 === 1 ? item?.meta?.changes ?? 0 : 0), 0);
}

export async function cleanupDeviceHealth(db: D1Database, now: number) {
  const cutoff = now - 30 * 24 * 60 * 60 * 1000;
  const results = await db.batch([
    db.prepare("DELETE FROM device_health_samples WHERE received_at < ?").bind(cutoff),
    db.prepare("DELETE FROM device_health_events WHERE received_at < ?").bind(cutoff),
  ]);
  return (results ?? []).reduce((sum, row) => sum + (row?.meta?.changes ?? 0), 0);
}

function validSync(value: unknown) {
  return isRecord(value) && exactKeys(value,
    ["status", "applied_playlist_id", "applied_revision", "last_success_age_seconds", "error_code"]) &&
    typeof value.status === "string" && ["unknown", "ok", "failed"].includes(value.status) && nullableMatches(value.applied_playlist_id, ID_PATTERN) &&
    nullableMatches(value.applied_revision, VERSION_PATTERN) && nullableUInt(value.last_success_age_seconds, 31_536_000) &&
    errorCode(value.error_code, true);
}

function parseReport(value: unknown): DeviceHealthReport | null {
  if (typeof value !== "string") return null;
  try { return JSON.parse(value) as DeviceHealthReport; } catch { return null; }
}

function validHost(value: unknown) {
  if (!isRecord(value) || !exactKeys(value, [], ["uptime_seconds", "load_1m", "memory_available_bytes", "state_disk_free_bytes", "temperature_millicelsius"])) return false;
  if (value.uptime_seconds !== undefined && !uint(value.uptime_seconds, 10_000_000_000)) return false;
  if (value.load_1m !== undefined && (typeof value.load_1m !== "number" || !Number.isFinite(value.load_1m) || value.load_1m < 0 || value.load_1m > 1000)) return false;
  for (const key of ["memory_available_bytes", "state_disk_free_bytes"]) {
    if (value[key] !== undefined && !uint(value[key], Number.MAX_SAFE_INTEGER)) return false;
  }
  return value.temperature_millicelsius === undefined ||
    typeof value.temperature_millicelsius === "number" && Number.isSafeInteger(value.temperature_millicelsius) && value.temperature_millicelsius >= -40_000 && value.temperature_millicelsius <= 150_000;
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => required.includes(key) || optional.includes(key));
}
function matches(value: unknown, pattern: RegExp): value is string { return typeof value === "string" && pattern.test(value); }
function nullableMatches(value: unknown, pattern: RegExp) { return value === null || matches(value, pattern); }
function uint(value: unknown, max: number): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max; }
function nullableUInt(value: unknown, max: number) { return value === null || uint(value, max); }
function errorCode(value: unknown, nullable = false) { return nullable && value === null || typeof value === "string" && ERROR_CODES.has(value); }
