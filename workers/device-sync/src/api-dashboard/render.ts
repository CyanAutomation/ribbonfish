import { Resvg, initWasm } from "@resvg/resvg-wasm";
import { healthLabel, overallHealth, type DashboardSource, type Health } from "./model.ts";

const MAX_PIXELS = 3840 * 2160;
const MAX_PNG_BYTES = 32 * 1024 * 1024;
let wasmReady: Promise<void> | undefined;
const colors: Record<Health, string> = {
  operational: "#20c997", degraded: "#f6c453", down: "#ff647c", maintenance: "#a78bfa",
  pending: "#60a5fa", unknown: "#94a3b8", stale: "#fb923c",
};

function esc(text: string) { return text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!); }
function short(text: string, max: number) { return text.length > max ? `${text.slice(0, Math.max(0, max - 3))}...` : text; }

function sourceHealth(source: DashboardSource): Health {
  if (source.disabled) return "unknown";
  if (source.freshness !== "fresh") return "stale";
  const leafStates = source.components.filter((item) => !item.isGroup).map((item) => item.status);
  if (leafStates.includes("down")) return "down";
  if (leafStates.includes("degraded")) return "degraded";
  if (leafStates.includes("maintenance")) return "maintenance";
  if (leafStates.includes("pending")) return "pending";
  if (source.status !== "operational") return source.status;
  if (!leafStates.length || leafStates.includes("unknown")) return "unknown";
  return "operational";
}

function card(source: DashboardSource, x: number, y: number, width: number, height: number, scale: number) {
  const s = (n: number) => n * scale;
  const health = sourceHealth(source);
  const pad = s(22);
  const left = x + pad;
  const compact = height < s(170);
  const contentY = y + s(compact ? 0 : 100);
  const lineH = s(compact ? 18 : Math.max(20, Math.min(24, height / 18)));
  const parentGroups = (source.groups ?? source.components.filter((component) => component.isGroup).map((component) => ({ id: component.id, name: component.name, order: component.groupOrder ?? component.componentOrder ?? 0 })))
    .sort((a, b) => a.order - b.order);
  const services = source.components.filter((component) => !component.isGroup);
  const serviceRows: Array<{ kind: "group"; name: string } | { kind: "empty"; name: string } | { kind: "service"; component: typeof services[number] }> = [];
  const seenServices = new Set<string>();
  if (parentGroups.length) {
    for (const parent of parentGroups) {
      const children = services.filter((component) => component.groupId === parent.id || (!component.groupId && component.groupName === parent.name))
        .sort((a, b) => (a.componentOrder ?? 0) - (b.componentOrder ?? 0));
      serviceRows.push({ kind: "group", name: parent.name });
      if (!children.length) serviceRows.push({ kind: "empty", name: parent.name });
      for (const component of children) { serviceRows.push({ kind: "service", component }); seenServices.add(component.id); }
    }
  }
  const remaining = services.filter((component) => !seenServices.has(component.id))
    .sort((a, b) => (a.groupOrder ?? 0) - (b.groupOrder ?? 0) || (a.componentOrder ?? 0) - (b.componentOrder ?? 0));
  const groups = new Map<string, typeof remaining>();
  for (const component of remaining) {
    const name = component.groupName ?? "Services";
    groups.set(name, [...(groups.get(name) ?? []), component]);
  }
  const orderedGroups = [...groups.entries()];
  for (const [groupName, components] of orderedGroups) {
    if (components.length && (parentGroups.length > 0 || orderedGroups.length > 1 || groupName !== "Services")) serviceRows.push({ kind: "group", name: groupName });
    for (const component of components) serviceRows.push({ kind: "service", component });
  }
  const events = [...source.incidents.map((item) => `Incident (${item.status}, ${item.impact}): ${item.name}`), ...source.maintenance.map((item) => `Maintenance (${item.status}): ${item.name}`)];
  const footerRows = (serviceRows.some((row) => row.kind === "service" || row.kind === "empty") ? 1 : 0) + (events.length ? 1 : 0);
  const maxLines = Math.max(0, Math.floor((height - s(compact ? 58 : 150) - s(footerRows * 20)) / lineH));
  const showRows = serviceRows.slice(0, maxLines);
  while (showRows.at(-1)?.kind === "group") showRows.pop();
  const visibleServices = showRows.filter((row) => row.kind === "service").length;
  const hiddenServices = Math.max(0, services.length - visibleServices);
  const hiddenGroups = Math.max(0, serviceRows.filter((row) => row.kind === "group").length - showRows.filter((row) => row.kind === "group").length);
  let svg = `<g><rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${s(18)}" fill="#142238" stroke="#283951" stroke-width="${s(2)}"/>`;
  svg += `<rect x="${x}" y="${y}" width="${s(7)}" height="${height}" rx="${s(4)}" fill="${colors[health]}"/>`;
  svg += `<text x="${left}" y="${y + s(compact ? 25 : 42)}" fill="#f5f8fc" font-size="${s(compact ? 17 : 26)}" font-weight="700">${esc(short(source.displayName, Math.floor((width - s(185)) / s(compact ? 10 : 17))))}</text>`;
  svg += `<circle cx="${x + width - s(150)}" cy="${y + s(compact ? 20 : 34)}" r="${s(7)}" fill="${colors[health]}"/>`;
  const sourceStatusLabel = source.disabled ? "Disabled" : healthLabel[health];
  svg += `<text x="${x + width - s(136)}" y="${y + s(compact ? 26 : 41)}" fill="${colors[health]}" font-size="${s(compact ? 13 : 16)}">${esc(sourceStatusLabel)}</text>`;
  if (!compact) {
    if (source.error) svg += `<text x="${left}" y="${y + s(68)}" fill="#ffb86c" font-size="${s(15)}">${esc(short(source.error, Math.floor(width / s(9))))}</text>`;
    else svg += `<text x="${left}" y="${y + s(70)}" fill="#aab8ca" font-size="${s(14)}">${esc(short(source.statusDescription, Math.floor(width / s(9))))}</text>`;
  }
  if (source.disabled) svg += `<text x="${left}" y="${y + s(compact ? 48 : 106)}" fill="#aab8ca" font-size="${s(17)}">Source is disabled and not polled</text>`;
  else if (!services.length && !source.error && !parentGroups.length) svg += `<text x="${left}" y="${y + s(compact ? 48 : 106)}" fill="#aab8ca" font-size="${s(17)}">No component data available</text>`;
  showRows.forEach((row, index) => {
    const cy = contentY + index * lineH;
    if (row.kind === "group") {
      svg += `<text x="${left}" y="${cy}" fill="#a9bdd4" font-size="${s(compact ? 12 : 15)}" font-weight="700">${esc(short(row.name, Math.floor(width / s(10))))}</text>`;
      return;
    }
    if (row.kind === "empty") {
      svg += `<text x="${left + s(16)}" y="${cy}" fill="#aab8ca" font-size="${s(compact ? 11 : 14)}">No services reported</text>`;
      return;
    }
    const { name, status, latencyMs } = row.component;
    const color = colors[status as Health] ?? colors.unknown;
    const statusText = healthLabel[status as Health] ?? healthLabel.unknown;
    const right = x + width - pad;
    const statusWidth = s(Math.min(statusText.length * (compact ? 6 : 8.2) + 8, width * .32));
    svg += `<circle cx="${left + s(7)}" cy="${cy - s(5)}" r="${s(5)}" fill="${color}"/>`;
    svg += `<text x="${left + s(22)}" y="${cy}" fill="#e5edf6" font-size="${s(compact ? 12 : 16)}">${esc(short(name, Math.max(8, Math.floor((width - s(220)) / s(8.5)))))}</text>`;
    if (latencyMs !== undefined && !compact) svg += `<text x="${right - statusWidth - s(8)}" y="${cy}" text-anchor="end" fill="#9db0c5" font-size="${s(14)}">${esc(`${Math.round(latencyMs)} ms`)}</text>`;
    svg += `<text x="${right}" y="${cy}" text-anchor="end" fill="${color}" font-size="${s(compact ? 11 : 14)}">${esc(statusText)}</text>`;
  });
  if (hiddenServices || hiddenGroups) {
    const message = [hiddenGroups ? `${hiddenGroups} more groups` : "", hiddenServices ? `${hiddenServices} more services` : ""].filter(Boolean).join(" · ");
    svg += `<text x="${left}" y="${y + height - s(events.length ? 36 : 18)}" fill="#9db0c5" font-size="${s(compact ? 10 : 13)}">+ ${esc(message)}</text>`;
  }
  if (events.length) {
    const suffix = events.length > 1 ? ` · +${events.length - 1} more active events` : "";
    const first = short(events[0], Math.max(8, Math.floor(width / s(compact ? 7 : 8)) - suffix.length));
    svg += `<text x="${left}" y="${y + height - s(compact ? 8 : 18)}" fill="#ffc46b" font-size="${s(compact ? 10 : 13)}">${esc(first + suffix)}</text>`;
  }
  svg += "</g>";
  return svg;
}

export function dashboardSVG(sources: DashboardSource[], width = 1920, height = 1080): string {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 640 || height < 360 || width > 3840 || height > 2160 || width * height > MAX_PIXELS) throw new Error("Dashboard dimensions are outside the supported limit.");
  if (sources.length > 30) throw new Error("Dashboard has too many sources.");
  if (sources.reduce((sum, source) => sum + source.components.length, 0) > 2_000) throw new Error("Dashboard has too many components.");
  const scale = Math.min(width / 1920, height / 1080);
  const pad = 48 * scale;
  const gap = 20 * scale;
  const headerH = 154 * scale;
  const columns = Math.min(4, Math.max(1, Math.floor((width - 2 * pad + gap) / 430)));
  const cardW = (width - 2 * pad - gap * (columns - 1)) / columns;
  const rows = Math.ceil(sources.length / columns);
  const cardH = (height - headerH - pad - gap * Math.max(0, rows - 1)) / Math.max(rows, 1);
  const overall = overallHealth(sources);
  const anyIssue = sources.some((source) => !source.disabled && source.freshness !== "fresh");
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#0b1422"/>`;
  svg += `<text x="${pad}" y="${60 * scale}" fill="#ffffff" font-family="Ribbon Sans" font-size="${36 * scale}" font-weight="700">Operations status</text>`;
  svg += `<text x="${pad}" y="${100 * scale}" fill="#a8b8cb" font-family="Ribbon Sans" font-size="${18 * scale}">${sources.length} configured sources · API data</text>`;
  svg += `<rect x="${width - pad - 320 * scale}" y="${24 * scale}" width="${320 * scale}" height="${62 * scale}" rx="${18 * scale}" fill="#142238" stroke="${colors[overall]}" stroke-width="${2 * scale}"/>`;
  svg += `<circle cx="${width - pad - 286 * scale}" cy="${55 * scale}" r="${9 * scale}" fill="${colors[overall]}"/><text x="${width - pad - 264 * scale}" y="${62 * scale}" fill="${colors[overall]}" font-family="Ribbon Sans" font-size="${20 * scale}" font-weight="700">${esc(healthLabel[overall])}</text>`;
  if (anyIssue) svg += `<text x="${width - pad - 320 * scale}" y="${112 * scale}" fill="#ffb86c" font-family="Ribbon Sans" font-size="${15 * scale}">One or more sources unavailable or stale</text>`;
  sources.forEach((source, index) => {
    const col = index % columns;
    const row = Math.floor(index / columns);
    svg += card(source, pad + col * (cardW + gap), headerH + row * (cardH + gap), cardW, cardH, scale);
  });
  svg += "</svg>";
  return svg;
}

export async function renderDashboardPNG(sources: DashboardSource[], width = 1920, height = 1080): Promise<Uint8Array> {
  const svg = dashboardSVG(sources, width, height);
  const isNode = typeof navigator !== "undefined" && /Node\.js/i.test(navigator.userAgent);
  let font: Uint8Array;
  if (isNode) {
    const load = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<{ readFile(path: URL): Promise<Uint8Array> }>;
    font = await load("node:fs/promises").then((fs) => fs.readFile(new URL("./dashboard-font.bin", (import.meta as ImportMeta & { url: string }).url)));
  } else {
    const fontModule = await import("./dashboard-font.bin");
    font = new Uint8Array(fontModule.default);
  }
  wasmReady ??= (async () => {
    // Node is used for deterministic fixture tests. Production Workers load the
    // statically bundled WebAssembly module through Wrangler's module rule.
    if (isNode) {
      const load = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<{ readFile(path: URL): Promise<Uint8Array> }>;
      const fs = await load("node:fs/promises");
      await initWasm(await fs.readFile(new URL("../../node_modules/@resvg/resvg-wasm/index_bg.wasm", (import.meta as ImportMeta & { url: string }).url)));
    } else {
      const module = await import("@resvg/resvg-wasm/index_bg.wasm");
      await initWasm(module.default);
    }
  })();
  await wasmReady;
  const renderer = new Resvg(svg, { font: { fontBuffers: [font], defaultFontFamily: "Ribbon Sans", loadSystemFonts: false }, textRendering: 1, shapeRendering: 1 });
  try {
    const image = renderer.render();
    try {
      if (image.width !== width || image.height !== height) throw new Error("Renderer returned unexpected dimensions.");
      const png = image.asPng();
      if (png.byteLength > MAX_PNG_BYTES || png[0] !== 137 || png[1] !== 80 || png[2] !== 78 || png[3] !== 71) throw new Error("Rendered dashboard PNG is invalid or too large.");
      return png;
    } finally { image.free(); }
  } finally { renderer.free(); }
}
