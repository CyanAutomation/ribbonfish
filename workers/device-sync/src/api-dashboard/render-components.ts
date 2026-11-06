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

export function svgServiceRow(input: { x: number; y: number; right: number; scale: number; name: string; status: string; color: string; latencyMs?: number; compact?: boolean }): string {
  const { x, y, right, scale, name, status, color, latencyMs, compact = false } = input;
  const statusWidth = scale * Math.min(status.length * (compact ? 6 : 8.2) + 8, (right - x) * .32);
  const maxName = Math.max(8, Math.floor((right - x - scale * 220) / (scale * 8.5)));
  let row = svgStatusDot(x + scale * 7, y - scale * 5, scale * 5, color);
  row += `<text x="${x + scale * 22}" y="${y}" fill="#e5edf6" font-size="${scale * (compact ? 12 : 16)}">${svgText(truncateText(name, maxName))}</text>`;
  if (latencyMs !== undefined && !compact) row += `<text x="${right - statusWidth - scale * 8}" y="${y}" text-anchor="end" fill="#b7c8da" font-size="${scale * 14}">${svgText(`${Math.round(latencyMs)} ms`)}</text>`;
  row += `<text x="${right}" y="${y}" text-anchor="end" fill="${svgText(color)}" font-size="${scale * (compact ? 11 : 14)}" font-weight="700">${svgText(status)}</text>`;
  return row;
}
