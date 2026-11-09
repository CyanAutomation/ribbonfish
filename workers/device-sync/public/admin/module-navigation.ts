import { createPageHeader, createSidebarController, createToolbar } from "./ui-components.ts";

function enhanceModulePageHeaders(sections: HTMLElement[]): void {
  sections.forEach((section) => {
    const sectionHeading = [...section.children].find((child) => child.classList.contains("section-heading"));
    const heading = sectionHeading?.querySelector<HTMLHeadingElement>("h2");
    if (!sectionHeading || !heading) return;

    const eyebrow = sectionHeading.querySelector<HTMLElement>(".eyebrow");
    const next = sectionHeading.nextElementSibling;
    const description = next?.tagName === "P" && next.classList.contains("muted") ? next as HTMLParagraphElement : undefined;
    const actions = [...sectionHeading.children].filter((child) => child.classList.contains("button")) as HTMLElement[];
    const title = heading.textContent?.trim() ?? "Management";
    const header = createPageHeader({
      eyebrow: eyebrow?.textContent?.trim(),
      title,
      titleId: heading.id,
      titleLevel: "h2",
      description: description?.textContent?.trim(),
      actions,
      actionsLabel: `${title} actions`,
      ownerDocument: section.ownerDocument,
    });

    sectionHeading.replaceWith(header);
    description?.remove();
  });
}

function enhanceManagementToolbars(): void {
  const captureFilters = document.querySelector<HTMLElement>(".capture-filters");
  const searchLabel = captureFilters?.querySelector("#capture-search")?.closest("label") as HTMLElement | null;
  const statusLabel = captureFilters?.querySelector("#capture-filter")?.closest("label") as HTMLElement | null;
  if (captureFilters && searchLabel && statusLabel) {
    captureFilters.replaceWith(createToolbar({
      label: "Capture site filters",
      className: "capture-filters",
      groups: [
        { label: "Site search", items: [searchLabel] },
        { label: "Site status", items: [statusLabel] },
      ],
      ownerDocument: captureFilters.ownerDocument,
    }));
  }

  const sourceToolbar = document.querySelector<HTMLElement>("#api-dashboard-source-list > .source-editor-toolbar");
  const sourceSummary = sourceToolbar?.firstElementChild as HTMLElement | null;
  const addSource = sourceToolbar?.querySelector<HTMLElement>("[data-add-dashboard-source]");
  if (sourceToolbar && sourceSummary && addSource) {
    const toolbar = createToolbar({
      label: "Dashboard source controls",
      className: "source-editor-toolbar",
      groups: [
        { label: "Status sources", items: [sourceSummary] },
        { label: "Source actions", items: [addSource], alignEnd: true },
      ],
      ownerDocument: sourceToolbar.ownerDocument,
    });
    if (sourceToolbar.hasAttribute("data-source-editor-toolbar")) toolbar.setAttribute("data-source-editor-toolbar", "");
    sourceToolbar.replaceWith(toolbar);
  }
}

/** Keep module URLs shareable and reveal the parent view for deep links. */
export function initModuleNavigation(): void {
  const ids = ["overview-section", "sites-section", "dashboards-section", "capture-efficiency-section", "playlist-section", "device-section", "activity-section"];
  const sections = ids.map((id) => document.getElementById(id) as HTMLElement);
  const tiles = document.getElementById("dashboard-tiles") as HTMLElement;
  const navigation = document.getElementById("module-navigation") as HTMLElement;
  const shell = document.getElementById("management-shell") as HTMLElement;
  const navigationToggle = document.getElementById("module-navigation-toggle") as HTMLButtonElement;
  enhanceModulePageHeaders(sections);
  enhanceManagementToolbars();
  createSidebarController({ shell, sidebar: navigation, toggleButton: navigationToggle });

  function render(): void {
    const id = decodeURIComponent(location.hash.slice(1));
    const target = id ? document.getElementById(id) : null;
    const section = sections.find((item) => item === target || (target && item.contains(target)));
    const isHome = !section;
    sections.forEach((item) => { item.hidden = item !== section; });
    tiles.hidden = !isHome;
    navigation.querySelectorAll<HTMLAnchorElement>("a").forEach((link) => {
      const active = link.hash === (target?.id === "fleet-insights" ? "#fleet-insights" : section ? `#${section.id}` : "#dashboard");
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
    if (target && section) {
      let parent: HTMLElement | null = target;
      while (parent && parent !== section) {
        if (parent instanceof HTMLDetailsElement) parent.open = true;
        parent = parent.parentElement;
      }
    }
  }

  window.addEventListener("hashchange", () => {
    render();
    const id = decodeURIComponent(location.hash.slice(1));
    const target = document.getElementById(id);
    const section = sections.find((item) => item.id === id || (target && item.contains(target)));
    const heading = id === "fleet-insights" ? target?.querySelector<HTMLElement>("h3") : section?.querySelector<HTMLElement>("h2");
    const focusTarget = target instanceof HTMLDetailsElement ? target.querySelector<HTMLElement>("summary") : heading;
    if (focusTarget) {
      focusTarget.tabIndex = -1;
      focusTarget.focus({ preventScroll: true });
    }
  });
  render();
}
