import { formatAge, formatBytes, formatTimestamp } from "./admin-formatters.ts";

type HealthOutput = { connector?: string; error_code?: string; last_frame_age_seconds: number | null; display_id: string; status: string };
type HealthReport = { sync?: { last_success_age_seconds?: number | null; status?: string; applied_playlist_id?: string; applied_revision?: number }; agent_version: string; agent_uptime_seconds: number; startup_error_code?: string; outputs?: HealthOutput[]; host?: { uptime_seconds: number; temperature_millicelsius: number; memory_available_bytes: number; state_disk_free_bytes: number; load_1m: number } };
type HealthHistory = { events?: { metadata?: { health_status?: string; previous_health_status?: string }; received_at: number; event_type: string; error_code?: string }[]; samples?: unknown[] };

export function formatDeviceHealthDetails(result: { latest?: HealthReport | null; health_status: string; received_at: number }, history: HealthHistory = {}) {
  const report = result?.latest;
  if (!report) return { message: "This device has not reported health yet." };

  const sync = report.sync ?? {};
  const lastSync = sync.last_success_age_seconds == null
    ? "never"
    : `${formatAge(sync.last_success_age_seconds)} ago`;
  const summary = [
    `Fleet health ${result.health_status}.`,
    `Last report ${formatTimestamp(result.received_at)} · Agent ${report.agent_version} · Uptime ${formatAge(report.agent_uptime_seconds)}`,
    `Sync ${sync.status ?? "unknown"} · last success ${lastSync}${sync.applied_playlist_id ? ` · ${sync.applied_playlist_id} / ${sync.applied_revision ?? "revision unknown"}` : ""}`,
  ];
  if (report.startup_error_code) summary.push(`Startup issue: ${report.startup_error_code}`);

  const outputs = (report.outputs ?? []).map((output) => {
    const connector = output.connector ? ` (${output.connector})` : "";
    const issue = output.error_code ? ` · ${output.error_code}` : "";
    const lastFrame = output.last_frame_age_seconds === null
      ? "no successful frame yet"
      : `last frame ${formatAge(output.last_frame_age_seconds ?? NaN)} ago`;
    return `${output.display_id}${connector}: ${output.status} · ${lastFrame}${issue}`;
  });

  const host = [];
  if (report.host) {
    if (Number.isFinite(report.host.uptime_seconds)) host.push(`Host uptime ${formatAge(report.host.uptime_seconds)}`);
    if (Number.isFinite(report.host.temperature_millicelsius)) host.push(`Temperature ${(report.host.temperature_millicelsius / 1000).toFixed(1)}°C`);
    if (Number.isFinite(report.host.memory_available_bytes)) host.push(`Memory ${formatBytes(report.host.memory_available_bytes)} available`);
    if (Number.isFinite(report.host.state_disk_free_bytes)) host.push(`State disk ${formatBytes(report.host.state_disk_free_bytes)} free`);
    if (Number.isFinite(report.host.load_1m)) host.push(`1m load ${report.host.load_1m.toFixed(2)}`);
  }

  const events = (history.events ?? []).map((event) => {
    const status = event.metadata?.health_status ? ` · ${event.metadata.health_status}` : "";
    const transition = event.metadata?.previous_health_status
      ? ` (${event.metadata.previous_health_status} → ${event.metadata.health_status})`
      : "";
    return `${formatTimestamp(event.received_at)} · ${event.event_type}${status}${transition}${event.error_code ? ` · ${event.error_code}` : ""}`;
  });

  return {
    summary,
    outputs,
    host,
    events,
    sampleCount: history.samples?.length ?? 0,
  };
}
