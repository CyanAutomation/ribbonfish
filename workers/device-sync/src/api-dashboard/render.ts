import { Resvg, initWasm } from "@resvg/resvg-wasm";
import { healthLabel, overallHealth, type DashboardSource, type Health } from "./model.ts";
import { svgHealthLegend, svgHealthOverview, svgStatusBadge, svgText } from "./render-components.ts";
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
  columns: number;
  cardWidth: number;
  rowHeights: number[];
  orderedSources: DashboardSource[];
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

function buildDashboardLayout(sources: DashboardSource[], width: number, height: number): DashboardLayout {
  const scale = Math.min(width / 1920, height / 1080);
  const pad = 48 * scale;
  const gap = 20 * scale;
  const headerHeight = 195 * scale;
  const minimumCardWidth = Math.max(360, 430 * scale);
  const columns = Math.min(sources.length || 1, 4, Math.max(1, Math.floor((width - 2 * pad + gap) / minimumCardWidth)));
  const rows = Math.ceil(sources.length / columns);
  const cardWidth = (width - 2 * pad - gap * (columns - 1)) / columns;
  const availableCardHeight = (height - headerHeight - pad - gap * Math.max(0, rows - 1)) / Math.max(rows, 1);
  return {
    scale,
    pad,
    gap,
    headerHeight,
    columns,
    cardWidth,
    rowHeights: Array.from({ length: rows }, () => availableCardHeight),
    orderedSources: [...sources].sort((a, b) => healthOrder(sourceHealth(a)) - healthOrder(sourceHealth(b))),
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

function renderDashboardSummary(sources: DashboardSource[], width: number, scale: number, pad: number, overall: Health): string {
  const counts = summarizeSources(sources);
  const {
    activeSources, totalServices, downServices, degradedServices, maintenanceServices,
    pendingServices, unknownServices, staleServices, staleSources, unavailableSources, disabledSources,
  } = counts;
  let svg = `<text x="${pad}" y="${60 * scale}" fill="#ffffff" font-family="Ribbon Sans" font-size="${42 * scale}" font-weight="700">Operations status</text>`;
  const statusCounts = [
    [downServices, "down"], [degradedServices, "degraded"],
    [pendingServices, "pending"], [maintenanceServices, "in maintenance"], [unknownServices, "unknown"],
  ] as const;
  const reportedIssues = statusCounts.filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}`);
  if (staleServices) reportedIssues.push(`${staleServices} ${staleServices === 1 ? "service" : "services"} with stale data`);
  if (unavailableSources) reportedIssues.push(`${unavailableSources} unavailable ${unavailableSources === 1 ? "feed" : "feeds"}`);
  const staleFeeds = staleSources - unavailableSources;
  if (staleFeeds) reportedIssues.push(`${staleFeeds} stale ${staleFeeds === 1 ? "feed" : "feeds"}`);
  const healthySummary = staleSources ? "" : totalServices ? `${totalServices} ${totalServices === 1 ? "service" : "services"} operational` : "No service data";
  const summary = `${sources.length} configured ${sources.length === 1 ? "source" : "sources"} · ${totalServices} monitored ${totalServices === 1 ? "service" : "services"}${disabledSources ? ` · ${disabledSources} disabled ${disabledSources === 1 ? "source" : "sources"}` : ""} · ${reportedIssues.length ? reportedIssues.join(" · ") : healthySummary}`;
  svg += `<text x="${pad}" y="${94 * scale}" fill="#c0cede" font-family="Ribbon Sans" font-size="${19 * scale}">${svgText(summary)}</text>`;
  svg += renderHealthOverview(activeSources, counts, width, scale, pad);
  const monitoringUnavailable = sources.some((source) => !source.disabled && source.freshness === "unavailable");
  const badgeLabel = monitoringUnavailable ? "Monitoring data unavailable" : overall === "stale" ? "Monitoring data delayed" : healthLabel[overall];
  svg += svgStatusBadge(width - pad - 390 * scale, 24 * scale, 390 * scale, 62 * scale, scale, badgeLabel, dashboardColors[overall]);
  svg += svgHealthLegend(pad, 166 * scale, width - 2 * pad, scale);
  return svg;
}

function renderHealthOverview(activeSources: DashboardSource[], counts: DashboardCounts, width: number, scale: number, pad: number): string {
  const overview: Array<{ label: string; count: number; color: string; showCount?: boolean }> = [];
  const freshOperational = activeSources.reduce((sum, source) => sum + (source.freshness === "fresh" ? source.components.filter((component) => !component.isGroup && component.status === "operational").length : 0), 0);
  if (freshOperational) overview.push({ label: "Operational", count: freshOperational, color: dashboardColors.operational });
  const statuses: Array<[number, string, Health]> = [
    [counts.downServices, "Down", "down"], [counts.degradedServices, "Degraded", "degraded"],
    [counts.pendingServices, "Pending", "pending"], [counts.maintenanceServices, "Maintenance", "maintenance"], [counts.unknownServices, "Unknown", "unknown"],
  ];
  for (const [count, label, health] of statuses) if (count) overview.push({ label, count, color: dashboardColors[health] });
  if (counts.staleServices) overview.push({ label: `${counts.staleServices} ${counts.staleServices === 1 ? "service" : "services"} with stale data`, count: 1, color: dashboardColors.stale, showCount: false });
  if (counts.unavailableSources) overview.push({ label: `${counts.unavailableSources} ${counts.unavailableSources === 1 ? "unavailable feed" : "unavailable feeds"}`, count: 1, color: dashboardColors.stale, showCount: false });
  const staleFeeds = counts.staleSources - counts.unavailableSources;
  if (staleFeeds) overview.push({ label: `${staleFeeds} ${staleFeeds === 1 ? "stale feed" : "stale feeds"}`, count: 1, color: dashboardColors.stale, showCount: false });
  return svgHealthOverview(pad, 132 * scale, width - 2 * pad, scale, overview);
}

function renderDashboardCards(layout: DashboardLayout): string {
  return layout.orderedSources.map((source, index) => {
    const col = index % layout.columns;
    const row = Math.floor(index / layout.columns);
    const y = layout.headerHeight + layout.rowHeights.slice(0, row).reduce((sum, value) => sum + value + layout.gap, 0);
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

export function dashboardSVG(sources: DashboardSource[], width = 1920, height = 1080): string {
  validateDashboard(sources, width, height);
  const layout = buildDashboardLayout(sources, width, height);
  const overall = overallHealth(sources);
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#0b1422"/>`;
  svg += renderDashboardSummary(sources, width, layout.scale, layout.pad, overall);
  if (!sources.length) svg += `<text x="${layout.pad}" y="${layout.headerHeight + 45 * layout.scale}" fill="#c0cede" font-family="Ribbon Sans" font-size="${20 * layout.scale}">No status sources are configured.</text>`;
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
