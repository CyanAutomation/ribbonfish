import { Resvg, initWasm } from "@resvg/resvg-wasm";
import { healthLabel, overallHealth, type DashboardSource, type Health } from "./model.ts";
import { svgEventPanel, svgGroupSummary, svgPanel, svgServiceRow, svgStatusBadge, svgStatusDot, svgText, truncateText, type SvgDashboardEvent } from "./render-components.ts";

const MAX_PIXELS = 3840 * 2160;
const MAX_PNG_BYTES = 32 * 1024 * 1024;
let wasmReady: Promise<void> | undefined;
const colors: Record<Health, string> = {
  operational: "#20c997", degraded: "#f6c453", down: "#ff647c", maintenance: "#a78bfa",
  pending: "#60a5fa", unknown: "#94a3b8", stale: "#fb923c",
};

function healthOrder(health: Health): number {
  return ({ down: 0, degraded: 1, stale: 2, pending: 3, unknown: 4, maintenance: 5, operational: 6 })[health];
}

function formatClock(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return undefined;
  return `${date.toISOString().slice(11, 16)} UTC`;
}

function formatFetched(value: string, freshness: DashboardSource["freshness"]): string | undefined {
  const time = formatClock(value);
  return time ? `${freshness === "fresh" ? "Updated" : "Last check"} ${time}` : undefined;
}

function recentGroupChecks(components: DashboardSource["components"], fetchedAt: string): string[] {
  const reference = Date.parse(fetchedAt);
  if (!Number.isFinite(reference)) return [];
  const buckets: Array<Health | undefined> = Array.from({ length: 12 }, () => undefined);
  const rank = (health: Health) => ({ down: 0, degraded: 1, stale: 2, pending: 3, unknown: 4, maintenance: 5, operational: 6 })[health];
  for (const component of components) for (const beat of component.history ?? []) {
    const age = reference - Date.parse(beat.at);
    if (!Number.isFinite(age) || age < 0 || age >= 24 * 60 * 60_000) continue;
    const index = 11 - Math.floor(age / (2 * 60 * 60_000));
    const existing = buckets[index];
    if (!existing || rank(beat.status) < rank(existing)) buckets[index] = beat.status;
  }
  return buckets.some(Boolean) ? buckets.map((state) => state ?? "unknown") : [];
}

type ServiceDisplayRow = { kind: "group"; name: string } | { kind: "empty"; name: string } | { kind: "summary"; count: number; history: string[] } | { kind: "service"; component: DashboardSource["components"][number] };

function buildServiceRows(source: DashboardSource): ServiceDisplayRow[] {
  const parentGroups = (source.groups ?? source.components.filter((component) => component.isGroup).map((component) => ({ id: component.id, name: component.name, order: component.groupOrder ?? component.componentOrder ?? 0 })))
    .sort((a, b) => a.order - b.order);
  const services = source.components.filter((component) => !component.isGroup);
  const rows: ServiceDisplayRow[] = [];
  const addGroupRows = (name: string, components: typeof services, groupHeader: boolean) => {
    if (groupHeader) rows.push({ kind: "group", name });
    if (!components.length) { rows.push({ kind: "empty", name }); return; }
    const issues = components.filter((component) => component.status !== "operational");
    const operationalCount = components.length - issues.length;
    if (issues.length) {
      issues.sort((a, b) => healthOrder(a.status) - healthOrder(b.status) || (a.componentOrder ?? 0) - (b.componentOrder ?? 0));
      for (const component of issues) rows.push({ kind: "service", component });
      if (operationalCount) rows.push({ kind: "summary", count: operationalCount, history: recentGroupChecks(components.filter((component) => component.status === "operational"), source.fetchedAt) });
    } else rows.push({ kind: "summary", count: operationalCount, history: recentGroupChecks(components, source.fetchedAt) });
  };
  const seenServices = new Set<string>();
  for (const parent of parentGroups) {
    const children = services.filter((component) => component.groupId === parent.id || (!component.groupId && component.groupName === parent.name))
      .sort((a, b) => healthOrder(a.status) - healthOrder(b.status) || (a.componentOrder ?? 0) - (b.componentOrder ?? 0));
    addGroupRows(parent.name, children, true);
    for (const component of children) seenServices.add(component.id);
  }
  const remaining = services.filter((component) => !seenServices.has(component.id))
    .sort((a, b) => (a.groupOrder ?? 0) - (b.groupOrder ?? 0) || healthOrder(a.status) - healthOrder(b.status) || (a.componentOrder ?? 0) - (b.componentOrder ?? 0));
  const groups = new Map<string, typeof remaining>();
  for (const component of remaining) {
    const name = component.groupName ?? "Services";
    groups.set(name, [...(groups.get(name) ?? []), component]);
  }
  const orderedGroups = [...groups.entries()];
  for (const [groupName, components] of orderedGroups) addGroupRows(groupName, components, components.length > 0 && (parentGroups.length > 0 || orderedGroups.length > 1 || groupName !== "Services"));
  return rows;
}

function cardHeightFor(source: DashboardSource, scale: number): number {
  const rows = buildServiceRows(source);
  const hasDetails = rows.some((row) => row.kind === "summary" || row.kind === "service" || row.kind === "empty");
  const eventCount = Math.min(3, source.incidents.length + source.maintenance.length);
  const eventPanelHeight = eventCount ? 14 + eventCount * 44 : 0;
  const serviceLines = rows.length;
  return Math.max(176 * scale, 150 * scale + serviceLines * 24 * scale + (hasDetails ? 20 * scale : 0) + eventPanelHeight * scale);
}

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
  const hasParentGroups = Boolean(source.groups?.length || source.components.some((component) => component.isGroup));
  const contentY = y + s(compact ? 60 : source.error ? 120 : 100);
  const lineH = s(compact ? 18 : Math.max(20, Math.min(24, height / 18)));
  const services = source.components.filter((component) => !component.isGroup);
  const serviceRows = buildServiceRows(source);
  const events: SvgDashboardEvent[] = [
    ...source.incidents.map((item) => ({ kind: "Incident" as const, name: item.name, status: item.status, impact: item.impact,
      color: item.impact === "critical" || item.impact === "major" ? colors.down : colors.degraded, updatedAt: item.updatedAt })),
    ...source.maintenance.map((item) => ({ kind: "Maintenance" as const, name: item.name, status: item.status, impact: item.impact,
      color: colors.maintenance, updatedAt: item.updatedAt, scheduledFor: item.scheduledFor })),
  ];
  const visibleEvents = events.slice(0, 3);
  const eventAreaHeight = visibleEvents.length ? s(14 + visibleEvents.length * 44) : 0;
  const hasDetails = serviceRows.some((row) => row.kind === "service" || row.kind === "empty" || row.kind === "summary");
  const contentOffset = compact ? 60 : source.error ? 120 : 100;
  const maxLines = Math.max(0, Math.floor((height - s(contentOffset) - eventAreaHeight - s(hasDetails ? 20 : 8)) / lineH));
  const showRows = serviceRows.slice(0, maxLines);
  while (showRows.at(-1)?.kind === "group") showRows.pop();
  const visibleServices = showRows.reduce((count, row) => count + (row.kind === "service" ? 1 : row.kind === "summary" ? row.count : 0), 0);
  const hiddenServices = Math.max(0, services.length - visibleServices);
  const hiddenGroups = Math.max(0, serviceRows.filter((row) => row.kind === "group").length - showRows.filter((row) => row.kind === "group").length);
  let svg = `<g>${svgPanel(x, y, width, height, scale, colors[health])}`;
  svg += `<text x="${left}" y="${y + s(compact ? 25 : 42)}" fill="#f5f8fc" font-size="${s(compact ? 17 : 26)}" font-weight="700">${svgText(truncateText(source.displayName, Math.floor((width - s(185)) / s(compact ? 10 : 17))))}</text>`;
  svg += svgStatusDot(x + width - s(150), y + s(compact ? 20 : 34), s(7), colors[health]);
  const sourceStatusLabel = source.disabled ? "Disabled" : healthLabel[health];
  svg += `<text x="${x + width - s(136)}" y="${y + s(compact ? 26 : 41)}" fill="${svgText(colors[health])}" font-size="${s(compact ? 13 : 16)}">${svgText(sourceStatusLabel)}</text>`;
  if (!compact) {
    const sourceIdentity = source.hostname ?? (source.provider === "uptime-kuma" ? "Uptime Kuma" : "Statuspage");
    const updated = formatFetched(source.fetchedAt, source.freshness);
    const identityLimit = Math.max(8, Math.floor((width - pad * 2 - s(170)) / (s(8.5))));
    svg += `<text x="${left}" y="${y + s(70)}" fill="#b9c9dc" font-size="${s(15)}">${svgText(truncateText(sourceIdentity, identityLimit))}</text>`;
    if (updated) svg += `<text x="${x + width - pad}" y="${y + s(70)}" text-anchor="end" fill="#b9c9dc" font-size="${s(14)}">${svgText(updated)}</text>`;
    if (source.error) svg += `<text x="${left}" y="${y + s(94)}" fill="#ffb86c" font-size="${s(14)}">${svgText(truncateText(source.error, Math.floor(width / s(9))))}</text>`;
  }
  if (source.disabled) svg += `<text x="${left}" y="${y + s(compact ? 48 : 106)}" fill="#aab8ca" font-size="${s(17)}">Source is disabled and not polled</text>`;
  else if (!services.length && !source.error && !hasParentGroups) svg += `<text x="${left}" y="${y + s(compact ? 48 : 106)}" fill="#aab8ca" font-size="${s(17)}">No component data available</text>`;
  showRows.forEach((row, index) => {
    const cy = contentY + index * lineH;
    if (row.kind === "group") {
      svg += `<text x="${left}" y="${cy}" fill="#c1d1e2" font-size="${s(compact ? 12 : 15)}" font-weight="700">${svgText(truncateText(row.name, Math.floor(width / s(10))))}</text>`;
      return;
    }
    if (row.kind === "empty") {
      svg += `<text x="${left + s(16)}" y="${cy}" fill="#aab8ca" font-size="${s(compact ? 11 : 14)}">No services reported</text>`;
      return;
    }
    if (row.kind === "summary") {
      svg += svgGroupSummary({ x: left + s(16), y: cy, right: x + width - pad, scale, label: "operational", count: row.count, history: row.history });
      return;
    }
    const { name, status } = row.component;
    const color = colors[status as Health] ?? colors.unknown;
    const statusText = healthLabel[status as Health] ?? healthLabel.unknown;
    const changedTime = formatClock(row.component.statusChangedAt);
    const sampledTime = formatClock(row.component.sampledAt);
    const stateChangeTime = changedTime && ["down", "degraded", "maintenance"].includes(status) ? changedTime : undefined;
    const statusMeta = stateChangeTime ? `Since ${stateChangeTime}` : sampledTime ? `Checked ${sampledTime}` : undefined;
    const right = x + width - pad;
    svg += svgServiceRow({ x: left, y: cy, right, scale, name, status: statusText, color, statusMeta, compact });
  });
  if (hiddenServices || hiddenGroups) {
    const message = [hiddenGroups ? `${hiddenGroups} more groups` : "", hiddenServices ? `${hiddenServices} more services` : ""].filter(Boolean).join(" · ");
    svg += `<text x="${left}" y="${y + height - eventAreaHeight - s(10)}" fill="#b7c8da" font-size="${s(compact ? 10 : 13)}">+ ${svgText(message)}</text>`;
  }
  if (visibleEvents.length) {
    svg += svgEventPanel({ x: x + s(12), y: y + height - eventAreaHeight, width: width - s(24), height: eventAreaHeight, scale, events: visibleEvents, hiddenCount: events.length - visibleEvents.length });
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
  const columns = Math.min(sources.length || 1, 4, Math.max(1, Math.floor((width - 2 * pad + gap) / 430)));
  const cardW = (width - 2 * pad - gap * (columns - 1)) / columns;
  const rows = Math.ceil(sources.length / columns);
  const orderedSources = [...sources].sort((a, b) => healthOrder(sourceHealth(a)) - healthOrder(sourceHealth(b)));
  const availableCardHeight = (height - headerH - pad - gap * Math.max(0, rows - 1)) / Math.max(rows, 1);
  const rowHeights = Array.from({ length: rows }, (_, row) => {
    const rowSources = orderedSources.slice(row * columns, (row + 1) * columns);
    const desired = Math.max(176 * scale, ...rowSources.map((source) => cardHeightFor(source, scale)));
    return Math.min(availableCardHeight, desired);
  });
  const overall = overallHealth(sources);
  const activeSources = sources.filter((source) => !source.disabled);
  const totalServices = activeSources.reduce((sum, source) => sum + source.components.filter((component) => !component.isGroup).length, 0);
  const downServices = activeSources.reduce((sum, source) => sum + source.components.filter((component) => !component.isGroup && component.status === "down").length, 0);
  const degradedServices = activeSources.reduce((sum, source) => sum + source.components.filter((component) => !component.isGroup && component.status === "degraded").length, 0);
  const maintenanceServices = activeSources.reduce((sum, source) => sum + source.components.filter((component) => !component.isGroup && component.status === "maintenance").length, 0);
  const pendingServices = activeSources.reduce((sum, source) => sum + source.components.filter((component) => !component.isGroup && component.status === "pending").length, 0);
  const unknownServices = activeSources.reduce((sum, source) => sum + source.components.filter((component) => !component.isGroup && component.status === "unknown").length, 0);
  const staleServices = activeSources.reduce((sum, source) => sum + source.components.filter((component) => !component.isGroup && component.status === "stale").length, 0);
  const staleSources = activeSources.filter((source) => source.freshness !== "fresh").length;
  const disabledSources = sources.length - activeSources.length;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#0b1422"/>`;
  svg += `<text x="${pad}" y="${60 * scale}" fill="#ffffff" font-family="Ribbon Sans" font-size="${36 * scale}" font-weight="700">Operations status</text>`;
  const summary = `${sources.length} configured ${sources.length === 1 ? "source" : "sources"} · ${totalServices} active ${totalServices === 1 ? "service" : "services"}${disabledSources ? ` · ${disabledSources} disabled ${disabledSources === 1 ? "source" : "sources"}` : ""} · ${downServices} down · ${degradedServices} degraded · ${staleServices} stale · ${pendingServices} pending · ${maintenanceServices} in maintenance · ${unknownServices} unknown`;
  svg += `<text x="${pad}" y="${100 * scale}" fill="#c0cede" font-family="Ribbon Sans" font-size="${17 * scale}">${svgText(summary)}</text>`;
  svg += svgStatusBadge(width - pad - 320 * scale, 24 * scale, 320 * scale, 62 * scale, scale, healthLabel[overall], colors[overall]);
  if (staleSources) svg += `<text x="${width - pad - 320 * scale}" y="${112 * scale}" fill="#ffbd78" font-family="Ribbon Sans" font-size="${15 * scale}" font-weight="700">${staleSources} source${staleSources === 1 ? "" : "s"} stale or unavailable</text>`;
  if (!sources.length) svg += `<text x="${pad}" y="${(headerH + 45 * scale)}" fill="#c0cede" font-family="Ribbon Sans" font-size="${20 * scale}">No status sources are configured.</text>`;
  orderedSources.forEach((source, index) => {
    const col = index % columns;
    const row = Math.floor(index / columns);
    const y = headerH + rowHeights.slice(0, row).reduce((sum, value) => sum + value + gap, 0);
    svg += card(source, pad + col * (cardW + gap), y, cardW, rowHeights[row], scale);
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
