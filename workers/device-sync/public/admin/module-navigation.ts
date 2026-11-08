import { createSidebarController } from "./ui-components.ts";

/** Keep module URLs shareable and reveal the parent view for deep links. */
export function initModuleNavigation(): void {
  const ids = ["overview-section", "sites-section", "dashboards-section", "capture-efficiency-section", "playlist-section", "device-section", "activity-section"];
  const sections = ids.map((id) => document.getElementById(id) as HTMLElement);
  const tiles = document.getElementById("dashboard-tiles") as HTMLElement;
  const navigation = document.getElementById("module-navigation") as HTMLElement;
  const shell = document.getElementById("management-shell") as HTMLElement;
  const navigationToggle = document.getElementById("module-navigation-toggle") as HTMLButtonElement;
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
    if (heading) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  });
  render();
}
