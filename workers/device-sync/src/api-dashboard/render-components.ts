/** Small, shared SVG components used by the captured API status dashboard. */
export function svgText(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!);
}

export function truncateText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 3))}...` : value;
}

export function svgStatusDot(cx: number, cy: number, radius: number, color: string): string {
  return `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="${svgText(color)}"/>`;
}

const healthLegendItems = [
  ["Operational", "#20c997"], ["Degraded", "#f6c453"], ["Down", "#ff647c"],
  ["Maintenance", "#a78bfa"], ["Pending", "#60a5fa"], ["Unknown", "#94a3b8"], ["Stale", "#fb923c"],
] as const;

export interface SvgHealthCount {
  label: string;
  count: number;
  color: string;
}

/** Prominent, readable health counts used above the detail cards. */
export function svgHealthOverview(x: number, y: number, width: number, scale: number, items: SvgHealthCount[]): string {
  const s = (value: number) => value * scale;
  const visibleItems = items.filter((item) => item.count > 0);
  if (!visibleItems.length) return `<text x="${x}" y="${y}" fill="#c0cede" font-size="${s(17)}">No active service data</text>`;
  const gap = s(12);
  let cursor = x;
  let result = `<g role="group" aria-label="Current service health">`;
  for (const item of visibleItems) {
    const label = `${item.count} ${item.label}`;
    const chipWidth = s(34 + label.length * 8.5);
    if (cursor + chipWidth > x + width) break;
    result += `<rect x="${cursor}" y="${y - s(23)}" width="${chipWidth}" height="${s(31)}" rx="${s(8)}" fill="#142238" stroke="${svgText(item.color)}" stroke-width="${s(1)}"/>`;
    result += svgStatusDot(cursor + s(13), y - s(7), s(4), item.color);
    result += `<text x="${cursor + s(23)}" y="${y}" fill="${svgText(item.color)}" font-size="${s(15)}" font-weight="700">${svgText(label)}</text>`;
    cursor += chipWidth + gap;
  }
  return `${result}</g>`;
}

/** Shared, visible status key for dashboards that use color to encode health. */
export function svgHealthLegend(x: number, y: number, width: number, scale: number): string {
  const s = (value: number) => value * scale;
  const labelWidth = s(105);
  const itemWidth = (width - labelWidth) / healthLegendItems.length;
  let result = `<g role="group" aria-label="Status key"><text x="${x}" y="${y}" fill="#b9c9dc" font-size="${s(14)}" font-weight="700">Status key</text>`;
  healthLegendItems.forEach(([label, color], index) => {
    const itemX = x + labelWidth + index * itemWidth;
    result += svgStatusDot(itemX + s(5), y - s(4), s(4), color);
    result += `<text x="${itemX + s(15)}" y="${y}" fill="#d0dbea" font-size="${s(14)}">${label}</text>`;
  });
  return `${result}</g>`;
}

export function svgPanel(x: number, y: number, width: number, height: number, scale: number, accentColor: string): string {
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${18 * scale}" fill="#142238" stroke="#344a66" stroke-width="${2 * scale}"/><rect x="${x}" y="${y}" width="${7 * scale}" height="${height}" rx="${4 * scale}" fill="${svgText(accentColor)}"/>`;
}

export function svgStatusBadge(x: number, y: number, width: number, height: number, scale: number, label: string, color: string): string {
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${18 * scale}" fill="#142238" stroke="${svgText(color)}" stroke-width="${2 * scale}"/>${svgStatusDot(x + 34 * scale, y + height / 2, 9 * scale, color)}<text x="${x + 56 * scale}" y="${y + height / 2 + 7 * scale}" fill="${svgText(color)}" font-family="Ribbon Sans" font-size="${20 * scale}" font-weight="700">${svgText(label)}</text>`;
}

/** Compact, reusable feed-health label kept visually distinct from service status. */
export function svgFreshnessBadge(x: number, y: number, scale: number, label: string, color: string): string {
  return `${svgStatusDot(x, y - 4 * scale, 4 * scale, color)}<text x="${x + 12 * scale}" y="${y}" fill="${svgText(color)}" font-size="${16 * scale}" font-weight="700">${svgText(label)}</text>`;
}

export function svgServiceRow(input: { x: number; y: number; right: number; scale: number; name: string; status: string; color: string; statusMeta?: string; compact?: boolean; showStatus?: boolean }): string {
  const { x, y, right, scale, name, status, color, statusMeta, compact = false, showStatus = false } = input;
  const statusLabel = status === "Operational" && !showStatus ? "" : [status, statusMeta].filter(Boolean).join(" · ");
  const statusCharWidth = scale * (compact ? 7 : 9.5);
  const maxStatusChars = Math.floor((right - x) * .48 / statusCharWidth);
  const shownStatus = statusLabel ? truncateText(statusLabel, maxStatusChars) : "";
  const statusWidth = shownStatus.length * statusCharWidth;
  const maxName = Math.max(8, Math.floor((right - x - scale * 38 - statusWidth) / (scale * 10.5)));
  let row = svgStatusDot(x + scale * 7, y - scale * 5, scale * 5, color);
  row += `<text x="${x + scale * 22}" y="${y}" fill="#e5edf6" font-size="${scale * (compact ? 14 : 20)}">${svgText(truncateText(name, maxName))}</text>`;
  if (shownStatus) row += `<text x="${right}" y="${y}" text-anchor="end" fill="${svgText(color)}" font-size="${scale * (compact ? 13 : 17)}" font-weight="700">${svgText(shownStatus)}</text>`;
  return row;
}

export function svgGroupSummary(input: { x: number; y: number; right: number; scale: number; label: string; count: number; history?: string[] }): string {
  const { x, y, right, scale, label, count, history = [] } = input;
  const plural = count === 1 ? "service" : "services";
  let result = `<text x="${x}" y="${y}" fill="#a9d9ca" font-size="${scale * 13}">${svgText(`${count} ${plural} ${label}`)}</text>`;
  if (history.length) {
    result += `<text x="${right - scale * 178}" y="${y}" text-anchor="end" fill="#c0cede" font-size="${scale * 14}">24h</text>`;
    result += svgCheckHistory({ x: right - scale * 166, y: y - scale * 10, width: scale * 136, height: scale * 10, states: history, scale });
    result += `<text x="${right}" y="${y}" text-anchor="end" fill="#c0cede" font-size="${scale * 12}">Now</text>`;
  }
  return result;
}

export interface SvgDashboardEvent {
  kind: "Incident" | "Maintenance";
  name: string;
  status: string;
  impact?: string;
  color: string;
  updatedAt?: string | null;
  scheduledFor?: string | null;
  referenceAt?: string | null;
}

function eventClock(value: string | null | undefined, includeDate = false): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return undefined;
  return includeDate ? `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)} UTC` : `${date.toISOString().slice(11, 16)} UTC`;
}

function relativeTime(value: string | null | undefined, reference: string | null | undefined): string | undefined {
  if (!value || !reference) return undefined;
  const target = Date.parse(value);
  const now = Date.parse(reference);
  if (!Number.isFinite(target) || !Number.isFinite(now)) return undefined;
  const delta = target - now;
  const absMinutes = Math.max(1, Math.round(Math.abs(delta) / 60_000));
  const hours = Math.round(absMinutes / 60);
  const days = Math.round(absMinutes / (24 * 60));
  const duration = absMinutes < 60 ? `${absMinutes} ${absMinutes === 1 ? "minute" : "minutes"}`
    : absMinutes < 24 * 60 ? `${hours} ${hours === 1 ? "hour" : "hours"}`
      : `${days} ${days === 1 ? "day" : "days"}`;
  return delta >= 0 ? `in ${duration}` : `started ${duration} ago`;
}

/** Shared, high-contrast event panel for active incidents and scheduled work. */
export function svgEventPanel(input: { x: number; y: number; width: number; height: number; scale: number; events: SvgDashboardEvent[]; hiddenCount?: number }): string {
  const { x, y, width, height, scale, events, hiddenCount = 0 } = input;
  if (!events.length || width <= 0 || height <= 0) return "";
  const s = (value: number) => value * scale;
  let result = `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${s(10)}" fill="#202d40"/>`;
  events.forEach((event, index) => {
    const rowY = y + s(7 + index * 54);
    const titleBaseline = rowY + s(19);
    const metaBaseline = rowY + s(42);
    const title = `${event.kind.toUpperCase()} · ${event.name}`;
    const relativeStart = relativeTime(event.scheduledFor, event.referenceAt);
    const meta = event.kind === "Maintenance"
      ? [event.status.replace(/_/g, " "), relativeStart, event.scheduledFor ? `Starts ${eventClock(event.scheduledFor, true)}` : undefined, event.updatedAt ? `Updated ${eventClock(event.updatedAt)}` : undefined].filter(Boolean).join(" · ")
      : [event.status.replace(/_/g, " "), event.impact ? `${event.impact} impact` : undefined, event.updatedAt ? `Updated ${eventClock(event.updatedAt)}` : undefined].filter(Boolean).join(" · ");
    const isLast = index === events.length - 1;
    const suffix = isLast && hiddenCount ? ` · +${hiddenCount} more active events` : "";
    const maxChars = Math.max(8, Math.floor((width - s(42)) / s(11)));
    result += `<rect x="${x}" y="${rowY}" width="${s(5)}" height="${s(44)}" rx="${s(2)}" fill="${svgText(event.color)}"/>`;
    result += `<text x="${x + s(16)}" y="${titleBaseline}" fill="#f4f7fb" font-size="${s(20)}" font-weight="700">${svgText(truncateText(title, maxChars))}</text>`;
    result += `<text x="${x + s(16)}" y="${metaBaseline}" fill="${svgText(event.color)}" font-size="${s(15)}">${svgText(truncateText(`${meta}${suffix}`, maxChars))}</text>`;
  });
  return result;
}

export function svgCheckHistory(input: { x: number; y: number; width: number; height: number; states: string[]; scale?: number }): string {
  const { x, y, width, height, states, scale = 1 } = input;
  const palette: Record<string, string> = { operational: "#20c997", degraded: "#f6c453", down: "#ff647c", maintenance: "#a78bfa", pending: "#60a5fa", unknown: "#64748b", stale: "#fb923c" };
  if (!states.length) return "";
  const gap = scale * 2;
  const cellWidth = (width - gap * (states.length - 1)) / states.length;
  const labels: Record<string, string> = { operational: "Operational", degraded: "Degraded", down: "Down", maintenance: "Maintenance", pending: "Pending", unknown: "Unknown", stale: "Stale" };
  const historyDescription = `Recent checks from 24 hours ago to now: ${states.map((state) => labels[state] ?? "Unknown").join(", ")}`;
  return `<g role="img" aria-label="${svgText(historyDescription)}"><title>${svgText(historyDescription)}</title>${states.map((state, index) => `<rect x="${x + index * (cellWidth + gap)}" y="${y}" width="${cellWidth}" height="${height}" rx="${scale * 2}" fill="${palette[state] ?? palette.unknown}"/>`).join("")}</g>`;
}
