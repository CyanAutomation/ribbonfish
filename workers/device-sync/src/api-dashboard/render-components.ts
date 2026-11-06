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

export function svgCheckHistory(input: { x: number; y: number; width: number; height: number; states: string[]; scale?: number }): string {
  const { x, y, width, height, states, scale = 1 } = input;
  const palette: Record<string, string> = { operational: "#20c997", degraded: "#f6c453", down: "#ff647c", maintenance: "#a78bfa", pending: "#60a5fa", unknown: "#64748b", stale: "#fb923c" };
  if (!states.length) return "";
  const gap = scale * 2;
  const cellWidth = (width - gap * (states.length - 1)) / states.length;
  return `<g aria-label="Recent checks"><title>Recent checks</title>${states.map((state, index) => `<rect x="${x + index * (cellWidth + gap)}" y="${y}" width="${cellWidth}" height="${height}" rx="${scale * 2}" fill="${palette[state] ?? palette.unknown}"/>`).join("")}</g>`;
}
