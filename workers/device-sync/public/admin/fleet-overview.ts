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
import { getPlaylistSyncState } from "../../src/playlist-sync-state.ts";

const FLEET_CATALOG_ID = "https://ribbonfish.dev/a2ui/catalogs/management-v2.json";
const FLEET_SURFACE_ID = "fleetOverview";
const CAPTURE_WORKBENCH_SURFACE_ID = "captureWorkbench";
const MAX_FLEET_COMPONENTS = 64;
const MAX_FLEET_COMPONENT_DEPTH = 10;
const MAX_FLEET_DATA_BYTES = 16_384;

const MANAGEMENT_COMPONENT_NAMES = ["Card", "Column", "Text", "Button"] as const;
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
    Button: {
      type: "object",
      properties: {
        component: { const: "Button" },
        child: { $ref: "common_types.json#/$defs/Child" },
        action: { $ref: "common_types.json#/$defs/Action" },
      },
      required: ["component", "child", "action"],
      additionalProperties: false,
    },
  },
  functions: {},
  $defs: {
    anyComponent: {
      oneOf: MANAGEMENT_COMPONENT_NAMES.map((name) => ({ $ref: `#/components/${name}` })),
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
  { id: "health", href: "#device-section" },
  { id: "playlistSync", href: "#device-section" },
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
      sync_status?: string;
      applied_playlist_id?: string | null;
      applied_revision?: string | number | null;
    } | null;
  }>;
  active_playlist?: { playlist_id?: string; revision?: string | number; effective_revision?: string | number } | null;
  capture_efficiency?: {
    daily_usage?: {
      accounted_ms?: number;
      budget_ms?: number;
      free_plan_limit_ms?: number;
    };
  } | null;
};

type EnrollmentRequest = { request_id?: string };
type FleetMetric = { label: string; value: string; detail: string; rows?: Array<{ text: string }>; [key: string]: unknown };
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
  return getPlaylistSyncState({
    enabled: device.enabled,
    applied_playlist_id: device.health?.applied_playlist_id,
    applied_revision: device.health?.applied_revision,
  }, active) === "behind";
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
  const devices = overview.devices ?? [];
  const enabledDevices = devices.filter((device) => device.enabled !== false && device.enabled !== 0);
  const healthGroups = [
    ["Healthy", "healthy"], ["Degraded", "degraded"], ["Stale", "stale"], ["Offline", "offline"],
    ["Starting", "starting"], ["Stopping", "stopping"], ["Unknown", "unknown"],
  ] as const;
  const healthStatus = (device: NonNullable<FleetOverviewData["devices"]>[number]) => {
    const status = device.health?.status ?? "unknown";
    return status === "online" ? "healthy" : healthGroups.some(([, known]) => known === status) ? status : "unknown";
  };
  const healthRows = healthGroups.map(([label, status]) => ({
    text: `${label} ${enabledDevices.filter((device) => healthStatus(device) === status).length}`,
  }));
  healthRows.push({ text: `Disabled ${devices.length - enabledDevices.length}` });
  const hasActiveRevision = overview.active_playlist?.revision !== undefined && overview.active_playlist?.revision !== null;
  const syncRows = [
    { text: `In sync ${hasActiveRevision ? enabledDevices.filter((device) => isOnActivePlaylist(device, overview.active_playlist)).length : 0}` },
    { text: `Behind ${hasActiveRevision ? enabledDevices.filter((device) => isReported(device) && !isOnActivePlaylist(device, overview.active_playlist)).length : 0}` },
    { text: `Not reported ${hasActiveRevision ? enabledDevices.filter((device) => !isReported(device)).length : 0}` },
    { text: `No active revision ${hasActiveRevision ? 0 : enabledDevices.length}` },
    { text: `Disabled ${devices.length - enabledDevices.length}` },
  ];

  return [
    { label: "Sites needing attention", value: String(sitesNeedingAttention), detail: "Review screenshot sites" },
    { label: "Devices offline or behind", value: String(devicesOfflineOrBehind), detail: "Check device health and playlist sync" },
    { label: "Pending approvals", value: String(enrollmentRequests.length), detail: "Verify device fingerprints" },
    { label: "Browser Run used today", value: browserRunUsage, detail: "Used / configured daily budget" },
    { label: "Device health", value: `${enabledDevices.length} enabled devices`, detail: "Health by reported state", rows: healthRows },
    { label: "Playlist sync", value: overview.active_playlist?.revision === undefined ? "No active revision" : "Revision delivery status", detail: "Devices receive active revision on next sync", rows: syncRows },
  ];
}

function isReported(device: NonNullable<FleetOverviewData["devices"]>[number]) {
  return Boolean(device.health?.applied_playlist_id && device.health?.applied_revision !== null && device.health?.applied_revision !== undefined);
}

function isOnActivePlaylist(device: NonNullable<FleetOverviewData["devices"]>[number], active: FleetOverviewData["active_playlist"]) {
  return isReported(device) && getPlaylistSyncState({
    enabled: device.enabled,
    applied_playlist_id: device.health?.applied_playlist_id,
    applied_revision: device.health?.applied_revision,
  }, active) === "in_sync";
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
      { id: `${id}Content`, component: "Column", children: [
        `${id}Label`, `${id}Value`, `${id}Detail`,
        ...(id === "health" ? healthStatusIds : id === "playlistSync" ? playlistSyncIds : []).map((rowId) => `${id}${rowId}`),
      ] },
      { id: `${id}Label`, component: "Text", variant: "caption", text: dataBinding(`/metrics/${index}/label`) },
      { id: `${id}Value`, component: "Text", variant: "body", text: dataBinding(`/metrics/${index}/value`) },
      { id: `${id}Detail`, component: "Text", variant: "caption", text: dataBinding(`/metrics/${index}/detail`) },
    );
    const rowIds = id === "health" ? healthStatusIds : id === "playlistSync" ? playlistSyncIds : [];
    rowIds.forEach((rowId, rowIndex) => components.push({
      id: `${id}${rowId}`,
      component: "Text",
      variant: "caption",
      text: dataBinding(`/metrics/${index}/rows/${rowIndex}/text`),
    }));
  }

  return components;
}

const healthStatusIds = ["Healthy", "Degraded", "Stale", "Offline", "Starting", "Stopping", "Unknown", "Disabled"] as const;
const playlistSyncIds = ["InSync", "Behind", "NotReported", "NoActiveRevision", "Disabled"] as const;

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

export type A2uiUserAction = { name: string; context: Record<string, unknown>; sourceComponentId: string };

/** Process and render a fixed Ribbonfish A2UI surface using Google's A2UI v1.0 core. */
export function renderA2uiMessages(
  container: HTMLElement,
  messages: readonly unknown[],
  options: { surfaceId?: string; onAction?: (action: A2uiUserAction) => void | Promise<void> } = {},
) {
  const surfaceId = options.surfaceId ?? FLEET_SURFACE_ID;
  const allowActions = surfaceId === CAPTURE_WORKBENCH_SURFACE_ID;
  assertManagementMessageBounds(messages, surfaceId, allowActions);
  const firstMessage = messages[0] as { createSurface: { components: Array<Record<string, unknown>> } };
  const actionById = new Map(firstMessage.createSurface.components
    .filter((component) => component.component === "Button")
    .map((component) => [String(component.id), component]));

  const processor = new MessageProcessor([executableFleetCatalog], undefined, { version: "1.0" });
  try {
    processor.processMessages(messages as ProcessableMessagePayload);
    const surface = processor.getSurface(surfaceId);
    if (!surface || processor.getSurfaces().size !== 1) {
      throw new Error(`A2UI management UI must contain exactly one ${surfaceId} surface`);
    }

    const resolver = new NodeResolver(surface);
    try {
      const root = getValue(resolver.rootNode);
      if (!root) throw new Error("A2UI fleet overview is missing its root component");
      const fragment = container.ownerDocument.createDocumentFragment();
      fragment.append(renderComponent(root.toJSON(), container.ownerDocument, {
        allowActions,
        actionById,
        onAction: options.onAction,
        surfaceId,
      }));
      container.replaceChildren(fragment);
    } finally {
      resolver.dispose();
    }
  } finally {
    processor.dispose();
  }
}

function assertManagementMessageBounds(messages: readonly unknown[], surfaceId: string, allowActions: boolean) {
  if (surfaceId !== FLEET_SURFACE_ID && surfaceId !== CAPTURE_WORKBENCH_SURFACE_ID) {
    throw new Error("A2UI management UI requested an unsupported surface");
  }
  const surfaceLabel = surfaceId === FLEET_SURFACE_ID ? "fleet overview" : "capture workbench";
  if (messages.length !== 1) throw new Error(`A2UI ${surfaceLabel} accepts one v1.0 createSurface message`);
  const message = messages[0];
  if (!isRecord(message) || message.version !== "1.0" || !isRecord(message.createSurface) ||
    Object.keys(message).length !== 2 || Object.keys(message.createSurface).some((key) =>
      !["surfaceId", "catalogId", "sendDataModel", "components", "dataModel"].includes(key))) {
    throw new Error(`A2UI ${surfaceLabel} accepts only a v1.0 createSurface message`);
  }
  const surface = message.createSurface;
  if (surface.surfaceId !== surfaceId || surface.catalogId !== FLEET_CATALOG_ID ||
    surface.sendDataModel !== false || !Array.isArray(surface.components) ||
    surface.components.length > MAX_FLEET_COMPONENTS || !isRecord(surface.dataModel)) {
    throw new Error(`A2UI ${surfaceLabel} surface is outside the supported contract`);
  }
  if (!surface.components.every((component: unknown) =>
    isRecord(component) && typeof component.id === "string" && typeof component.component === "string")) {
    throw new Error(`A2UI ${surfaceLabel} contains an invalid component`);
  }
  const allowed: readonly string[] = allowActions ? MANAGEMENT_COMPONENT_NAMES : ["Card", "Column", "Text"];
  if (!surface.components.every((component: Record<string, unknown>) => allowed.includes(String(component.component)))) {
    throw new Error(`A2UI ${surfaceLabel} contains an unsupported component`);
  }
  const dataModelBytes = new TextEncoder().encode(JSON.stringify(surface.dataModel)).byteLength;
  if (dataModelBytes > MAX_FLEET_DATA_BYTES) {
    throw new Error(`A2UI ${surfaceLabel} data exceeds the supported size`);
  }
  if (allowActions) {
    assertCaptureWorkbenchActions(surface.components, surface.dataModel);
  }
}

function assertCaptureWorkbenchActions(components: Record<string, unknown>[], dataModel: Record<string, any>) {
  if (typeof dataModel.capture_id !== "string" || !/^[0-9a-f-]{36}$/i.test(dataModel.capture_id)) {
    throw new Error("A2UI capture workbench must be rendered from the supplied target");
  }
  for (const component of components.filter((item) => item.component === "Button")) {
    const action = component.action;
    if (!isRecord(action) || !isRecord(action.event) || Object.keys(action).length !== 1 ||
      Object.keys(action.event).some((key) => !["name", "context"].includes(key))) {
      throw new Error("A2UI capture workbench contains an unsupported action");
    }
    const event = action.event;
    if (event.name === "assess_capture") {
      if (component.id !== "assessButton" || !isRecord(event.context) ||
        Object.keys(event.context).length !== 1 || event.context.capture_id !== dataModel.capture_id) {
        throw new Error("A2UI capture workbench action does not match its target");
      }
    } else if (event.name === "confirm_skip_once") {
      if (component.id !== "confirmSkipButton" || !isRecord(event.context) ||
        Object.keys(event.context).length !== 2 || event.context.capture_id !== dataModel.capture_id ||
        !Number.isSafeInteger(event.context.due_at) || dataModel.skip_eligible !== true ||
        event.context.due_at !== dataModel.skip_due_at) {
        throw new Error("A2UI capture workbench action does not match its target");
      }
    } else {
      throw new Error("A2UI capture workbench contains an unsupported action");
    }
  }
}

function renderComponent(
  value: unknown,
  document: Document,
  options: { depth?: number; allowActions: boolean; actionById: Map<string, Record<string, unknown>>; onAction?: (action: A2uiUserAction) => void | Promise<void>; surfaceId: string },
): HTMLElement {
  const depth = options.depth ?? 1;
  if (depth > MAX_FLEET_COMPONENT_DEPTH) {
    throw new Error(options.surfaceId === FLEET_SURFACE_ID
      ? "A2UI fleet overview exceeds the supported component depth"
      : "A2UI capture workbench exceeds the supported component depth");
  }
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.type !== "string") {
    throw new Error("A2UI management UI contains an invalid component");
  }

  switch (value.type) {
    case "Column": {
      const column = document.createElement("div");
      column.className = value.id === "root"
        ? options.surfaceId === FLEET_SURFACE_ID ? "fleet-summary-grid" : "capture-workbench-a2ui"
        : options.surfaceId === FLEET_SURFACE_ID ? "overview-metric__content" : "capture-workbench-a2ui__content";
      if (!Array.isArray(value.children)) throw new Error("A2UI Column requires child components");
      for (const child of value.children) column.append(renderComponent(child, document, { ...options, depth: depth + 1 }));
      return column;
    }
    case "Card": {
      const href = navigationTargets.get(value.id);
      const card = document.createElement(href ? "a" : "article");
      card.className = href ? "overview-metric" : options.surfaceId === FLEET_SURFACE_ID ? "overview-metric" : "capture-workbench-a2ui__card";
      if (href) card.setAttribute("href", href);
      if (!isRecord(value.child)) throw new Error("A2UI Card requires one child component");
      card.append(renderComponent(value.child, document, { ...options, depth: depth + 1 }));
      return card;
    }
    case "Text": {
      if (options.surfaceId !== FLEET_SURFACE_ID) {
        const text = typeof value.text === "string" ? value.text : "";
        const element = document.createElement(value.variant === "body" ? "p" : "span");
        element.className = `capture-workbench-a2ui__text capture-workbench-a2ui__text--${value.variant === "body" ? "body" : "caption"}`;
        element.textContent = text;
        return element;
      }
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
    case "Button": {
      const component = options.actionById.get(value.id);
      const action = component?.action;
      if (!options.allowActions || !component || !isRecord(action) || !isRecord(action.event) || !isRecord(value.child)) {
        throw new Error("Unsupported A2UI management action");
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = "button button--secondary capture-workbench-a2ui__button";
      button.dataset.a2uiEvent = String(action.event.name);
      button.append(renderComponent(value.child, document, { ...options, depth: depth + 1 }));
      button.addEventListener("click", () => {
        const event = action.event;
        const context = isRecord(event.context) ? event.context : {};
        void options.onAction?.({ name: event.name, context, sourceComponentId: value.id });
      });
      return button;
    }
    default:
      throw new Error(`Unsupported A2UI management component: ${value.type}`);
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
