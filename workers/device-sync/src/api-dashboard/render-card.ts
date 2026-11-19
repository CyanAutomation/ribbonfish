import { healthLabel, type DashboardSource, type Health } from "./model.ts";
import {
  svgEventPanel,
  svgFreshnessBadge,
  svgGroupSummary,
  svgPanel,
  svgProviderIdentity,
  svgServiceRow,
  svgSourceNotice,
  svgStatusDot,
  svgText,
  truncateText,
  type SvgDashboardEvent,
} from "./render-components.ts";
import { dashboardColors as colors, healthOrder, sourceHealth } from "./render-health.ts";

type ServiceDisplayRow =
  | { kind: "group"; name: string }
  | { kind: "empty"; name: string }
  | { kind: "summary"; count: number }
  | { kind: "service"; component: DashboardSource["components"][number] };

type CardProps = {
  source: DashboardSource;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
};

type CardLayout = CardProps & {
  health: Health;
  compact: boolean;
  pad: number;
  left: number;
  services: DashboardSource["components"];
  hasParentGroups: boolean;
  serviceRows: ServiceDisplayRow[];
  events: SvgDashboardEvent[];
  visibleEvents: SvgDashboardEvent[];
  eventAreaHeight: number;
  hasDetails: boolean;
  contentY: number;
  lineHeight: number;
  visibleRows: ServiceDisplayRow[];
  hiddenServices: number;
  hiddenGroups: number;
  sourceStatusLabel: string;
  statusTextX: number;
  statusDotX: number;
  titleMaxChars: number;
};

function formatClock(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return undefined;
  return `${date.toISOString().slice(11, 16)} UTC`;
}

function formatFetched(value: string): string | undefined {
  const time = formatClock(value);
  return time ? `Checked ${time}` : undefined;
}

function lastSuccessfulUpdate(source: DashboardSource): string | undefined {
  const timestamps = Object.values(source.cache ?? {}).map((metadata) => metadata?.contentFetchedAt)
    .filter((value): value is string => Boolean(value) && Number.isFinite(Date.parse(value)));
  if (!timestamps.length) return undefined;
  return formatClock(timestamps.sort((a, b) => Date.parse(b) - Date.parse(a))[0]);
}

function formatAge(sampledAt: string | null | undefined, fetchedAt: string): string | undefined {
  if (!sampledAt) return undefined;
  const ageMinutes = Math.max(0, Math.round((Date.parse(fetchedAt) - Date.parse(sampledAt)) / 60_000));
  if (!Number.isFinite(ageMinutes)) return undefined;
  const hours = Math.floor(ageMinutes / 60);
  const minutes = ageMinutes % 60;
  if (hours && minutes) return `${hours}h ${minutes}m old`;
  if (hours) return `${hours}h old`;
  return `${minutes}m old`;
}

function freshnessDescription(source: DashboardSource): string {
  if (source.disabled) return "Not polled";
  if (source.freshness === "fresh") return "Data fresh";
  if (source.freshness === "stale") return "Service data stale";
  return "Feed unavailable";
}

function freshnessColor(source: DashboardSource): string {
  if (source.disabled) return colors.unknown;
  if (source.freshness === "fresh") return colors.operational;
  return colors.stale;
}

function addGroupRows(
  rows: ServiceDisplayRow[],
  source: DashboardSource,
  name: string,
  components: DashboardSource["components"],
  groupHeader: boolean,
) {
  if (groupHeader) rows.push({ kind: "group", name });
  if (!components.length) {
    rows.push({ kind: "empty", name });
    return;
  }
  if (source.freshness !== "fresh") {
    for (const component of components) rows.push({ kind: "service", component });
    return;
  }
  const issues = components.filter((component) => component.status !== "operational");
  const operationalCount = components.length - issues.length;
  if (source.provider === "atlassian-statuspage") {
    const visible = components.slice(0, 8);
    for (const component of visible) rows.push({ kind: "service", component });
    const operationalOverflow = components.slice(8).filter((component) => component.status === "operational").length;
    if (operationalOverflow) rows.push({ kind: "summary", count: operationalOverflow });
  } else if (issues.length) {
    issues.sort((a, b) => healthOrder(a.status) - healthOrder(b.status) || (a.componentOrder ?? 0) - (b.componentOrder ?? 0));
    for (const component of issues) rows.push({ kind: "service", component });
    if (operationalCount) rows.push({ kind: "summary", count: operationalCount });
  } else if (source.provider === "uptime-kuma") {
    rows.push({ kind: "summary", count: operationalCount });
  } else {
    rows.push({ kind: "summary", count: operationalCount });
  }
}

function buildServiceRows(source: DashboardSource): ServiceDisplayRow[] {
  const parentGroups = (source.groups ?? source.components.filter((component) => component.isGroup)
    .map((component) => ({ id: component.id, name: component.name, order: component.groupOrder ?? component.componentOrder ?? 0 })))
    .sort((a, b) => a.order - b.order);
  const services = source.components.filter((component) => !component.isGroup);
  const rows: ServiceDisplayRow[] = [];
  const seenServices = new Set<string>();
  for (const parent of parentGroups) {
    const children = services.filter((component) => component.groupId === parent.id || (!component.groupId && component.groupName === parent.name))
      .sort((a, b) => healthOrder(a.status) - healthOrder(b.status) || (a.componentOrder ?? 0) - (b.componentOrder ?? 0));
    addGroupRows(rows, source, parent.name, children, true);
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
  for (const [groupName, components] of orderedGroups) {
    addGroupRows(rows, source, groupName, components, components.length > 0 && (parentGroups.length > 0 || orderedGroups.length > 1 || groupName !== "Services"));
  }
  return rows;
}

function buildCardEvents(source: DashboardSource): SvgDashboardEvent[] {
  return [
    ...source.incidents.map((item) => ({ kind: "Incident" as const, name: item.name, status: item.status, impact: item.impact,
      color: item.impact === "critical" || item.impact === "major" ? colors.down : colors.degraded, updatedAt: item.updatedAt })),
    ...source.maintenance.map((item) => ({ kind: "Maintenance" as const, name: item.name, status: item.status, impact: item.impact,
      color: colors.maintenance, updatedAt: item.updatedAt, scheduledFor: item.scheduledFor, referenceAt: source.fetchedAt })),
  ];
}

function visibleRows(rows: ServiceDisplayRow[], maxLines: number): ServiceDisplayRow[] {
  const visible = rows.slice(0, maxLines);
  while (visible.at(-1)?.kind === "group") visible.pop();
  return visible;
}

function buildCardLayout(props: CardProps): CardLayout {
  const { source, x, y, width, height, scale } = props;
  const s = (n: number) => n * scale;
  const health = sourceHealth(source);
  const compact = height < s(170);
  const pad = s(22);
  const left = x + pad;
  const services = source.components.filter((component) => !component.isGroup);
  const hasParentGroups = Boolean(source.groups?.length || source.components.some((component) => component.isGroup));
  const serviceRows = buildServiceRows(source);
  const events = buildCardEvents(source);
  const visibleEvents = events.slice(0, 3);
  const eventAreaHeight = visibleEvents.length ? s(18 + visibleEvents.length * 54) : 0;
  const hasDetails = serviceRows.some((row) => row.kind === "service" || row.kind === "empty" || row.kind === "summary");
  const contentOffset = compact ? 60 : source.freshness === "unavailable" ? (lastSuccessfulUpdate(source) ? 230 : 210) : source.freshness === "stale" ? 196 : width < s(520) ? 140 : 120;
  const availableContentHeight = height - s(contentOffset) - eventAreaHeight - s(hasDetails ? 20 : 8);
  const contentAreaHeight = Math.max(0, availableContentHeight);
  const lineHeight = Math.min(s(compact ? 30 : 62), Math.max(s(compact ? 18 : 20), contentAreaHeight / Math.max(1, serviceRows.length)));
  const maxLines = Math.floor(availableContentHeight / lineHeight);
  const rows = visibleRows(serviceRows, maxLines);
  const visibleServices = rows.reduce((count, row) => count + (row.kind === "service" ? 1 : row.kind === "summary" ? row.count : 0), 0);
  const hiddenServices = Math.max(0, services.length - visibleServices);
  const hiddenGroups = Math.max(0, serviceRows.filter((row) => row.kind === "group").length - rows.filter((row) => row.kind === "group").length);
  const contentY = y + s(contentOffset) + s(8);
  const sourceHealthLabel = health === "stale" ? "Stale" : healthLabel[health];
  const sourceStatusLabel = source.disabled ? "Disabled" : source.freshness !== "fresh" ? "Service status unknown" : `Services: ${sourceHealthLabel}`;
  const statusTextWidth = sourceStatusLabel.length * s(compact ? 6.5 : 9);
  const statusTextX = x + width - pad - statusTextWidth;
  const statusDotX = statusTextX - s(14);
  const titleMaxChars = compact
    ? Math.max(8, Math.floor((statusDotX - left - s(14)) / s(10)))
    : Math.max(8, Math.floor((width - pad * 2 - s(16)) / s(17)));
  return { ...props, health, compact, pad, left, services, hasParentGroups, serviceRows, events, visibleEvents,
    eventAreaHeight, hasDetails, contentY, lineHeight, visibleRows: rows, hiddenServices, hiddenGroups,
    sourceStatusLabel, statusTextX, statusDotX, titleMaxChars };
}

function renderFullCardHeader(layout: CardLayout): string {
  const { source, x, y, width, scale, pad, left, health, statusDotX, statusTextX } = layout;
  const s = (n: number) => n * scale;
  const sourceProvider = source.provider === "uptime-kuma" ? "Uptime Kuma" : "Statuspage";
  const sourceIdentity = source.hostname ?? "Public status page";
  const freshnessLabel = [freshnessDescription(source), formatFetched(source.fetchedAt)].filter(Boolean).join(" · ");
  const freshnessTextWidth = freshnessLabel.length * s(9);
  const freshnessX = x + width - pad - freshnessTextWidth - s(12);
  const identityLimit = Math.floor((freshnessX - left - s(16)) / s(8.5));
  const stacked = identityLimit < 16;
  const identityMax = stacked ? Math.floor((width - pad * 2) / s(8.5)) : identityLimit;
  const freshnessY = y + s(stacked ? 92 : 70);
  const statusY = y + s(stacked ? 116 : 96);
  const statusDotY = y + s(stacked ? 110 : 90);
  let svg = svgProviderIdentity(left, y + s(70), scale, sourceProvider, truncateText(sourceIdentity, Math.max(8, identityMax - sourceProvider.length - 3)));
  svg += svgFreshnessBadge(stacked ? left : freshnessX, freshnessY, scale, freshnessLabel, freshnessColor(source));
  svg += svgStatusDot(statusDotX, statusDotY, s(7), colors[health]);
  svg += `<text x="${statusTextX}" y="${statusY}" fill="${svgText(colors[health])}" font-size="${s(16)}" font-weight="700">${svgText(layout.sourceStatusLabel)}</text>`;
  if (source.provider === "atlassian-statuspage" && source.statusDescription) {
    const statusDescriptionWidth = Math.max(0, statusDotX - left - s(16));
    svg += `<text x="${left}" y="${statusY}" fill="#b9c9dc" font-size="${s(16)}">${svgText(truncateText(`Statuspage: ${source.statusDescription}`, Math.floor(statusDescriptionWidth / s(8.5))))}</text>`;
  }
  return svg;
}

function renderCardHeader(layout: CardLayout): string {
  const { source, x, y, width, scale, left, health, compact, titleMaxChars, statusDotX, statusTextX } = layout;
  const s = (n: number) => n * scale;
  let svg = `<text x="${left}" y="${y + s(compact ? 25 : 42)}" fill="#f5f8fc" font-size="${s(compact ? 17 : 32)}" font-weight="700">${svgText(truncateText(source.displayName, titleMaxChars))}</text>`;
  if (compact) {
    svg += svgStatusDot(statusDotX, y + s(20), s(7), colors[health]);
    svg += `<text x="${statusTextX}" y="${y + s(26)}" fill="${svgText(colors[health])}" font-size="${s(12)}" font-weight="700">${svgText(layout.sourceStatusLabel)}</text>`;
    return svg;
  }
  return svg + renderFullCardHeader(layout);
}

function renderServiceDisplayRow(row: ServiceDisplayRow, layout: CardLayout, rowY: number): string {
  const { source, x, width, scale, pad, left, compact } = layout;
  const s = (n: number) => n * scale;
  if (row.kind === "group") {
    return `<text x="${left}" y="${rowY}" fill="#c1d1e2" font-size="${s(compact ? 12 : 15)}" font-weight="700">${svgText(truncateText(row.name, Math.floor(width / s(10))))}</text>`;
  }
  if (row.kind === "empty") {
    return `<text x="${left + s(16)}" y="${rowY}" fill="#aab8ca" font-size="${s(compact ? 11 : 14)}">No services reported</text>`;
  }
  if (row.kind === "summary") {
    return svgGroupSummary({ x: left + s(16), y: rowY, scale, label: "operational", count: row.count });
  }
  const { name, status } = row.component;
  const unconfirmed = source.freshness !== "fresh" && status !== "stale";
  const color = unconfirmed ? colors.unknown : colors[status as Health] ?? colors.unknown;
  const statusText = healthLabel[status as Health] ?? healthLabel.unknown;
  const changedTime = formatClock(row.component.statusChangedAt);
  const sampledTime = formatClock(row.component.sampledAt);
  const stateChangeTime = changedTime && ["down", "degraded", "maintenance"].includes(status) ? changedTime : undefined;
  const staleReading = status === "stale";
  const lastKnown = staleReading || unconfirmed ? (row.component.history ?? []).toSorted((a, b) => Date.parse(b.at) - Date.parse(a.at)).find((beat) => beat.status !== "stale")?.status ?? (unconfirmed ? status : undefined) : undefined;
  const lastKnownLabel = lastKnown ? healthLabel[lastKnown] ?? healthLabel.unknown : undefined;
  const sampledAge = staleReading || unconfirmed ? formatAge(row.component.sampledAt, source.fetchedAt) : undefined;
  const conciseUnconfirmed = (staleReading || unconfirmed) && width < s(520);
  const statusMeta = conciseUnconfirmed ? undefined : [
    (staleReading || unconfirmed) && sampledTime ? (lastKnown ? sampledTime : `Last check ${sampledTime}`) : stateChangeTime ? `Since ${stateChangeTime}` : status !== "operational" && sampledTime ? `Checked ${sampledTime}` : undefined,
    sampledAge,
  ].filter(Boolean).join(" · ") || undefined;
  const conciseAge = sampledAge?.replace(/(\d+)h (\d+)m old/, "$1h$2m").replace(/(\d+)m old/, "$1m");
  const displayStatus = conciseUnconfirmed
    ? lastKnownLabel ? `Last: ${lastKnownLabel} · ${conciseAge ?? "stale"}` : `${staleReading ? "Stale" : "Unconfirmed"} · ${conciseAge ?? ""}`.trim()
    : lastKnownLabel ? `Last known: ${lastKnownLabel}` : staleReading ? "Stale" : unconfirmed ? "Unconfirmed" : statusText;
  return svgServiceRow({ x: left, y: rowY, right: x + width - pad, scale, name, status: displayStatus, color, statusMeta, compact, showStatus: true });
}

function renderCardRows(layout: CardLayout): string {
  return layout.visibleRows.map((row, index) => renderServiceDisplayRow(row, layout, layout.contentY + index * layout.lineHeight)).join("");
}

function renderContextMessage(layout: CardLayout): string {
  const { source, left, contentY, scale, services, hasParentGroups } = layout;
  if (source.disabled) return `<text x="${left}" y="${contentY}" fill="#aab8ca" font-size="${scale * 17}">Source is disabled and not polled</text>`;
  if (source.freshness === "unavailable") {
    const lastSuccessful = lastSuccessfulUpdate(source);
    const details = [source.error, "Service status cannot be confirmed", lastSuccessful ? `Last successful feed data ${lastSuccessful}` : undefined].filter(Boolean).join(" · ");
    return svgSourceNotice({ x: left, y: layout.y + scale * 124, width: layout.width - layout.pad * 2, scale,
      title: "Monitoring feed unavailable", detail: details, color: colors.stale, unavailable: true });
  }
  if (source.freshness === "stale") {
    return svgSourceNotice({ x: left, y: layout.y + scale * 124, width: layout.width - layout.pad * 2, scale,
      title: "Service data is stale; health unconfirmed", detail: "", color: colors.stale });
  }
  if (!services.length && !source.error && !hasParentGroups) return `<text x="${left}" y="${contentY}" fill="#aab8ca" font-size="${scale * 17}">No component data available</text>`;
  return "";
}

function renderCardOverflow(layout: CardLayout): string {
  const { hiddenServices, hiddenGroups } = layout;
  if (!hiddenServices && !hiddenGroups) return "";
  const s = (n: number) => n * layout.scale;
  const message = [hiddenGroups ? `${hiddenGroups} more groups` : "", hiddenServices ? `${hiddenServices} more services` : ""].filter(Boolean).join(" · ");
  return `<text x="${layout.left}" y="${layout.y + layout.height - layout.eventAreaHeight - s(10)}" fill="#b7c8da" font-size="${s(layout.compact ? 10 : 13)}">+ ${svgText(message)}</text>`;
}

function renderCardEvents(layout: CardLayout): string {
  if (!layout.visibleEvents.length) return "";
  const s = (n: number) => n * layout.scale;
  return svgEventPanel({ x: layout.x + s(12), y: layout.y + layout.height - layout.eventAreaHeight,
    width: layout.width - s(24), height: layout.eventAreaHeight, scale: layout.scale,
    events: layout.visibleEvents, hiddenCount: layout.events.length - layout.visibleEvents.length });
}

export function renderCard(props: CardProps): string {
  const layout = buildCardLayout(props);
  return `<g>${svgPanel(layout.x, layout.y, layout.width, layout.height, layout.scale, colors[layout.health])}` +
    renderCardHeader(layout) + renderContextMessage(layout) + renderCardRows(layout) +
    renderCardOverflow(layout) + renderCardEvents(layout) + "</g>";
}
