import { formatTimestamp } from "./ui-utils.ts";
import { linkButton, node, statusBadge } from "./ui-primitives.ts";

export interface SidebarControllerOptions {
  shell: HTMLElement;
  sidebar: HTMLElement;
  toggleButton: HTMLButtonElement;
  initialExpanded?: boolean;
}

export interface SidebarController {
  expand(): void;
  collapse(): void;
  toggle(): void;
  dispose(): void;
}

/** Add optional collapse/reveal behavior while leaving native navigation links intact. */
export function createSidebarController(options: SidebarControllerOptions): SidebarController {
  const { shell, sidebar, toggleButton } = options;
  const ownerDocument = sidebar.ownerDocument;
  if (!sidebar.id) throw new Error("Sidebar navigation must have an id.");
  if (toggleButton.getAttribute("aria-controls") !== sidebar.id) {
    throw new Error("Sidebar toggle must reference the navigation id with aria-controls.");
  }

  let disposed = false;
  const setExpanded = (expanded: boolean) => {
    if (disposed) throw new Error("Sidebar controller has been disposed.");
    if (!expanded && sidebar.contains(ownerDocument.activeElement)) toggleButton.focus();
    sidebar.hidden = !expanded;
    toggleButton.setAttribute("aria-expanded", String(expanded));
    shell.classList.toggle("management-shell--nav-collapsed", !expanded);
  };
  const isHidden = () => Boolean(sidebar.hidden);
  const onToggle = () => setExpanded(isHidden());

  toggleButton.type = "button";
  toggleButton.addEventListener("click", onToggle);
  toggleButton.hidden = false;
  setExpanded(options.initialExpanded ?? !isHidden());

  return {
    expand: () => setExpanded(true),
    collapse: () => setExpanded(false),
    toggle: () => setExpanded(isHidden()),
    dispose() {
      if (disposed) return;
      toggleButton.removeEventListener("click", onToggle);
      disposed = true;
      sidebar.hidden = false;
      shell.classList.remove("management-shell--nav-collapsed");
      toggleButton.setAttribute("aria-expanded", "true");
      toggleButton.hidden = true;
    },
  };
}

export type FindingCardModel = {
  key: string;
  title: string;
  severity: "action" | "review";
  evidence: string;
  updatedAt: number | null;
  action: { label: string; href: string };
};

/** Render a reusable evidence card with a clear severity and next action. */
export function renderFindingCard(finding: FindingCardModel): HTMLElement {
  const card = node("article", undefined, `finding-card finding-card--${finding.severity}`);
  card.dataset.findingKey = finding.key;
  card.setAttribute("role", "listitem");
  card.setAttribute("aria-labelledby", `finding-card-${finding.key}-title`);

  const heading = node("div", undefined, "finding-card__heading");
  const title = node("h4", finding.title);
  title.id = `finding-card-${finding.key}-title`;
  const badge = statusBadge(finding.severity === "action" ? "Action needed" : "Review", finding.severity === "action" ? "warning" : "neutral");
  heading.append(title, badge);

  const evidence = node("p", undefined, "finding-card__evidence");
  evidence.append(node("strong", "Evidence: "), document.createTextNode(finding.evidence));
  card.append(heading, evidence);
  if (finding.updatedAt !== null) {
    card.append(node("p", `Updated ${formatTimestamp(finding.updatedAt)}`, "finding-card__updated"));
  }
  card.append(linkButton(finding.action.href, finding.action.label));
  return card;
}

/** Render findings as a reusable accessible list, including a useful clear state. */
export function renderFindingList(findings: FindingCardModel[], emptyMessage = "No current issues need attention."): HTMLElement {
  if (!findings.length) return node("p", emptyMessage, "finding-list__empty");
  const list = node("div", undefined, "finding-list");
  list.setAttribute("role", "list");
  list.append(...findings.map(renderFindingCard));
  return list;
}
