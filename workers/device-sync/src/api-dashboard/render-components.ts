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

export function svgPanel(x: number, y: number, width: number, height: number, scale: number, accentColor: string): string {
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${18 * scale}" fill="#142238" stroke="#344a66" stroke-width="${2 * scale}"/><rect x="${x}" y="${y}" width="${7 * scale}" height="${height}" rx="${4 * scale}" fill="${svgText(accentColor)}"/>`;
}

export function svgStatusBadge(x: number, y: number, width: number, height: number, scale: number, label: string, color: string): string {
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${18 * scale}" fill="#142238" stroke="${svgText(color)}" stroke-width="${2 * scale}"/>${svgStatusDot(x + 34 * scale, y + height / 2, 9 * scale, color)}<text x="${x + 56 * scale}" y="${y + height / 2 + 7 * scale}" fill="${svgText(color)}" font-family="Ribbon Sans" font-size="${20 * scale}" font-weight="700">${svgText(label)}</text>`;
}

/** Compact, reusable feed-health label kept visually distinct from service status. */
export function svgFreshnessBadge(x: number, y: number, scale: number, label: string, color: string): string {
  return `${svgStatusDot(x, y - 4 * scale, 4 * scale, color)}<text x="${x + 12 * scale}" y="${y}" fill="${svgText(color)}" font-size="${13 * scale}" font-weight="700">${svgText(label)}</text>`;
}

export function svgServiceRow(input: { x: number; y: number; right: number; scale: number; name: string; status: string; color: string; statusMeta?: string; compact?: boolean }): string {
  const { x, y, right, scale, name, status, color, statusMeta, compact = false } = input;
  const statusLabel = status === "Operational" ? "" : [status, statusMeta].filter(Boolean).join(" · ");
  const statusCharWidth = scale * (compact ? 6.5 : 8.5);
  const maxStatusChars = Math.floor((right - x) * .48 / statusCharWidth);
  const shownStatus = statusLabel ? truncateText(statusLabel, maxStatusChars) : "";
  const statusWidth = shownStatus.length * statusCharWidth;
  const maxName = Math.max(8, Math.floor((right - x - scale * 38 - statusWidth) / (scale * 8.5)));
  let row = svgStatusDot(x + scale * 7, y - scale * 5, scale * 5, color);
  row += `<text x="${x + scale * 22}" y="${y}" fill="#e5edf6" font-size="${scale * (compact ? 12 : 16)}">${svgText(truncateText(name, maxName))}</text>`;
  if (shownStatus) row += `<text x="${right}" y="${y}" text-anchor="end" fill="${svgText(color)}" font-size="${scale * (compact ? 11 : 14)}" font-weight="700">${svgText(shownStatus)}</text>`;
  return row;
}

export function svgGroupSummary(input: { x: number; y: number; right: number; scale: number; label: string; count: number; history?: string[] }): string {
  const { x, y, right, scale, label, count, history = [] } = input;
  const plural = count === 1 ? "service" : "services";
  let result = `<text x="${x}" y="${y}" fill="#a9d9ca" font-size="${scale * 13}">${svgText(`${count} ${plural} ${label}`)}</text>`;
  if (history.length) {
    result += `<text x="${right - scale * 156}" y="${y}" text-anchor="end" fill="#8497ad" font-size="${scale * 10}">24h</text>`;
    result += svgCheckHistory({ x: right - scale * 150, y: y - scale * 10, width: scale * 144, height: scale * 10, states: history, scale });
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
}

function eventClock(value: string | null | undefined, includeDate = false): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return undefined;
  return includeDate ? `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)} UTC` : `${date.toISOString().slice(11, 16)} UTC`;
}

/** Shared, high-contrast event panel for active incidents and scheduled work. */
export function svgEventPanel(input: { x: number; y: number; width: number; height: number; scale: number; events: SvgDashboardEvent[]; hiddenCount?: number }): string {
  const { x, y, width, height, scale, events, hiddenCount = 0 } = input;
  if (!events.length || width <= 0 || height <= 0) return "";
  const s = (value: number) => value * scale;
  let result = `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${s(10)}" fill="#202d40"/>`;
  events.forEach((event, index) => {
    const rowY = y + s(7 + index * 44);
    const titleBaseline = rowY + s(15);
    const metaBaseline = rowY + s(33);
    const title = `${event.kind.toUpperCase()} · ${event.name}`;
    const meta = event.kind === "Maintenance"
      ? [event.status.replace(/_/g, " "), event.scheduledFor ? `Starts ${eventClock(event.scheduledFor, true)}` : undefined, event.updatedAt ? `Updated ${eventClock(event.updatedAt)}` : undefined].filter(Boolean).join(" · ")
      : [event.status.replace(/_/g, " "), event.impact ? `${event.impact} impact` : undefined, event.updatedAt ? `Updated ${eventClock(event.updatedAt)}` : undefined].filter(Boolean).join(" · ");
    const isLast = index === events.length - 1;
    const suffix = isLast && hiddenCount ? ` · +${hiddenCount} more active events` : "";
    const maxChars = Math.max(8, Math.floor((width - s(48)) / s(8.5)));
    result += `<rect x="${x}" y="${rowY}" width="${s(4)}" height="${s(34)}" rx="${s(2)}" fill="${svgText(event.color)}"/>`;
    result += `<text x="${x + s(14)}" y="${titleBaseline}" fill="#f4f7fb" font-size="${s(15)}" font-weight="700">${svgText(truncateText(title, maxChars))}</text>`;
    result += `<text x="${x + s(14)}" y="${metaBaseline}" fill="${svgText(event.color)}" font-size="${s(12)}">${svgText(truncateText(`${meta}${suffix}`, maxChars))}</text>`;
  });
  return result;
}

export function svgCheckHistory(input: { x: number; y: number; width: number; height: number; states: string[]; scale?: number }): string {
  const { x, y, width, height, states, scale = 1 } = input;
  const palette: Record<string, string> = { operational: "#20c997", degraded: "#f6c453", down: "#ff647c", maintenance: "#a78bfa", pending: "#60a5fa", unknown: "#64748b", stale: "#fb923c" };
  if (!states.length) return "";
  const gap = scale * 2;
  const cellWidth = (width - gap * (states.length - 1)) / states.length;
  return `<g aria-label="Recent checks"><title>Recent checks</title>${states.map((state, index) => `<rect x="${x + index * (cellWidth + gap)}" y="${y}" width="${cellWidth}" height="${height}" rx="${scale * 2}" fill="${palette[state] ?? palette.unknown}"/>`).join("")}</g>`;
}
