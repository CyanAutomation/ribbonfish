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
  | { kind: "summary"; count: number; history: Array<Health | null> }
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

function recentGroupChecks(components: DashboardSource["components"], fetchedAt: string): Array<Health | null> {
  const reference = Date.parse(fetchedAt);
  if (!Number.isFinite(reference)) return [];
  const buckets: Array<Health | null> = Array.from({ length: 12 }, () => null);
  const rank = (health: Health) => ({ down: 0, degraded: 1, stale: 2, pending: 3, unknown: 4, maintenance: 5, operational: 6 })[health];
  for (const component of components) for (const beat of component.history ?? []) {
    const age = reference - Date.parse(beat.at);
    if (!Number.isFinite(age) || age < 0 || age >= 24 * 60 * 60_000) continue;
    const index = 11 - Math.floor(age / (2 * 60 * 60_000));
    const existing = buckets[index];
    if (!existing || rank(beat.status) < rank(existing)) buckets[index] = beat.status;
  }
  return buckets;
}

function recentServiceChecks(component: DashboardSource["components"][number], fetchedAt: string): Array<Health | null> | undefined {
  if (!component.history?.length) return undefined;
  return recentGroupChecks([component], fetchedAt);
}

function addGroupRows(
  rows: ServiceDisplayRow[],
  source: DashboardSource,
  name: string,
  components: DashboardSource["components"],
  groupHeader: boolean,
  showIndividualHistory: boolean,
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
    if (operationalOverflow) rows.push({ kind: "summary", count: operationalOverflow, history: [] });
  } else if (issues.length) {
    issues.sort((a, b) => healthOrder(a.status) - healthOrder(b.status) || (a.componentOrder ?? 0) - (b.componentOrder ?? 0));
    for (const component of issues) rows.push({ kind: "service", component });
    if (operationalCount || components.some((component) => component.history?.length)) {
      rows.push({ kind: "summary", count: operationalCount, history: recentGroupChecks(components, source.fetchedAt) });
    }
  } else if (source.provider === "uptime-kuma" && components.length <= 16 && components.some((component) => component.history?.length)) {
    if (!showIndividualHistory) rows.push({ kind: "summary", count: operationalCount, history: recentGroupChecks(components, source.fetchedAt) });
    for (const component of components) rows.push({ kind: "service", component });
  } else if (source.provider === "uptime-kuma" && components.length <= 16) {
    for (const component of components) rows.push({ kind: "service", component });
  } else if (source.provider === "uptime-kuma") {
    const visible = components.slice(0, 16);
    for (const component of visible) rows.push({ kind: "service", component });
    rows.push({ kind: "summary", count: components.length - visible.length, history: recentGroupChecks(components, source.fetchedAt) });
  } else {
    rows.push({ kind: "summary", count: operationalCount, history: recentGroupChecks(components, source.fetchedAt) });
  }
}

function buildServiceRows(source: DashboardSource, showIndividualHistory: boolean): ServiceDisplayRow[] {
  const parentGroups = (source.groups ?? source.components.filter((component) => component.isGroup)
    .map((component) => ({ id: component.id, name: component.name, order: component.groupOrder ?? component.componentOrder ?? 0 })))
    .sort((a, b) => a.order - b.order);
  const services = source.components.filter((component) => !component.isGroup);
  const rows: ServiceDisplayRow[] = [];
  const seenServices = new Set<string>();
  const groupedParents = parentGroups.map((parent) => {
    const children = services.filter((component) => component.groupId === parent.id || (!component.groupId && component.groupName === parent.name))
      .sort((a, b) => healthOrder(a.status) - healthOrder(b.status) || (a.componentOrder ?? 0) - (b.componentOrder ?? 0));
    const priority = children.length ? Math.min(...children.map((component) => healthOrder(component.status))) : healthOrder("operational");
    return { parent, children, priority };
  }).sort((a, b) => a.priority - b.priority || a.parent.order - b.parent.order);
  for (const { parent, children } of groupedParents) {
    addGroupRows(rows, source, parent.name, children, true, showIndividualHistory);
    for (const component of children) seenServices.add(component.id);
  }
  const remaining = services.filter((component) => !seenServices.has(component.id))
    .sort((a, b) => (a.groupOrder ?? 0) - (b.groupOrder ?? 0) || healthOrder(a.status) - healthOrder(b.status) || (a.componentOrder ?? 0) - (b.componentOrder ?? 0));
  const groups = new Map<string, typeof remaining>();
  for (const component of remaining) {
    const name = component.groupName ?? "Services";
    groups.set(name, [...(groups.get(name) ?? []), component]);
  }
  const orderedGroups = [...groups.entries()].sort(([, a], [, b]) => {
    const priority = (components: typeof remaining) => Math.min(...components.map((component) => healthOrder(component.status)));
    return priority(a) - priority(b) || (a[0]?.groupOrder ?? 0) - (b[0]?.groupOrder ?? 0);
  });
  for (const [groupName, components] of orderedGroups) {
    addGroupRows(rows, source, groupName, components, components.length > 0 && (parentGroups.length > 0 || orderedGroups.length > 1 || groupName !== "Services"), showIndividualHistory);
  }
  return rows;
}

function buildCardEvents(source: DashboardSource): SvgDashboardEvent[] {
  return [
    ...source.incidents.map((item) => ({ kind: "Incident" as const, name: item.name, status: item.status, impact: item.impact,
      color: item.impact === "critical" || item.impact === "major" ? colors.down : colors.degraded, updatedAt: item.updatedAt })),
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
  const showIndividualHistory = source.provider === "uptime-kuma" && source.freshness === "fresh" && width >= scale * 720;
  const serviceRows = buildServiceRows(source, showIndividualHistory);
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
  if (row.kind === "group") {
    const { left, width, scale, compact } = layout;
    const s = (n: number) => n * scale;
    return `<text x="${left}" y="${rowY}" fill="#c1d1e2" font-size="${s(compact ? 12 : 15)}" font-weight="700">${svgText(truncateText(row.name, Math.floor(width / s(10))))}</text>`;
  }
  if (row.kind === "empty") {
    const { left, scale, compact } = layout;
    const s = (n: number) => n * scale;
    return `<text x="${left + s(16)}" y="${rowY}" fill="#aab8ca" font-size="${s(compact ? 11 : 14)}">No services reported</text>`;
  }
  if (row.kind === "summary") {
    const { x, width, scale, pad, left } = layout;
    const s = (n: number) => n * scale;
    return svgGroupSummary({ x: left + s(16), y: rowY, right: x + width - pad, scale, label: "operational", count: row.count, history: row.history });
  }

  return renderServiceComponentRow(row.component, layout, rowY);
}

function renderServiceComponentRow(component: DashboardSource["components"][number], layout: CardLayout, rowY: number): string {
  const { source, x, width, scale, pad, left, compact } = layout;
  const { name } = component;
  const { displayStatus, color, statusMeta } = serviceStatusPresentation(component, source, layout);
  const history = source.provider === "uptime-kuma" && source.freshness === "fresh" && layout.width >= layout.scale * 720
    ? recentServiceChecks(component, source.fetchedAt)
    : undefined;
  return svgServiceRow({ x: left, y: rowY, right: x + width - pad, scale, name, status: displayStatus, color, statusMeta, compact, showStatus: true, history });
}

function serviceStatusPresentation(
  component: DashboardSource["components"][number],
  source: DashboardSource,
  layout: CardLayout,
) {
  const context = serviceStatusContext(component, source);
  const conciseUnconfirmed = (context.staleReading || context.unconfirmed) && layout.width < layout.scale * 520;
  const statusText = healthLabel[component.status as Health] ?? healthLabel.unknown;
  const conciseAge = compactServiceAge(context.sampledAge);
  const color = context.unconfirmed ? colors.unknown : colors[component.status as Health] ?? colors.unknown;
  return {
    displayStatus: serviceDisplayStatus({
      conciseUnconfirmed,
      lastKnownLabel: context.lastKnownLabel,
      conciseAge,
      staleReading: context.staleReading,
      unconfirmed: context.unconfirmed,
      statusText,
    }),
    color,
    statusMeta: serviceStatusMeta(component, context, conciseUnconfirmed),
  };
}

type ServiceStatusContext = {
  staleReading: boolean;
  unconfirmed: boolean;
  lastKnownLabel: string | undefined;
  sampledAge: string | undefined;
};

function serviceStatusContext(
  component: DashboardSource["components"][number],
  source: DashboardSource,
): ServiceStatusContext {
  const { status } = component;
  const unconfirmed = source.freshness !== "fresh" && status !== "stale";
  const staleReading = status === "stale";
  const lastKnown = lastKnownServiceStatus(component, staleReading || unconfirmed, unconfirmed);
  const lastKnownLabel = lastKnown ? healthLabel[lastKnown] ?? healthLabel.unknown : undefined;
  const sampledAge = staleReading || unconfirmed ? formatAge(component.sampledAt, source.fetchedAt) : undefined;
  return { staleReading, unconfirmed, lastKnownLabel, sampledAge };
}

function serviceStatusMeta(
  component: DashboardSource["components"][number],
  context: ServiceStatusContext,
  conciseUnconfirmed: boolean,
): string | undefined {
  if (conciseUnconfirmed) return undefined;
  const changedTime = formatClock(component.statusChangedAt);
  const sampledTime = formatClock(component.sampledAt);
  const stateChangeTime = changedTime && ["down", "degraded", "maintenance"].includes(component.status)
    ? changedTime
    : undefined;
  const label = serviceTimelineLabel(component.status, context, sampledTime, stateChangeTime);
  return [label, context.sampledAge].filter(Boolean).join(" · ") || undefined;
}

function serviceTimelineLabel(
  status: string,
  context: ServiceStatusContext,
  sampledTime: string | undefined,
  stateChangeTime: string | undefined,
): string | undefined {
  if ((context.staleReading || context.unconfirmed) && sampledTime) {
    return context.lastKnownLabel ? sampledTime : `Last check ${sampledTime}`;
  }
  if (stateChangeTime) return `Since ${stateChangeTime}`;
  if (status !== "operational" && sampledTime) return `Checked ${sampledTime}`;
  return undefined;
}

function compactServiceAge(sampledAge: string | undefined): string | undefined {
  return sampledAge?.replace(/(\d+)h (\d+)m old/, "$1h$2m").replace(/(\d+)m old/, "$1m");
}

function lastKnownServiceStatus(
  component: DashboardSource["components"][number],
  shouldFindStatus: boolean,
  unconfirmed: boolean,
): Health | undefined {
  if (!shouldFindStatus) return undefined;
  const fromHistory = (component.history ?? []).toSorted((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .find((beat) => beat.status !== "stale")?.status;
  return fromHistory ?? (unconfirmed ? component.status as Health : undefined);
}

function serviceDisplayStatus({ conciseUnconfirmed, lastKnownLabel, conciseAge, staleReading, unconfirmed, statusText }: {
  conciseUnconfirmed: boolean;
  lastKnownLabel: string | undefined;
  conciseAge: string | undefined;
  staleReading: boolean;
  unconfirmed: boolean;
  statusText: string;
}) {
  if (conciseUnconfirmed) {
    if (lastKnownLabel) return `Last: ${lastKnownLabel} · ${conciseAge ?? "stale"}`;
    const label = staleReading ? "Stale" : "Unconfirmed";
    return `${label} · ${conciseAge ?? ""}`.trim();
  }
  if (lastKnownLabel) return `Last known: ${lastKnownLabel}`;
  if (staleReading) return "Stale";
  if (unconfirmed) return "Unconfirmed";
  return statusText;
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
