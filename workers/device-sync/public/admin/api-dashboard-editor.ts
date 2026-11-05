import { parseApiDashboardConfig, sourceConfigErrors, type SourceConfig, type SourceFieldName } from "../../src/api-dashboard/config.ts";

let generatedID = 0;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (className) item.className = className;
  return item;
}

function newSource(existing: SourceConfig[]): SourceConfig {
  let id: string;
  do { id = `source-${Date.now().toString(36)}-${(++generatedID).toString(36)}`; }
  while (existing.some((source) => source.id === id));
  return { id, provider: "uptime-kuma", display_name: "", enabled: true, hostname: "" };
}

function setFieldError(row: HTMLElement, field: SourceFieldName, message?: string): void {
  const control = row.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-source-field="${field}"]`);
  const error = row.querySelector<HTMLElement>(`[data-source-error="${field}"]`);
  if (!control || !error) return;
  error.textContent = message ?? "";
  error.hidden = !message;
  if (message) {
    control.setAttribute("aria-invalid", "true");
    control.setAttribute("aria-describedby", error.id);
  } else {
    control.removeAttribute("aria-invalid");
    control.removeAttribute("aria-describedby");
  }
}

export interface ApiDashboardSourceEditor {
  getSources(): SourceConfig[];
  setSources(sources: SourceConfig[]): void;
  validate(): boolean;
  syncAdvanced(): void;
}

/** Structured source controls and an optional JSON editor share one validated source model. */
export function createApiDashboardSourceEditor(container: HTMLElement, initialSources: SourceConfig[], advancedJSON?: HTMLTextAreaElement): ApiDashboardSourceEditor {
  const rowsContainer = container.querySelector<HTMLElement>("[data-source-rows]") ?? container;
  const error = container.querySelector<HTMLElement>("[data-source-editor-error]");
  let sources = initialSources.length ? initialSources.map((source) => ({ ...source })) : [newSource([])];

  function readSources(): SourceConfig[] {
    return [...rowsContainer.querySelectorAll<HTMLElement>("[data-dashboard-source]")].map((row) => {
      const value = (field: string) => row.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-source-field="${field}"]`)!;
      const source: SourceConfig = {
        ...sources.find((existing) => existing.id === value("id").value),
        id: value("id").value,
        provider: value("provider").value as SourceConfig["provider"],
        display_name: value("display_name").value,
        enabled: (value("enabled") as HTMLInputElement).checked,
        hostname: value("hostname").value,
      };
      const slug = value("slug").value;
      if (slug || sources.some((existing) => existing.id === source.id && Object.hasOwn(existing, "slug"))) source.slug = slug;
      return source;
    });
  }

  function updateProvider(row: HTMLElement): void {
    const provider = row.querySelector<HTMLSelectElement>('[data-source-field="provider"]')!;
    const slugField = row.querySelector<HTMLElement>("[data-slug-field]")!;
    const relevant = provider.value === "uptime-kuma";
    slugField.hidden = !relevant;
    const slug = row.querySelector<HTMLInputElement>('[data-source-field="slug"]')!;
      slug.hidden = !relevant;
    slug.required = relevant;
    row.classList.toggle("source-editor-row--disabled", !row.querySelector<HTMLInputElement>('[data-source-field="enabled"]')!.checked);
  }

  function render(): void {
    rowsContainer.querySelectorAll("[data-dashboard-source]").forEach((row) => row.remove());
    const rows = sources.map((source, index) => {
      const row = element("fieldset", undefined, "source-editor-row");
      row.dataset.dashboardSource = "true";
      row.dataset.sourceIndex = String(index);
      const legend = element("legend", `Source ${index + 1}`);
      row.append(legend);
      const id = element("input");
      id.type = "hidden";
      id.value = source.id;
      id.dataset.sourceField = "id";
      id.name = "id";
      row.append(id);

      const providerLabel = element("label", "Provider");
      const provider = element("select", undefined, "field-control");
      provider.dataset.sourceField = "provider";
      provider.name = "provider";
      provider.setAttribute("aria-label", `Provider for source ${index + 1}`);
      for (const [value, label] of [["uptime-kuma", "Uptime Kuma"], ["atlassian-statuspage", "Atlassian Statuspage"]]) {
        const option = element("option", label) as HTMLOptionElement;
        option.value = value;
        option.selected = source.provider === value;
        provider.append(option);
      }
      providerLabel.append(provider);
      row.append(providerLabel);

      for (const [field, label, value, maxLength] of [
        ["display_name", "Display name", source.display_name, 100],
        ["hostname", "Hostname", source.hostname, 253],
      ] as const) {
        const labelElement = element("label", label);
        const input = element("input", undefined, "field-control");
        input.type = "text";
        input.value = value;
        input.maxLength = maxLength;
        input.required = true;
        input.autocomplete = "off";
        input.dataset.sourceField = field;
        input.name = field;
        input.setAttribute("aria-label", `${label} for source ${index + 1}`);
        labelElement.append(input);
        row.append(labelElement);
      }

      const slugLabel = element("label", "Status-page slug");
      slugLabel.dataset.slugField = "true";
      const slug = element("input", undefined, "field-control");
      slug.type = "text";
      slug.value = source.slug ?? "";
      slug.maxLength = 64;
      slug.autocomplete = "off";
      slug.dataset.sourceField = "slug";
      slug.name = "slug";
      slug.setAttribute("aria-label", `Status-page slug for source ${index + 1}`);
      slugLabel.append(slug);
      row.append(slugLabel);

      const enabledLabel = element("label", undefined, "source-editor-enabled");
      const enabled = element("input");
      enabled.type = "checkbox";
      enabled.checked = source.enabled;
      enabled.dataset.sourceField = "enabled";
      enabled.name = "enabled";
      enabled.setAttribute("aria-label", `Enable source ${index + 1}`);
      enabledLabel.append(enabled, element("span", "Enabled"));
      row.append(enabledLabel);

      for (const field of ["id", "provider", "display_name", "hostname", "slug"] as SourceFieldName[]) {
        const fieldError = element("span", undefined, "field-error");
        fieldError.id = `source-${index}-${field}-error`;
        fieldError.dataset.sourceError = field;
        fieldError.hidden = true;
        fieldError.setAttribute("role", "alert");
        if (field === "id") fieldError.hidden = true;
        else row.querySelector(`[data-source-field="${field}"]`)?.insertAdjacentElement("afterend", fieldError);
      }

      const actions = element("div", undefined, "source-editor-row__actions");
      for (const [key, label, disabled] of [
        ["up", "Move up", index === 0], ["down", "Move down", index === sources.length - 1], ["remove", "Remove source", false],
      ] as const) {
        const action = element("button", label, "button button--quiet");
        action.type = "button";
        action.disabled = disabled;
        action.dataset[`moveSource${key === "up" ? "Up" : key === "down" ? "Down" : "Remove"}`] = "true";
        if (key === "remove") action.dataset.removeDashboardSource = "true";
        actions.append(action);
      }
      row.append(actions);
      updateProvider(row);
      return row;
    });
    rowsContainer.append(...rows);
    if (error) {
      error.textContent = sources.length > 30 ? "A dashboard can contain up to 30 sources." : "";
      error.hidden = sources.length <= 30;
    }
    syncAdvanced();
  }

  function syncAdvanced(): void {
    if (advancedJSON) advancedJSON.value = JSON.stringify(readSources(), null, 2);
  }

  function validate(): boolean {
    const rows = [...rowsContainer.querySelectorAll<HTMLElement>("[data-dashboard-source]")];
    let valid = rows.length >= 1 && rows.length <= 30;
    const seen = new Set<string>();
    const currentSources = readSources();
    rows.forEach((row, index) => {
      const source = currentSources[index];
      const fieldErrors = sourceConfigErrors(source);
      if (seen.has(source.id)) fieldErrors.id = "Source IDs must be unique.";
      seen.add(source.id);
      for (const field of ["id", "provider", "display_name", "enabled", "hostname", "slug"] as SourceFieldName[]) {
        setFieldError(row, field, fieldErrors[field]);
        if (fieldErrors[field]) valid = false;
      }
    });
    if (rows.length < 1) valid = false;
    if (rows.length > 30) valid = false;
    if (error) {
      error.textContent = rows.length < 1 ? "Add at least one source." : rows.length > 30 ? "A dashboard can contain up to 30 sources." : "";
      error.hidden = rows.length >= 1 && rows.length <= 30;
    }
    try { parseApiDashboardConfig({ sources: readSources(), width: 1920, height: 1080 }); }
    catch { valid = false; }
    return valid;
  }

  function setSources(nextSources: SourceConfig[]): void {
    sources = nextSources.map((source) => ({ ...source }));
    render();
  }

  container.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const row = target.closest<HTMLElement>("[data-dashboard-source]");
    if (target.closest("[data-add-dashboard-source]")) {
      if (sources.length < 30) setSources([...readSources(), newSource(readSources())]);
      return;
    }
    if (!row) return;
    const index = Number(row.dataset.sourceIndex);
    const current = readSources();
    if (target.closest("[data-remove-dashboard-source]")) current.splice(index, 1);
    else if (target.closest("[data-move-source-up]")) [current[index - 1], current[index]] = [current[index], current[index - 1]];
    else if (target.closest("[data-move-source-down]")) [current[index + 1], current[index]] = [current[index], current[index + 1]];
    else return;
    setSources(current);
    container.dispatchEvent(new Event("input", { bubbles: true }));
  });
  container.addEventListener("input", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
    const row = target.closest<HTMLElement>("[data-dashboard-source]");
    if (!row) return;
    if (target.dataset.sourceField === "enabled") updateProvider(row);
    validate();
    syncAdvanced();
  });
  container.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) return;
    const row = target.closest<HTMLElement>("[data-dashboard-source]");
    if (row && target.dataset.sourceField === "provider") {
      updateProvider(row);
      validate();
      syncAdvanced();
    }
  });

  if (advancedJSON) {
    advancedJSON.value = JSON.stringify(sources, null, 2);
    advancedJSON.addEventListener("change", () => {
      try {
        const parsed: unknown = JSON.parse(advancedJSON.value);
        if (!Array.isArray(parsed)) throw new Error("Sources must be a JSON array.");
        parseApiDashboardConfig({ sources: parsed, width: 1920, height: 1080 });
        setSources(parsed as SourceConfig[]);
        if (error) { error.textContent = ""; error.hidden = true; }
      } catch (caught) {
        if (error) {
          error.textContent = caught instanceof Error ? caught.message : "Source JSON is invalid.";
          error.hidden = false;
        }
      }
    });
  }
  render();
  return { getSources: readSources, setSources, validate, syncAdvanced };
}
