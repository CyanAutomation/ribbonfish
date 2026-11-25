import { Resvg, initWasm } from "@resvg/resvg-wasm";
import { healthLabel, overallHealth, type DashboardSource, type Health } from "./model.ts";
import { svgHealthOverview, svgMaintenanceAgenda, svgStatusBadge, svgText, type SvgMaintenanceAgendaEvent } from "./render-components.ts";
import { renderCard } from "./render-card.ts";
import { dashboardColors, healthOrder, sourceHealth } from "./render-health.ts";

const MAX_PIXELS = 3840 * 2160;
const MAX_PNG_BYTES = 32 * 1024 * 1024;
let wasmReady: Promise<void> | undefined;

type DashboardLayout = {
  scale: number;
  pad: number;
  gap: number;
  headerHeight: number;
  agendaHeight: number;
  agendaTop: number;
  cardTop: number;
  columns: number;
  cardWidth: number;
  rowHeights: number[];
  orderedSources: DashboardSource[];
  maintenanceEvents: SvgMaintenanceAgendaEvent[];
  visibleMaintenanceEvents: SvgMaintenanceAgendaEvent[];
  hiddenMaintenanceEvents: number;
};

type DashboardCounts = {
  activeSources: DashboardSource[];
  totalServices: number;
  downServices: number;
  degradedServices: number;
  maintenanceServices: number;
  pendingServices: number;
  unknownServices: number;
  staleServices: number;
  staleSources: number;
  unavailableSources: number;
  disabledSources: number;
};

function validateDashboard(sources: DashboardSource[], width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 640 || height < 360 || width > 3840 || height > 2160 || width * height > MAX_PIXELS) {
    throw new Error("Dashboard dimensions are outside the supported limit.");
  }
  if (sources.length > 30) throw new Error("Dashboard has too many sources.");
  if (sources.reduce((sum, source) => sum + source.components.length, 0) > 2_000) throw new Error("Dashboard has too many components.");
}

function buildMaintenanceEvents(sources: DashboardSource[]): SvgMaintenanceAgendaEvent[] {
  const deduplicated = new Map<string, SvgMaintenanceAgendaEvent>();
  const activeStatus = (status: string) => /active|in.?progress|ongoing|started/i.test(status);
  const impactRanks: Record<string, number> = { critical: 0, major: 1, minor: 2, maintenance: 3, unknown: 4 };
  const impactRank = (impact: string | undefined) => impactRanks[impact?.toLowerCase() ?? "unknown"] ?? 4;
  for (const source of sources) {
    if (source.disabled || source.freshness !== "fresh") continue;
    for (const maintenance of source.maintenance) {
      const normalizedName = maintenance.name.trim().toLocaleLowerCase().replace(/\s+/g, " ");
      const start = maintenance.scheduledFor && Number.isFinite(Date.parse(maintenance.scheduledFor))
        ? new Date(maintenance.scheduledFor).toISOString()
        : undefined;
      const key = `${normalizedName}|${start ?? `unscheduled:${maintenance.status.toLocaleLowerCase()}`}`;
      const affected = maintenance.componentNames?.length
        ? maintenance.componentNames
        : source.components.filter((component) => !component.isGroup && component.status === "maintenance").map((component) => component.name);
      const existing = deduplicated.get(key);
      if (existing) {
        existing.sources = [...new Set([...existing.sources, source.displayName])];
        existing.affected = [...new Set([...existing.affected, ...affected])];
        if (activeStatus(maintenance.status) && !activeStatus(existing.status)) existing.status = maintenance.status;
        if (impactRank(maintenance.impact) < impactRank(existing.impact)) existing.impact = maintenance.impact;
        if (maintenance.updatedAt && (!existing.updatedAt || Date.parse(maintenance.updatedAt) > Date.parse(existing.updatedAt))) existing.updatedAt = maintenance.updatedAt;
        if (source.fetchedAt && (!existing.referenceAt || Date.parse(source.fetchedAt) > Date.parse(existing.referenceAt))) existing.referenceAt = source.fetchedAt;
      } else {
        deduplicated.set(key, {
          name: maintenance.name,
          status: maintenance.status,
          impact: maintenance.impact,
          color: dashboardColors.maintenance,
          scheduledFor: maintenance.scheduledFor,
          scheduledUntil: maintenance.scheduledUntil,
          referenceAt: source.fetchedAt,
          updatedAt: maintenance.updatedAt,
          sources: [source.displayName],
          affected: [...new Set(affected)],
        });
      }
    }
  }
  return [...deduplicated.values()].sort((a, b) => Number(activeStatus(b.status)) - Number(activeStatus(a.status))
    || (Date.parse(a.scheduledFor ?? "") || Number.MAX_SAFE_INTEGER) - (Date.parse(b.scheduledFor ?? "") || Number.MAX_SAFE_INTEGER)
    || a.name.localeCompare(b.name));
}

function buildDashboardLayout(sources: DashboardSource[], width: number, height: number): DashboardLayout {
  const scale = Math.min(width / 1920, height / 1080);
  const pad = 48 * scale;
  const gap = 20 * scale;
  const headerHeight = 166 * scale;
  const minimumCardWidth = Math.max(360, 430 * scale);
  const columns = Math.min(sources.length || 1, 4, Math.max(1, Math.floor((width - 2 * pad + gap) / minimumCardWidth)));
  const rows = Math.ceil(sources.length / columns);
  const cardWidth = (width - 2 * pad - gap * (columns - 1)) / columns;
  const maintenanceEvents = buildMaintenanceEvents(sources);
  const maxVisibleMaintenanceEvents = rows === 1 && height >= 540 ? 2 : 1;
  const visibleMaintenanceEvents = maintenanceEvents.slice(0, maxVisibleMaintenanceEvents);
  const hiddenMaintenanceEvents = maintenanceEvents.length - visibleMaintenanceEvents.length;
  const agendaHeight = maintenanceEvents.length
    ? (42 + visibleMaintenanceEvents.length * 144 + (hiddenMaintenanceEvents ? 25 : 0) + 12) * scale
    : 0;
  const cardTop = headerHeight;
  const agendaTop = height - pad - agendaHeight;
  const agendaGap = agendaHeight ? gap : 0;
  const availableCardHeight = (agendaTop - cardTop - agendaGap - gap * Math.max(0, rows - 1)) / Math.max(rows, 1);
  return {
    scale,
    pad,
    gap,
    headerHeight,
    agendaHeight,
    agendaTop,
    cardTop,
    columns,
    cardWidth,
    rowHeights: Array.from({ length: rows }, () => availableCardHeight),
    orderedSources: sources.toSorted((a, b) => healthOrder(sourceHealth(a)) - healthOrder(sourceHealth(b))),
    maintenanceEvents,
    visibleMaintenanceEvents,
    hiddenMaintenanceEvents,
  };
}

function countServices(sources: DashboardSource[], status: Health): number {
  return sources.filter((source) => source.freshness === "fresh").reduce((sum, source) => sum + source.components.filter((component) => !component.isGroup && component.status === status).length, 0);
}

function summarizeSources(sources: DashboardSource[]): DashboardCounts {
  const activeSources = sources.filter((source) => !source.disabled);
  return {
    activeSources,
    totalServices: activeSources.reduce((sum, source) => sum + source.components.filter((component) => !component.isGroup).length, 0),
    downServices: countServices(activeSources, "down"),
    degradedServices: countServices(activeSources, "degraded"),
    maintenanceServices: countServices(activeSources, "maintenance"),
    pendingServices: countServices(activeSources, "pending"),
    unknownServices: countServices(activeSources, "unknown"),
    staleServices: activeSources.filter((source) => source.freshness !== "unavailable").reduce((sum, source) => sum + source.components.filter((component) => !component.isGroup && (source.freshness === "stale" || component.status === "stale")).length, 0),
    staleSources: activeSources.filter((source) => source.freshness !== "fresh").length,
    unavailableSources: activeSources.filter((source) => source.freshness === "unavailable").length,
    disabledSources: sources.length - activeSources.length,
  };
}

function renderDashboardSummary(sources: DashboardSource[], width: number, scale: number, pad: number, overall: Health, maintenanceCount: number): string {
  const counts = summarizeSources(sources);
  const { activeSources, totalServices, disabledSources } = counts;
  let svg = `<text x="${pad}" y="${60 * scale}" fill="#ffffff" font-family="Ribbon Sans" font-size="${42 * scale}" font-weight="700">Operations status</text>`;
  const summary = `${sources.length} configured ${sources.length === 1 ? "source" : "sources"} · ${totalServices} monitored ${totalServices === 1 ? "service" : "services"}${disabledSources ? ` · ${disabledSources} disabled ${disabledSources === 1 ? "source" : "sources"}` : ""}`;
  svg += `<text x="${pad}" y="${94 * scale}" fill="#c0cede" font-family="Ribbon Sans" font-size="${19 * scale}">${svgText(summary)}</text>`;
  svg += renderHealthOverview(activeSources, counts, width, scale, pad, maintenanceCount);
  const monitoringUnavailable = sources.some((source) => !source.disabled && source.freshness === "unavailable");
  const badgeLabel = monitoringUnavailable ? "Monitoring data unavailable" : overall === "stale" ? "Monitoring data delayed"
    : overall === "operational" && totalServices ? `${totalServices}/${totalServices} Operational` : healthLabel[overall];
  svg += svgStatusBadge(width - pad - 390 * scale, 24 * scale, 390 * scale, 62 * scale, scale, badgeLabel, dashboardColors[overall]);
  return svg;
}

function renderHealthOverview(activeSources: DashboardSource[], counts: DashboardCounts, width: number, scale: number, pad: number, maintenanceCount: number): string {
  const overview: Array<{ label: string; count: number; color: string; showCount?: boolean }> = [];
  const hasIssues = counts.downServices + counts.degradedServices + counts.pendingServices + counts.maintenanceServices + counts.unknownServices + counts.staleServices + counts.unavailableSources + counts.staleSources > 0;
  const freshOperational = hasIssues ? activeSources.reduce((sum, source) => sum + (source.freshness === "fresh" ? source.components.filter((component) => !component.isGroup && component.status === "operational").length : 0), 0) : 0;
  if (freshOperational) overview.push({ label: "Operational", count: freshOperational, color: dashboardColors.operational });
  const statuses: Array<[number, string, Health]> = [
    [counts.downServices, "Down", "down"], [counts.degradedServices, "Degraded", "degraded"],
    [counts.pendingServices, "Pending", "pending"], [counts.maintenanceServices, "Maintenance", "maintenance"], [counts.unknownServices, "Unknown", "unknown"],
  ];
  for (const [count, label, health] of statuses) if (count) overview.push({ label, count, color: dashboardColors[health] });
  if (maintenanceCount) overview.push({ label: "scheduled maintenance", count: maintenanceCount, color: dashboardColors.maintenance });
  if (counts.staleServices) overview.push({ label: `${counts.staleServices} ${counts.staleServices === 1 ? "service" : "services"} with stale data`, count: 1, color: dashboardColors.stale, showCount: false });
  if (counts.unavailableSources) overview.push({ label: `${counts.unavailableSources} ${counts.unavailableSources === 1 ? "unavailable feed" : "unavailable feeds"}`, count: 1, color: dashboardColors.stale, showCount: false });
  const staleFeeds = counts.staleSources - counts.unavailableSources;
  if (staleFeeds) overview.push({ label: `${staleFeeds} ${staleFeeds === 1 ? "stale feed" : "stale feeds"}`, count: 1, color: dashboardColors.stale, showCount: false });
  return overview.length ? svgHealthOverview(pad, 132 * scale, width - 2 * pad, scale, overview) : "";
}

function renderDashboardCards(layout: DashboardLayout): string {
  return layout.orderedSources.map((source, index) => {
    const col = index % layout.columns;
    const row = Math.floor(index / layout.columns);
    const y = layout.cardTop + layout.rowHeights.slice(0, row).reduce((sum, value) => sum + value + layout.gap, 0);
    const rowCount = Math.min(layout.columns, layout.orderedSources.length - row * layout.columns);
    const rowOffset = (layout.columns - rowCount) * (layout.cardWidth + layout.gap) / 2;
    return renderCard({
      source,
      x: layout.pad + rowOffset + col * (layout.cardWidth + layout.gap),
      y,
      width: layout.cardWidth,
      height: layout.rowHeights[row],
      scale: layout.scale,
    });
  }).join("");
}

function renderMaintenanceAgenda(layout: DashboardLayout): string {
  if (!layout.visibleMaintenanceEvents.length) return "";
  return svgMaintenanceAgenda({
    x: layout.pad,
    y: layout.agendaTop,
    width: layout.cardWidth * layout.columns + layout.gap * (layout.columns - 1),
    height: layout.agendaHeight,
    scale: layout.scale,
    events: layout.visibleMaintenanceEvents,
    hiddenCount: layout.hiddenMaintenanceEvents,
  });
}

export function dashboardSVG(sources: DashboardSource[], width = 1920, height = 1080): string {
  validateDashboard(sources, width, height);
  const layout = buildDashboardLayout(sources, width, height);
  const overall = overallHealth(sources);
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#0b1422"/>`;
  svg += renderDashboardSummary(sources, width, layout.scale, layout.pad, overall, layout.maintenanceEvents.length);
  if (!sources.length) svg += `<text x="${layout.pad}" y="${layout.headerHeight + 45 * layout.scale}" fill="#c0cede" font-family="Ribbon Sans" font-size="${20 * layout.scale}">No status sources are configured.</text>`;
  svg += renderMaintenanceAgenda(layout);
  svg += renderDashboardCards(layout);
  return svg + "</svg>";
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
