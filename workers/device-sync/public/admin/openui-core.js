import {
  createLibrary,
  createParser,
  createQueryManager,
  createStore,
  createStreamingParser,
  defineComponent,
  defineFunction,
  evaluate,
  evaluateElementProps,
  mergeStatements,
} from "@openuidev/lang-core";
import { z } from "zod";
import { compactIdentifier } from "./ui-utils.js";

const READ_ONLY_TOOL = "get_fleet_overview";

const Metric = defineComponent({
  name: "Metric",
  props: z.object({ label: z.string(), value: z.string(), detail: z.string() }),
  description: "Shows one read-only fleet metric, its value, and a short detail.",
  component: ({ props }) => {
    const card = document.createElement("article");
    card.className = "fleet-metric";
    card.append(
      textElement("p", props.label, "fleet-metric-label"),
      textElement("strong", props.value, "fleet-metric-value"),
      textElement("p", props.detail, "fleet-metric-detail"),
    );
    return card;
  },
});

const Notice = defineComponent({
  name: "Notice",
  props: z.object({
    tone: z.enum(["info", "warning"]),
    title: z.string(),
    body: z.string(),
  }),
  description: "Shows a read-only informational or warning notice.",
  component: ({ props }) => {
    const notice = document.createElement("section");
    notice.className = `fleet-notice fleet-notice--${props.tone}`;
    notice.append(
      textElement("h3", props.title, "fleet-notice-title"),
      textElement("p", props.body, "fleet-notice-body"),
    );
    return notice;
  },
});

const Dashboard = defineComponent({
  name: "Dashboard",
  props: z.object({ children: z.array(z.union([Metric.ref, Notice.ref])) }),
  description: "Arranges read-only fleet metrics and notices in a responsive dashboard.",
  component: ({ props, renderNode }) => {
    const grid = document.createElement("div");
    grid.className = "fleet-summary-grid";
    for (const child of props.children ?? []) grid.append(renderNode(child));
    return grid;
  },
});

const functions = [
  defineFunction({
    name: "DeviceCount",
    description: "Summarizes how many devices are enrolled.",
    params: z.object({ devices: z.array(z.any()).optional().default([]) }),
    returns: z.string(),
    fn: ({ devices }) => `${devices.length} enrolled`,
  }),
  defineFunction({
    name: "DeviceStatus",
    description: "Summarizes how many devices are enabled and disabled.",
    params: z.object({ devices: z.array(z.any()).optional().default([]) }),
    returns: z.string(),
    fn: ({ devices }) => {
      if (!devices.length) return "No devices enrolled yet";
      const enabled = devices.filter((device) => device.enabled === true || device.enabled === 1).length;
      return `${enabled} enabled · ${devices.length - enabled} disabled`;
    },
  }),
  defineFunction({
    name: "PlaylistLabel",
    description: "Names the active playlist and its version.",
    params: z.object({ active: z.any().optional() }),
    returns: z.string(),
    fn: ({ active }) => active
      ? `${active.playlist_id} / ${compactIdentifier(active.revision)}`
      : "No active playlist",
  }),
  defineFunction({
    name: "PlaylistDetail",
    description: "Explains whether an active playlist is ready for enrolled devices on their next sync.",
    params: z.object({ active: z.any().optional() }),
    returns: z.string(),
    fn: ({ active }) => active
      ? "Ready for enrolled devices on their next sync"
      : "No playlist is active for enrolled devices",
  }),
  defineFunction({
    name: "ReadyCount",
    description: "Counts playlist versions that are ready to activate.",
    params: z.object({ playlists: z.array(z.any()).optional().default([]) }),
    returns: z.string(),
    fn: ({ playlists }) => {
      const count = playlists.filter((playlist) => !playlist.active).length;
      return `${count} version${count === 1 ? "" : "s"} ready to activate`;
    },
  }),
  defineFunction({
    name: "ReadyDetail",
    description: "Explains whether any playlist versions are ready to activate.",
    params: z.object({ playlists: z.array(z.any()).optional().default([]) }),
    returns: z.string(),
    fn: ({ playlists }) => playlists.some((playlist) => !playlist.active)
      ? "Choose a version in Playlists to activate it"
      : "No versions are waiting to be activated",
  }),
  defineFunction({
    name: "ImageTone",
    description: "Chooses a warning when active playlist images are missing.",
    params: z.object({ assets: z.array(z.any()).optional().default([]) }),
    returns: z.enum(["info", "warning"]),
    fn: ({ assets }) => assets.length ? "warning" : "info",
  }),
  defineFunction({
    name: "ImageHealth",
    description: "Summarizes missing images in the active playlist.",
    params: z.object({ assets: z.array(z.any()).optional().default([]), active: z.any().optional() }),
    returns: z.string(),
    fn: ({ assets, active }) => !active
      ? "No active playlist"
      : assets.length
        ? `${assets.length} image${assets.length === 1 ? "" : "s"} missing from the active playlist`
        : "All active playlist images are available",
  }),
];

export const openUILibrary = createLibrary({
  id: "ribbonfish-fleet-readonly",
  root: "Dashboard",
  components: [Dashboard, Metric, Notice],
  functions,
});

const schema = openUILibrary.toJSONSchema();
const parser = createParser(schema, "Dashboard");

export const OPENUI_STARTER_SOURCE = [
  'overview = Query("get_fleet_overview", {}, {})',
  "root = Dashboard([deviceMetric, activeMetric, readyMetric, imageHealth])",
  'deviceMetric = Metric("Devices", @DeviceCount(overview.devices), @DeviceStatus(overview.devices))',
  'activeMetric = Metric("Active playlist", @PlaylistLabel(overview.active_playlist), @PlaylistDetail(overview.active_playlist))',
  'readyMetric = Metric("Versions to activate", @ReadyCount(overview.playlists), @ReadyDetail(overview.playlists))',
  'imageHealth = Notice(@ImageTone(overview.asset_health.missing), "Image availability", @ImageHealth(overview.asset_health.missing, overview.active_playlist))',
].join("\n");

const librarySpec = openUILibrary.toSpec();
const componentPrompt = Object.values(librarySpec.components)
  .map(({ signature, description }) => `${signature} — ${description}`)
  .join("\n");
const functionPrompt = Object.values(librarySpec.functions)
  .map(({ signature, description }) => `@${signature} — ${description}`)
  .join("\n");

export const OPENUI_SYSTEM_PROMPT = [
  "Create compact, read-only summaries for the Ribbonfish device fleet in OpenUI Lang.",
  "Return only a valid program. Put one statement on each line, use positional arguments, and define a Dashboard root.",
  `Use only the ${READ_ONLY_TOOL} read-only query. Call it once: overview = Query("${READ_ONLY_TOOL}", {}, {}). Its result contains devices, playlists, active_playlist, and asset_health.missing.`,
  "Use only the registered components and functions below. Prefix data function calls with @. Do not emit Mutation statements, actions, or controls that change fleet state. Do not expose credentials or tokens.",
  `Components:\n${componentPrompt}`,
  `Data functions:\n${functionPrompt}`,
].join("\n\n");

export function createFleetOpenUI({ getOverview }) {
  if (typeof getOverview !== "function") throw new TypeError("getOverview must be a function");

  const store = createStore();
  const streamingParser = createStreamingParser(schema, "Dashboard");
  const listeners = new Set();
  const pendingQueryWaiters = new Set();
  let parseResult = null;
  let disposed = false;

  const queryManager = createQueryManager({
    async callTool(toolName, args) {
      if (toolName !== READ_ONLY_TOOL) {
        throw new Error(`OpenUI views only support the read-only ${READ_ONLY_TOOL} query`);
      }
      if (args && Object.keys(args).length > 0) {
        throw new Error(`${READ_ONLY_TOOL} does not accept query arguments`);
      }
      return getOverview();
    },
  });

  const unsubscribeQuery = queryManager.subscribe(() => {
    const view = getView();
    for (const listener of listeners) listener(view);
  });
  queryManager.activate();

  function evaluationContext() {
    const snapshot = queryManager.getSnapshot();
    const runtimeFunctions = Object.fromEntries(
      Object.entries(schema.functions ?? {}).map(([name, definition]) => [
        name,
        { ...definition, fn: openUILibrary.functions[name].fn },
      ]),
    );
    return {
      getState: (name) => store.get(name),
      resolveRef: (name) => snapshot[name],
      functions: runtimeFunctions,
    };
  }

  function queryNodesFor(result) {
    const context = evaluationContext();
    return result.queryStatements.map((statement) => {
      const toolName = statement.toolAST ? evaluate(statement.toolAST, context, { library: openUILibrary }) : null;
      const args = statement.argsAST ? evaluate(statement.argsAST, context, { library: openUILibrary }) : {};
      if (toolName !== READ_ONLY_TOOL) {
        throw new Error(`OpenUI views only support the read-only ${READ_ONLY_TOOL} query`);
      }
      if (args && (typeof args !== "object" || Array.isArray(args) || Object.keys(args).length > 0)) {
        throw new Error(`${READ_ONLY_TOOL} does not accept query arguments`);
      }
      return {
        statementId: statement.statementId,
        toolName,
        args: args ?? {},
        defaults: statement.defaultsAST ? evaluate(statement.defaultsAST, context, { library: openUILibrary }) : null,
        deps: statement.deps?.map((name) => store.get(name)),
        refreshInterval: statement.refreshAST ? evaluate(statement.refreshAST, context, { library: openUILibrary }) : undefined,
        complete: statement.complete,
      };
    });
  }

  function renderProgram(source) {
    const result = parser.parse(String(source));
    const errors = result.meta.errors.filter((error) => error.severity !== "warning");
    if (errors.length) throw new Error(errors.map((error) => error.message).join("\n"));
    if (!result.root || result.root.typeName !== "Dashboard") {
      throw new Error("OpenUI program must define a Dashboard root");
    }
    if (result.mutationStatements.length) {
      throw new Error("Mutations are disabled in OpenUI read-only views");
    }

    store.initialize(result.stateDeclarations, store.getSnapshot());
    const queries = queryNodesFor(result);
    parseResult = result;
    queryManager.evaluateQueries(queries);
    return getView();
  }

  function getView() {
    if (!parseResult?.root) return null;
    const errors = [];
    const root = evaluateElementProps(parseResult.root, {
      ctx: evaluationContext(),
      library: openUILibrary,
      store,
      errors,
    });
    const querySnapshot = queryManager.getSnapshot();
    return {
      root,
      errors,
      loading: querySnapshot.__openui_loading.length > 0,
      querySnapshot,
      parseResult,
    };
  }

  return {
    prompt: OPENUI_SYSTEM_PROMPT,
    renderProgram,
    getView,
    inspectProgram(source) {
      const partial = streamingParser.set(String(source));
      return {
        incomplete: partial.meta.incomplete,
        statementCount: partial.meta.statementCount,
        unresolved: partial.meta.unresolved,
        errors: partial.meta.errors,
      };
    },
    mergePatch(existing, patch) {
      return mergeStatements(String(existing), String(patch), "root");
    },
    refresh() {
      queryManager.invalidate();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async waitForQueries() {
      if (disposed) throw new Error("OpenUI runtime has been disposed");
      if (!queryManager.isAnyLoading()) return;
      await new Promise((resolve, reject) => {
        let settled = false;
        let unsubscribe = () => {};
        const finish = (error) => {
          if (settled) return;
          settled = true;
          unsubscribe();
          pendingQueryWaiters.delete(cancel);
          if (error) reject(error);
          else resolve();
        };
        const cancel = () => finish(new Error("OpenUI runtime was disposed while waiting for queries"));
        const check = () => {
          if (!queryManager.isAnyLoading()) {
            finish();
          }
        };
        unsubscribe = queryManager.subscribe(check);
        pendingQueryWaiters.add(cancel);
        check();
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const cancel of [...pendingQueryWaiters]) cancel();
      unsubscribeQuery();
      queryManager.dispose();
      store.dispose();
      listeners.clear();
    },
  };
}

export function renderOpenUIElement(element) {
  if (!element || element.type !== "element") {
    return document.createTextNode(element == null ? "" : String(element));
  }
  const definition = openUILibrary.components[element.typeName];
  if (!definition || typeof definition.component !== "function") {
    throw new Error(`Unsupported OpenUI component: ${element.typeName}`);
  }
  return definition.component({
    props: element.props,
    renderNode: renderOpenUIElement,
    statementId: element.statementId,
  });
}

function textElement(tag, text, className) {
  const element = document.createElement(tag);
  element.textContent = String(text ?? "");
  if (className) element.className = className;
  return element;
}
