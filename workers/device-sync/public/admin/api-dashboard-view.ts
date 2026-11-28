import { api } from "./api.ts";
import { requiredElement } from "./dom.ts";
import {
  actionDisclosure,
  beginButtonBusy,
  button,
  createDefinitionList,
  createDisclosure,
  createFormField,
  createSettingsGroup,
  metricCard,
  node,
  statusBadge,
} from "./ui-primitives.ts";
import { createApiDashboardSourceEditor } from "./api-dashboard-editor.ts";
import { parseApiDashboardConfig } from "../../src/api-dashboard/config.ts";
import { createActionGroup, createToolbar } from "./ui-components.ts";
import { confirmBeforeAction } from "./ui-confirmation.ts";
import { formatDetailedAge, formatTimestamp } from "./admin-formatters.ts";

type Dashboard = Record<string, any>;
type ConfirmOptions = { title: string; description: string; confirmLabel: string; destructive?: boolean };
type ApiDashboardViewCallbacks = {
  showMessage: (message: string, isError?: boolean, context?: string) => void;
  showConfirmDialog: (options: ConfirmOptions) => Promise<boolean>;
};

export function renderApiDashboards(dashboards: Dashboard[], callbacks: ApiDashboardViewCallbacks): void {
  const container = requiredElement(document, "#api-dashboard-list");
  container.replaceChildren();
  if (!dashboards.length) {
    container.append(node("p", "No API dashboards yet. Add a dashboard and configure its public status sources here.", "muted"));
    return;
  }
  for (const dashboard of dashboards) container.append(renderApiDashboard(dashboard, callbacks));
}

function buildDashboardSourceEditor(container: HTMLElement, sources: any[]) {
  const host = node("div", undefined, "source-editor-list");
  const heading = node("div");
  heading.append(node("h4", "Status sources"), node("p", "Add the public status pages shown in this dashboard.", "field-hint"));
  const add = button("Add source", "secondary");
  add.dataset.addDashboardSource = "true";
  const toolbar = createToolbar({
    label: "Dashboard source controls",
    className: "source-editor-toolbar",
    groups: [
      { label: "Status sources", items: [heading] },
      { label: "Source actions", items: [add], alignEnd: true },
    ],
    ownerDocument: document,
  });
  const rows = node("div", undefined, "source-editor-rows");
  rows.dataset.sourceRows = "true";
  const error = node("p", undefined, "field-error");
  error.dataset.sourceEditorError = "true";
  error.hidden = true;
  error.setAttribute("role", "alert");
  host.append(toolbar, rows, error);
  container.append(host);
  const advanced = node("details", undefined, "advanced-json-editor");
  advanced.dataset.apiDashboardAdvanced = "true";
  advanced.append(node("summary", "Advanced source JSON"));
  const textarea = node("textarea", undefined, "field-control") as HTMLTextAreaElement;
  textarea.name = "sources-json";
  textarea.rows = 8;
  textarea.spellcheck = false;
  const jsonField = createFormField("Sources JSON", textarea, {
    description: "Use this editor only for source options unavailable in the standard fields.",
    ownerDocument: document,
  });
  advanced.append(jsonField.element);
  container.append(advanced);
  return createApiDashboardSourceEditor(host, sources, textarea);
}

function formatBytes(bytes: unknown): string {
  if (!Number.isFinite(Number(bytes)) || Number(bytes) < 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let amount = Number(bytes);
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${amount.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatMetricMs(value: unknown): string {
  return value != null && value !== "" && Number.isFinite(Number(value)) ? `${Math.round(Number(value))} ms` : "—";
}

function percentage(numerator: number, denominator: number): string {
  return denominator > 0 ? `${Math.round(numerator / denominator * 100)}%` : "—";
}

function sourceFreshnessCount(sources: Dashboard["sources"], freshness: string): number {
  return (sources ?? []).filter((source: Dashboard) => !source.disabled && source.freshness === freshness).length;
}

function renderApiDashboardMetrics(dashboard: Dashboard): HTMLElement {
  const metrics = dashboard.recent_metrics ?? {};
  const details = node("details", undefined, "api-dashboard-efficiency");
  details.append(node("summary", `Efficiency · ${metrics.sample_count ?? 0} recent jobs (up to 30 days)`));
  const grid = node("div", undefined, "api-dashboard-efficiency__grid");
  grid.append(
    renderCaptureOutcomeMetric(metrics),
    renderSourceOutcomeMetric(dashboard.sources, metrics),
    renderUpstreamTrafficMetric(metrics),
    renderApiFetchMetric(metrics),
  );
  appendRenderMetrics(grid, metrics);
  grid.append(renderCaptureWallTimeMetric(metrics), renderAssetReuseMetric(metrics));
  details.append(grid);
  details.append(node("p", "These are application measurements from the latest 100 jobs within 30 days. Worker CPU and memory, D1 operation counts, and billed R2 operations or storage require Cloudflare Analytics; wall-clock duration is not a cost estimate. API dashboards use zero Browser Run minutes.", "field-hint"));
  return details;
}

function renderCaptureOutcomeMetric(metrics: Dashboard): HTMLElement {
  const successes = Number(metrics.successes ?? 0);
  const failures = Number(metrics.failures ?? 0);
  const completed = Number(metrics.completed_count ?? successes + failures);
  const value = completed ? `${successes} / ${completed}` : "No completed jobs";
  const description = `${failures} failed · ${metrics.retry_attempts ?? 0} retries · ${percentage(failures, completed)} failure rate`;
  return metricCard("Successful captures", value, description);
}

function renderSourceOutcomeMetric(sources: Dashboard["sources"], metrics: Dashboard): HTMLElement {
  const outcomes = `${metrics.partial_source_failures ?? 0} partial · ${metrics.all_source_failures ?? 0} all failed`;
  const freshness = `${sourceFreshnessCount(sources, "fresh")} fresh · ${sourceFreshnessCount(sources, "stale")} stale · ${sourceFreshnessCount(sources, "unavailable")} unavailable now`;
  return metricCard("Source outcomes", outcomes, freshness);
}

function renderUpstreamTrafficMetric(metrics: Dashboard): HTMLElement {
  const requests = `${metrics.upstream_requests ?? 0} requests`;
  const description = `${metrics.not_modified_responses ?? 0} HTTP 304 · ${metrics.upstream_failed_requests ?? 0} failed · ${formatBytes(metrics.response_bytes ?? 0)} response body bytes`;
  return metricCard("Upstream traffic", requests, description);
}

function renderApiFetchMetric(metrics: Dashboard): HTMLElement {
  const value = `${formatMetricMs(metrics.fetch_p50_ms)} p50`;
  const description = `${formatMetricMs(metrics.fetch_p90_ms)} p90 · ${metrics.completed_count ?? 0} completed-job samples`;
  return metricCard("API fetch duration", value, description);
}

function renderCaptureWallTimeMetric(metrics: Dashboard): HTMLElement {
  const value = `${formatMetricMs(metrics.total_p50_ms)} p50`;
  const description = `${formatMetricMs(metrics.total_p90_ms)} p90 · includes API work and asset storage, excludes final D1 update`;
  return metricCard("Capture work wall time", value, description);
}

function renderAssetReuseMetric(metrics: Dashboard): HTMLElement {
  const successes = Number(metrics.successes ?? 0);
  const value = `${percentage(metrics.content_hash_matches ?? 0, successes)} render skips`;
  const description = `${metrics.content_hash_matches ?? 0} content matches · ${percentage(metrics.asset_reuses ?? 0, successes)} R2 asset reuse`;
  return metricCard("Render and asset reuse", value, description);
}

function appendRenderMetrics(grid: HTMLElement, metrics: Dashboard): void {
  const failures = Number(metrics.render_failures ?? 0);
  const failureLabel = failures === 1 ? "failure" : "failures";
  grid.append(metricCard("PNG render duration", `${formatMetricMs(metrics.render_p50_ms)} p50`, `${formatMetricMs(metrics.render_p90_ms)} p90 · ${metrics.render_operations ?? 0} renders · ${failures} render ${failureLabel}`));
}

function renderApiDashboard(dashboard: Dashboard, callbacks: ApiDashboardViewCallbacks): HTMLElement {
  const card = node("article", undefined, "capture-target");
  const image = renderDashboardImage(dashboard);
  const content = node("div", undefined, "capture-target__content");
  content.append(renderDashboardHeading(dashboard));
  content.append(node("p", `${dashboard.capture_interval_seconds / 60} minute refresh · ${dashboard.viewport_width} × ${dashboard.viewport_height} px · ${dashboard.configuration?.sources?.length ?? 0} sources`, "muted"));
  appendLatestCaptureSummary(content, dashboard);
  content.append(renderDashboardSourceHealth(dashboard));
  content.append(renderApiDashboardMetrics(dashboard));
  content.append(renderDashboardActions(dashboard, callbacks));
  content.append(renderDashboardEditor(dashboard, callbacks));
  appendSourceSummary(content, dashboard);
  card.append(image, content);
  return card;
}

function renderDashboardImage(dashboard: Dashboard): HTMLImageElement {
  const image = node("img", undefined, "capture-target__preview") as HTMLImageElement;
  image.src = dashboard.current_image ?? "/admin/capture-pending.png";
  image.alt = dashboard.current_image ? `Latest API dashboard image for ${dashboard.name}` : `Waiting for the first API dashboard image for ${dashboard.name}`;
  image.loading = "lazy";
  image.addEventListener("error", () => { image.hidden = true; }, { once: true });
  return image;
}

function renderDashboardHeading(dashboard: Dashboard): HTMLElement {
  const heading = node("div", undefined, "capture-target__heading");
  heading.append(node("h3", dashboard.name));
  const retryScheduled = Number(dashboard.retry_after_at) > Date.now();
  const status = !dashboard.enabled ? "Disabled" : dashboard.stale ? "Stale" : retryScheduled ? "Retry scheduled" : dashboard.job_status || "Enabled";
  heading.append(statusBadge(status, dashboard.stale || dashboard.last_error || retryScheduled ? "warning" : "success"));
  return heading;
}

function appendLatestCaptureSummary(content: HTMLElement, dashboard: Dashboard): void {
  if (dashboard.last_success_at) {
    const ageSeconds = Math.max(0, (Date.now() - Number(dashboard.last_success_at)) / 1000);
    content.append(node("p", `Last successful capture ${formatTimestamp(dashboard.last_success_at)} · ${formatDetailedAge(ageSeconds)} ago`, "muted"));
  }
  if (Number(dashboard.recovery_attempts) > 0) {
    const retryScheduled = Number(dashboard.retry_after_at) > Date.now();
    const retryDetail = retryScheduled ? ` · next retry ${formatTimestamp(dashboard.retry_after_at)}` : "";
    content.append(node("p", `Queue recovery attempts ${dashboard.recovery_attempts}${retryDetail}`, "muted"));
  }
  const details = latestCaptureDetails(dashboard);
  if (details.length) {
    content.append(createDisclosure("Latest capture details", [createDefinitionList(details, {
      className: "capture-target__latest-list",
      ownerDocument: document,
    })], {
      className: "capture-target__latest-details",
      contentClassName: "capture-target__latest-details-content",
      ownerDocument: document,
    }));
  }
  if (dashboard.last_error) content.append(node("p", dashboard.last_error, "capture-target__error error-title"));
}

function latestCaptureDetails(dashboard: Dashboard): Array<{ label: string; value: string }> {
  const details: Array<{ label: string; value: string }> = [];
  if (dashboard.api_last_fetch_at) details.push({ label: "Last successful source fetch", value: formatTimestamp(dashboard.api_last_fetch_at) });
  if (dashboard.api_last_image_at) details.push({ label: "Image last changed", value: formatTimestamp(dashboard.api_last_image_at) });
  if (dashboard.current_size != null) details.push({
    label: "Latest PNG",
    value: `${formatBytes(dashboard.current_size)} · ${dashboard.viewport_width} × ${dashboard.viewport_height} px`,
  });
  if (dashboard.api_fetch_ms !== null && dashboard.api_fetch_ms !== undefined) details.push({
    label: "Last run",
    value: `API fetch ${dashboard.api_fetch_ms} ms · rendering ${dashboard.api_render_ms ?? 0} ms · capture work ${dashboard.api_total_ms ?? 0} ms · asset ${dashboard.api_asset_reused ? "reused" : "created"}`,
  });
  return details;
}

function renderDashboardSourceHealth(dashboard: Dashboard): HTMLElement {
  const sources = dashboard.sources ?? [];
  const configuredSources = new Map<string, Dashboard>((dashboard.configuration?.sources ?? []).map((source: Dashboard): [string, Dashboard] => [source.id, source]));
  const details = node("details", undefined, "api-dashboard-source-health");
  details.append(node("summary", `Source health and cache (${sources.length})`));
  const list = node("div", undefined, "api-dashboard-source-health__list");
  for (const source of sources) list.append(renderDashboardSource(source, configuredSources));
  details.append(list);
  return details;
}

function renderDashboardSource(source: Dashboard, configuredSources: Map<string, Dashboard>): HTMLElement {
  const configured = configuredSources.get(source.id);
  const disabled = source.disabled === true || configured?.enabled === false;
  const state = disabled ? "Disabled" : source.freshness === "fresh" ? "Fresh" : source.freshness === "stale" ? "Stale" : "Unavailable";
  const row = node("article", undefined, `api-dashboard-source-health__item${disabled ? " is-disabled" : source.freshness !== "fresh" ? " is-warning" : ""}`);
  row.append(node("strong", `${source.displayName}: ${state}`));
  if (!disabled && source.error) row.append(node("p", source.error, "capture-target__error"));
  appendSourceRequestStats(row, source.requestStats);
  appendSourceCacheDetails(row, source.cache);
  return row;
}

function appendSourceRequestStats(row: HTMLElement, stats: Dashboard | null | undefined): void {
  if (!stats) return;
  row.append(node("p", `Last poll: ${stats.requestCount} requests · ${stats.notModifiedCount} unchanged · ${stats.failedRequestCount} failed · ${formatBytes(stats.responseBytes)} · ${stats.durationMs} ms`, "muted"));
}

function appendSourceCacheDetails(row: HTMLElement, cache: Dashboard | null | undefined): void {
  for (const [endpoint, metadata] of Object.entries(cache ?? {})) {
    if (!metadata) continue;
    const value = metadata as Dashboard;
    const validators = [value.etag ? "ETag" : "", value.lastModified ? "Last-Modified" : ""].filter(Boolean).join(" + ") || "no validator";
    const cacheControl = value.cacheControl ? ` · Cache-Control ${value.cacheControl}` : "";
    const checked = value.revalidatedAt ? ` · last revalidated ${formatTimestamp(value.revalidatedAt)}` : "";
    row.append(node("p", `${endpoint}: ${validators}${cacheControl} · content fetched ${formatTimestamp(value.contentFetchedAt)}${checked}`, "muted"));
  }
}

function renderDashboardActions(dashboard: Dashboard, callbacks: ApiDashboardViewCallbacks): HTMLElement {
  const run = button("Refresh now", "secondary");
  run.addEventListener("click", () => runDashboardNow(run, dashboard, callbacks));
  const toggle = button(dashboard.enabled ? "Disable" : "Enable", "secondary");
  toggle.addEventListener("click", () => toggleDashboard(dashboard, callbacks));
  const remove = button("Remove dashboard", "danger");
  remove.addEventListener("click", () => removeDashboard(dashboard, callbacks));
  return createActionGroup([
    run,
    toggle,
    actionDisclosure(`More actions for ${dashboard.name}`, [remove]),
  ], {
    label: `Actions for dashboard ${dashboard.name}`,
    className: "form-actions dashboard-actions",
    ownerDocument: document,
  });
}

async function runDashboardNow(run: HTMLButtonElement, dashboard: Dashboard, callbacks: ApiDashboardViewCallbacks): Promise<void> {
  run.disabled = true;
  try {
    await api(`/admin/api/captures/${encodeURIComponent(dashboard.capture_id)}/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    callbacks.showMessage("API dashboard refresh queued. Click Refresh data to view its latest status.", false, "dashboards");
  } catch (error) {
    callbacks.showMessage((error as Error).message, true, "dashboards");
  } finally {
    run.disabled = false;
  }
}

async function toggleDashboard(dashboard: Dashboard, callbacks: ApiDashboardViewCallbacks): Promise<void> {
  try {
    await api(`/admin/api/api-dashboards/${encodeURIComponent(dashboard.capture_id)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !dashboard.enabled }),
    });
    callbacks.showMessage(`API dashboard ${dashboard.enabled ? "disabled" : "enabled"}. Click Refresh data to update the list.`, false, "dashboards");
  } catch (error) {
    callbacks.showMessage((error as Error).message, true, "dashboards");
  }
}

async function removeDashboard(dashboard: Dashboard, callbacks: ApiDashboardViewCallbacks): Promise<void> {
  try {
    const confirmed = await confirmBeforeAction(
      (text) => callbacks.showConfirmDialog({ title: "Remove API dashboard?", description: text, confirmLabel: "Remove dashboard", destructive: true }),
      `Remove ${dashboard.name}? Future API captures will stop and existing playlist revisions keep their assigned image.`,
      () => api(`/admin/api/captures/${encodeURIComponent(dashboard.capture_id)}`, { method: "DELETE" }),
    );
    if (confirmed) callbacks.showMessage("API dashboard removed. Click Refresh data to update the list.", false, "dashboards");
  } catch (error) {
    callbacks.showMessage((error as Error).message, true, "dashboards");
  }
}

function renderDashboardEditor(dashboard: Dashboard, callbacks: ApiDashboardViewCallbacks): HTMLElement {
  const editor = node("details", undefined, "capture-target__details");
  editor.append(node("summary", "Edit dashboard settings"));
  const form = node("form", undefined, "capture-detail-section api-dashboard-edit") as HTMLFormElement;
  form.dataset.apiDashboardEdit = dashboard.capture_id;
  const config = dashboard.configuration ?? { sources: [], width: dashboard.viewport_width, height: dashboard.viewport_height };
  const nameField = dashboardNameField(dashboard.name);
  const intervalField = dashboardIntervalField(dashboard.capture_interval_seconds);
  const resolution = dashboardResolutionFields(config, dashboard);
  const dashboardDetails = createSettingsGroup("Dashboard details", {
    headingLevel: "h4",
    description: "Set the display name, refresh schedule, and generated image size.",
    className: "api-dashboard-edit__details",
    ownerDocument: document,
  });
  dashboardDetails.content.append(nameField.field.element, intervalField.field.element, resolution.element);
  form.append(dashboardDetails.element);
  const sourceEditor = buildDashboardSourceEditor(form, config.sources ?? []);
  const feedback = node("p", undefined, "form-feedback");
  feedback.dataset.editFeedback = "true";
  feedback.hidden = true;
  feedback.setAttribute("role", "status");
  const saveActions = node("div", undefined, "form-actions");
  const save = button("Save dashboard settings", "secondary");
  save.type = "submit";
  save.dataset.saveApiDashboard = "true";
  saveActions.append(save);
  form.append(saveActions, feedback);
  form.addEventListener("input", () => { form.dataset.dirty = "true"; });
  form.addEventListener("change", () => { form.dataset.dirty = "true"; });
  form.addEventListener("submit", (event) => saveDashboardSettings(event, {
    dashboard, callbacks, form, feedback, save, sourceEditor, nameInput: nameField.input,
    intervalInput: intervalField.input, widthInput: resolution.width, heightInput: resolution.height,
  }));
  editor.append(form);
  return editor;
}

function dashboardNameField(name: string) {
  const input = node("input", undefined, "field-control") as HTMLInputElement;
  input.name = "name";
  input.value = name;
  input.maxLength = 120;
  input.required = true;
  return { input, field: createFormField("Dashboard name", input, { ownerDocument: document }) };
}

function dashboardIntervalField(value: number) {
  const input = node("select", undefined, "field-control") as HTMLSelectElement;
  input.name = "capture_interval_seconds";
  for (const [interval, label] of [[300, "5 minutes"], [60, "1 minute"]] as const) {
    const option = node("option", label) as HTMLOptionElement;
    option.value = String(interval);
    option.selected = Number(value) === interval;
    input.append(option);
  }
  return { input, field: createFormField("Refresh interval", input, { ownerDocument: document }) };
}

function dashboardResolutionFields(config: Dashboard, dashboard: Dashboard) {
  const resolution = node("fieldset", undefined, "screenshot-size-fieldset");
  resolution.append(node("legend", "Output resolution"));
  const width = dimensionInput("width", 640, 3840, config.width ?? dashboard.viewport_width);
  const height = dimensionInput("height", 360, 2160, config.height ?? dashboard.viewport_height);
  resolution.append(
    createFormField("Width (pixels)", width, { ownerDocument: document }).element,
    createFormField("Height (pixels)", height, { ownerDocument: document }).element,
  );
  return { element: resolution, width, height };
}

function dimensionInput(name: string, min: number, max: number, value: number): HTMLInputElement {
  const input = node("input", undefined, "field-control") as HTMLInputElement;
  input.name = name;
  input.type = "number";
  input.min = String(min);
  input.max = String(max);
  input.step = "1";
  input.value = String(value);
  return input;
}

async function saveDashboardSettings(
  event: Event,
  {
    dashboard, callbacks, form, feedback, save, sourceEditor, nameInput, intervalInput, widthInput, heightInput,
  }: {
    dashboard: Dashboard; callbacks: ApiDashboardViewCallbacks; form: HTMLFormElement; feedback: HTMLElement; save: HTMLButtonElement;
    sourceEditor: ReturnType<typeof createApiDashboardSourceEditor>; nameInput: HTMLInputElement; intervalInput: HTMLSelectElement;
    widthInput: HTMLInputElement; heightInput: HTMLInputElement;
  },
) {
  event.preventDefault();
  feedback.hidden = true;
  const finishBusy = beginButtonBusy(save, "Saving dashboard…", feedback);
  try {
    if (!sourceEditor.validate()) throw new Error("Fix the highlighted source fields before saving.");
    const parsed = parseApiDashboardConfig({ sources: sourceEditor.getSources(), width: Number(widthInput.value), height: Number(heightInput.value) });
    await api(`/admin/api/api-dashboards/${encodeURIComponent(dashboard.capture_id)}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: nameInput.value, ...parsed, capture_interval_seconds: Number(intervalInput.value) }),
    });
    form.dataset.dirty = "false";
    callbacks.showMessage("API dashboard configuration saved. Click Refresh data to view the updated settings.", false, "dashboards");
  } catch (caught) {
    feedback.textContent = caught instanceof Error ? caught.message : String(caught);
    feedback.hidden = false;
  } finally {
    finishBusy();
  }
}

function appendSourceSummary(content: HTMLElement, dashboard: Dashboard): void {
  for (const source of dashboard.sources ?? []) {
    content.append(node("p", `${source.displayName}: ${source.components?.length ?? 0} components · ${source.freshness}`, "muted"));
  }
}
