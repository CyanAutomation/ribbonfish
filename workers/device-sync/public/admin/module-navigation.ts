/** Keep module URLs shareable and reveal the parent view for existing deep links. */
export function initModuleNavigation(): void {
  const ids = ["overview-section", "sites-section", "playlist-section", "device-section", "activity-section"];
  const sections = ids.map((id) => document.getElementById(id) as HTMLElement);
  const tiles = document.getElementById("dashboard-tiles") as HTMLElement;
  const home = document.getElementById("dashboard-home") as HTMLElement;
  const analysis = document.getElementById("analysis-dialog") as HTMLDialogElement;
  const analysisLink = tiles.querySelector<HTMLAnchorElement>('a[href="#analysis-section"]')!;
  const closeAnalysis = document.getElementById("close-analysis") as HTMLButtonElement;
  const supportsModal = typeof analysis.showModal === "function";
  const analysisDetails = document.getElementById("analysis-section") as HTMLDetailsElement;

  function render(): void {
    const id = decodeURIComponent(location.hash.slice(1));
    const target = id ? document.getElementById(id) : null;
    const section = sections.find((item) => item === target || (target && item.contains(target)));
    const showAnalysis = target === analysisDetails || (target && analysisDetails.contains(target));
    const isHome = !section && !showAnalysis;
    sections.forEach((item) => { item.hidden = item !== section; });
    tiles.hidden = !isHome && !(showAnalysis && supportsModal);
    home.hidden = isHome || (!!showAnalysis && supportsModal);
    if (target && section) {
      let parent: HTMLElement | null = target;
      while (parent && parent !== section) {
        if (parent instanceof HTMLDetailsElement) parent.open = true;
        parent = parent.parentElement;
      }
    }
    if (showAnalysis) {
      analysisDetails.open = true;
      if (!analysis.open && supportsModal) analysis.showModal();
      else if (!analysis.open) {
        analysis.classList.add("module-dialog--page");
        analysis.setAttribute("role", "region");
        analysis.setAttribute("open", "");
        closeAnalysis.focus();
      }
    } else if (analysis.open) {
      if (typeof analysis.close === "function") analysis.close();
      else analysis.removeAttribute("open");
      if (isHome) analysisLink.focus();
    }
  }
  closeAnalysis.addEventListener("click", () => { location.hash = "dashboard"; });
  analysis.addEventListener("keydown", (event) => {
    if (!supportsModal && event.key === "Escape") {
      event.preventDefault();
      location.hash = "dashboard";
    }
  });
  analysis.addEventListener("cancel", (event) => { event.preventDefault(); location.hash = "dashboard"; });
  window.addEventListener("hashchange", render);
  render();
}
