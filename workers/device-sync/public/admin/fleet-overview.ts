import {
  Catalog,
  type ComponentApi,
  type FunctionImplementation,
} from "@a2ui/web_core/catalog";
import { MessageProcessor, type ProcessableMessagePayload } from "@a2ui/web_core/processing";
import { getValue } from "@a2ui/web_core/reactivity";
import { NodeResolver } from "@a2ui/web_core/resolution";
import { CLOUDFLARE_FREE_BROWSER_DAILY_LIMIT_MS } from "../../src/capture-forecast.ts";
import { formatRunTime } from "./capture-presentation.ts";

const FLEET_CATALOG_ID = "https://ribbonfish.dev/a2ui/catalogs/fleet-overview-v1.json";
const FLEET_SURFACE_ID = "fleetOverview";
const MAX_FLEET_COMPONENTS = 64;
const MAX_FLEET_COMPONENT_DEPTH = 10;
const MAX_FLEET_DATA_BYTES = 16_384;

const FLEET_COMPONENT_NAMES = ["Card", "Column", "Text"] as const;
const fleetCatalog = Catalog.fromJson({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: FLEET_CATALOG_ID,
  catalogId: FLEET_CATALOG_ID,
  protocolVersion: "1.0",
  title: "Ribbonfish Fleet Overview",
  description: "Read-only components for the Ribbonfish fleet overview.",
  components: {
    Card: {
      type: "object",
      properties: {
        component: { const: "Card" },
        child: { $ref: "common_types.json#/$defs/Child" },
      },
      required: ["component", "child"],
      additionalProperties: false,
    },
    Column: {
      type: "object",
      properties: {
        component: { const: "Column" },
        children: { $ref: "common_types.json#/$defs/ChildList" },
      },
      required: ["component", "children"],
      additionalProperties: false,
    },
    Text: {
      type: "object",
      properties: {
        component: { const: "Text" },
        text: { $ref: "common_types.json#/$defs/DynamicString" },
        variant: { type: "string", enum: ["caption", "body"] },
      },
      required: ["component", "text"],
      additionalProperties: false,
    },
  },
  functions: {},
  $defs: {
    anyComponent: {
      oneOf: FLEET_COMPONENT_NAMES.map((name) => ({ $ref: `#/components/${name}` })),
    },
    anyFunction: { oneOf: [] },
  },
});
// The parsed catalog has no functions; the cast bridges its schema-only type to the renderer API.
const executableFleetCatalog = fleetCatalog as unknown as Catalog<ComponentApi, FunctionImplementation>;

const METRIC_COMPONENTS = [
  { id: "sites", href: "#sites-section" },
  { id: "devices", href: "#device-section" },
  { id: "approvals", href: "#pending-enrollments-title" },
  { id: "browserRun", href: "#capture-efficiency-section" },
] as const;

const navigationTargets = new Map(
  METRIC_COMPONENTS.map(({ id, href }) => [`${id}Card`, href]),
);

type FleetOverviewData = {
  capture_targets?: Array<{
    capture_type?: string;
    last_error?: string | null;
    last_success_at?: number | null;
    schedule_reviewed?: boolean | number;
  }>;
  devices?: Array<{
    enabled?: boolean | number;
    health?: {
      status?: string;
      applied_playlist_id?: string | null;
      applied_revision?: string | number | null;
    } | null;
  }>;
  active_playlist?: { playlist_id?: string; revision?: string | number } | null;
  capture_efficiency?: {
    daily_usage?: {
      accounted_ms?: number;
      budget_ms?: number;
      free_plan_limit_ms?: number;
    };
  } | null;
};

type EnrollmentRequest = { request_id?: string };
type FleetMetric = { label: string; value: string; detail: string; [key: string]: unknown };
type FleetComponent = { id: string; component: "Column" | "Card" | "Text"; [key: string]: unknown };

export type FleetOverviewA2uiMessage = {
  version: "1.0";
  createSurface: {
    surfaceId: string;
    catalogId: string;
    sendDataModel: false;
    components: FleetComponent[];
    dataModel: { metrics: FleetMetric[]; [key: string]: unknown };
  };
};

function validMilliseconds(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isBehindActivePlaylist(device: NonNullable<FleetOverviewData["devices"]>[number], active: FleetOverviewData["active_playlist"]) {
  const health = device.health;
  if (!active || active.revision === undefined || active.revision === null || !health?.applied_playlist_id ||
    health.applied_revision === undefined || health.applied_revision === null) return false;
  return health.applied_playlist_id !== active.playlist_id || String(health.applied_revision) !== String(active.revision);
}

function buildOverviewMetrics(overview: FleetOverviewData, enrollmentRequests: EnrollmentRequest[]): FleetMetric[] {
  const targets = (overview.capture_targets ?? []).filter((target) => target.capture_type !== "api-dashboard");
  const sitesNeedingAttention = targets.filter((target) =>
    Boolean(target.last_error) || target.schedule_reviewed === false || target.schedule_reviewed === 0 || !target.last_success_at).length;
  const devicesOfflineOrBehind = (overview.devices ?? []).filter((device) =>
    device.enabled !== false && device.enabled !== 0 &&
    (device.health?.status === "offline" || isBehindActivePlaylist(device, overview.active_playlist))).length;
  const dailyUsage = overview.capture_efficiency?.daily_usage;
  const budgetMs = validMilliseconds(dailyUsage?.budget_ms)
    ? dailyUsage.budget_ms
    : validMilliseconds(dailyUsage?.free_plan_limit_ms)
      ? dailyUsage.free_plan_limit_ms
      : CLOUDFLARE_FREE_BROWSER_DAILY_LIMIT_MS;
  const browserRunUsage = validMilliseconds(dailyUsage?.accounted_ms)
    ? `${formatRunTime(dailyUsage.accounted_ms)} / ${formatRunTime(budgetMs)}`
    : "Unavailable";

  return [
    { label: "Sites needing attention", value: String(sitesNeedingAttention), detail: "Review screenshot sites" },
    { label: "Devices offline or behind", value: String(devicesOfflineOrBehind), detail: "Check device health and playlist sync" },
    { label: "Pending approvals", value: String(enrollmentRequests.length), detail: "Verify device fingerprints" },
    { label: "Browser Run used today", value: browserRunUsage, detail: "Used / configured daily budget" },
  ];
}

function dataBinding(path: string) {
  return { "@path": path };
}

function createComponents(): FleetComponent[] {
  const components: FleetComponent[] = [{
    id: "root",
    component: "Column",
    children: METRIC_COMPONENTS.map(({ id }) => `${id}Card`),
  }];

  for (const [index, { id }] of METRIC_COMPONENTS.entries()) {
    components.push(
      { id: `${id}Card`, component: "Card", child: `${id}Content` },
      { id: `${id}Content`, component: "Column", children: [`${id}Label`, `${id}Value`, `${id}Detail`] },
      { id: `${id}Label`, component: "Text", variant: "caption", text: dataBinding(`/metrics/${index}/label`) },
      { id: `${id}Value`, component: "Text", variant: "body", text: dataBinding(`/metrics/${index}/value`) },
      { id: `${id}Detail`, component: "Text", variant: "caption", text: dataBinding(`/metrics/${index}/detail`) },
    );
  }

  return components;
}

export function createFleetOverviewA2uiMessage(
  overview: FleetOverviewData = {},
  enrollmentRequests: EnrollmentRequest[] = [],
): FleetOverviewA2uiMessage {
  return {
    version: "1.0",
    createSurface: {
      surfaceId: FLEET_SURFACE_ID,
      catalogId: FLEET_CATALOG_ID,
      sendDataModel: false,
      components: createComponents(),
      dataModel: { metrics: buildOverviewMetrics(overview, enrollmentRequests) },
    },
  };
}

export function renderFleetOverviewA2ui(
  container: HTMLElement,
  overview: FleetOverviewData = {},
  enrollmentRequests: EnrollmentRequest[] = [],
) {
  renderA2uiMessages(container, [createFleetOverviewA2uiMessage(overview, enrollmentRequests)]);
}

/** Process and render the read-only fleet surface using Google's A2UI v1.0 core. */
export function renderA2uiMessages(container: HTMLElement, messages: readonly unknown[]) {
  assertFleetMessageBounds(messages);

  const processor = new MessageProcessor([executableFleetCatalog], undefined, { version: "1.0" });
  try {
    processor.processMessages(messages as ProcessableMessagePayload);
    const surface = processor.getSurface(FLEET_SURFACE_ID);
    if (!surface || processor.getSurfaces().size !== 1) {
      throw new Error("A2UI fleet overview must contain exactly one fleetOverview surface");
    }

    const resolver = new NodeResolver(surface);
    try {
      const root = getValue(resolver.rootNode);
      if (!root) throw new Error("A2UI fleet overview is missing its root component");
      const fragment = container.ownerDocument.createDocumentFragment();
      fragment.append(renderComponent(root.toJSON(), container.ownerDocument));
      container.replaceChildren(fragment);
    } finally {
      resolver.dispose();
    }
  } finally {
    processor.dispose();
  }
}

function assertFleetMessageBounds(messages: readonly unknown[]) {
  if (messages.length !== 1) throw new Error("A2UI fleet overview accepts one v1.0 createSurface message");
  const message = messages[0];
  if (!isRecord(message) || message.version !== "1.0" || !isRecord(message.createSurface) ||
    Object.keys(message).length !== 2 || Object.keys(message.createSurface).some((key) =>
      !["surfaceId", "catalogId", "sendDataModel", "components", "dataModel"].includes(key))) {
    throw new Error("A2UI fleet overview accepts only a v1.0 createSurface message");
  }
  const surface = message.createSurface;
  if (surface.surfaceId !== FLEET_SURFACE_ID || surface.catalogId !== FLEET_CATALOG_ID ||
    surface.sendDataModel !== false || !Array.isArray(surface.components) ||
    surface.components.length > MAX_FLEET_COMPONENTS || !isRecord(surface.dataModel)) {
    throw new Error("A2UI fleet overview surface is outside the supported contract");
  }
  if (!surface.components.every((component: unknown) =>
    isRecord(component) && typeof component.id === "string" && typeof component.component === "string")) {
    throw new Error("A2UI fleet overview contains an invalid component");
  }
  const dataModelBytes = new TextEncoder().encode(JSON.stringify(surface.dataModel)).byteLength;
  if (dataModelBytes > MAX_FLEET_DATA_BYTES) {
    throw new Error("A2UI fleet overview data exceeds the supported size");
  }
}

function renderComponent(value: unknown, document: Document, depth = 1): HTMLElement {
  if (depth > MAX_FLEET_COMPONENT_DEPTH) {
    throw new Error("A2UI fleet overview exceeds the supported component depth");
  }
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.type !== "string") {
    throw new Error("A2UI fleet overview contains an invalid component");
  }

  switch (value.type) {
    case "Column": {
      const column = document.createElement("div");
      column.className = value.id === "root" ? "fleet-summary-grid" : "overview-metric__content";
      if (!Array.isArray(value.children)) throw new Error("A2UI Column requires child components");
      for (const child of value.children) column.append(renderComponent(child, document, depth + 1));
      return column;
    }
    case "Card": {
      const href = navigationTargets.get(value.id);
      const card = document.createElement(href ? "a" : "article");
      card.className = "overview-metric";
      if (href) card.setAttribute("href", href);
      if (!isRecord(value.child)) throw new Error("A2UI Card requires one child component");
      card.append(renderComponent(value.child, document, depth + 1));
      return card;
    }
    case "Text": {
      const className = value.id.endsWith("Label")
        ? "overview-metric__label"
        : value.id.endsWith("Value")
          ? "overview-metric__value"
          : "overview-metric__detail";
      const text = typeof value.text === "string" ? value.text : "";
      const element = document.createElement(className === "overview-metric__value" ? "strong" : "span");
      element.className = className;
      element.textContent = text;
      return element;
    }
    default:
      throw new Error(`Unsupported A2UI fleet component: ${value.type}`);
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
