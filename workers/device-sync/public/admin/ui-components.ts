import { createSingleFlight, formatTimestamp } from "./ui-utils.ts";
import { linkButton, node, statusBadge } from "./ui-primitives.ts";

export interface BrandLockupOptions {
  brandName?: string;
  markSrc?: string;
  orientation?: "horizontal" | "stacked";
  ownerDocument?: Document;
}

/** Render the Ribbonfish mark and wordmark as one reusable identity component. */
export function createBrandLockup(options: BrandLockupOptions = {}): HTMLElement {
  const ownerDocument = options.ownerDocument ?? document;
  const orientation = options.orientation ?? "horizontal";
  const lockup = node("div", undefined, `brand-lockup brand-lockup--${orientation}`, ownerDocument);
  const mark = node("img", undefined, "brand-lockup__mark", ownerDocument);
  mark.src = options.markSrc ?? "/admin/ribbonfish-mark.svg";
  mark.alt = "";
  mark.width = 56;
  mark.height = 45;
  mark.decoding = "async";
  lockup.append(mark, node("span", options.brandName ?? "Ribbonfish", "brand-lockup__name", ownerDocument));
  return lockup;
}

export interface LoadingIndicatorOptions {
  defaultLabel?: string;
  imageSrc?: string;
  ownerDocument?: Document;
}

export interface LoadingIndicatorComponent {
  element: HTMLElement;
  begin(label?: string): () => void;
  isLoading(): boolean;
}

export type RefreshMode = "initial" | "manual" | "background" | "action";

export interface RefreshCoordinatorOptions<T> {
  operation(): Promise<T>;
  hasUnsavedChanges(): boolean;
  confirmDiscard(): boolean;
  loading: LoadingIndicatorComponent;
}

/** Coordinate refresh prompts, quiet polling, shared in-flight work, and explicit busy feedback. */
export function createRefreshCoordinator<T>(options: RefreshCoordinatorOptions<T>): (mode?: RefreshMode) => Promise<T | undefined> {
  const operation = createSingleFlight(options.operation);
  return async (mode: RefreshMode = "action") => {
    if (options.hasUnsavedChanges()) {
      if (mode === "background" || mode === "initial") return undefined;
      if (!options.confirmDiscard()) return undefined;
    }

    if (mode !== "initial" && mode !== "manual") return operation();
    const finishLoading = options.loading.begin(mode === "initial" ? "Loading Ribbonfish…" : "Refreshing Ribbonfish…");
    try {
      return await operation();
    } finally {
      finishLoading();
    }
  };
}

/** A shared mascot status overlay that remains visible until every operation finishes. */
export function createLoadingIndicator(options: LoadingIndicatorOptions = {}): LoadingIndicatorComponent {
  const ownerDocument = options.ownerDocument ?? document;
  const defaultLabel = options.defaultLabel ?? "Loading Ribbonfish…";
  const element = node("div", undefined, "loading-indicator ribbonfish-loading", ownerDocument);
  element.id = "ribbonfish-loading";
  element.hidden = true;
  element.setAttribute("role", "status");
  element.setAttribute("aria-live", "polite");
  element.setAttribute("aria-atomic", "true");

  const image = node("img", undefined, "loading-indicator__mascot", ownerDocument);
  image.src = options.imageSrc ?? "/admin/ribbonfish-loading.svg";
  image.alt = "";
  image.width = 128;
  image.height = 70;
  const label = node("span", defaultLabel, "loading-indicator__label", ownerDocument);
  element.append(image, label);

  const activeOperations: Array<{ label: string }> = [];
  const update = () => {
    element.hidden = activeOperations.length === 0;
    label.textContent = activeOperations.at(-1)?.label ?? defaultLabel;
  };

  return {
    element,
    begin(nextLabel = defaultLabel) {
      const operation = { label: nextLabel };
      activeOperations.push(operation);
      update();
      let finished = false;
      return () => {
        if (finished) return;
        finished = true;
        const index = activeOperations.indexOf(operation);
        if (index >= 0) activeOperations.splice(index, 1);
        update();
      };
    },
    isLoading: () => activeOperations.length > 0,
  };
}

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

export interface PageHeaderOptions {
  eyebrow?: string;
  title: string;
  titleId?: string;
  titleLevel?: "h1" | "h2" | "h3";
  description?: string;
  metadata?: string[];
  actions?: HTMLElement[];
  actionsLabel?: string;
  ownerDocument?: Document;
}

let generatedPageHeaderDescriptionID = 0;

/** Render a reusable page heading with optional context and native actions. */
export function createPageHeader(options: PageHeaderOptions): HTMLElement {
  const ownerDocument = options.ownerDocument ?? document;
  const header = node("header", undefined, "page-header", ownerDocument);
  const content = node("div", undefined, "page-header__content", ownerDocument);

  if (options.eyebrow) content.append(node("p", options.eyebrow, "eyebrow", ownerDocument));

  const title = node(options.titleLevel ?? "h1", options.title, "page-header__title", ownerDocument);
  if (options.titleId) title.id = options.titleId;
  content.append(title);

  if (options.description) {
    const description = node("p", options.description, "page-header__description", ownerDocument);
    description.id = `page-header-description-${++generatedPageHeaderDescriptionID}`;
    title.setAttribute("aria-describedby", description.id);
    content.append(description);
  }

  const metadata = node("div", undefined, "page-header__meta", ownerDocument);
  metadata.setAttribute("role", "status");
  metadata.setAttribute("aria-live", "polite");
  options.metadata?.forEach((item) => metadata.append(node("span", item, undefined, ownerDocument)));
  metadata.hidden = !options.metadata?.length;
  content.append(metadata);

  header.append(content);
  if (options.actions?.length) {
    const actions = node("div", undefined, "page-header__actions", ownerDocument);
    actions.setAttribute("role", "group");
    actions.setAttribute("aria-label", options.actionsLabel ?? "Page actions");
    actions.append(...options.actions);
    header.append(actions);
  }

  return header;
}

/** Update the page's concise live status without rebuilding its heading or actions. */
export function setPageHeaderMetadata(header: HTMLElement, items: string[]): void {
  const metadata = header.querySelector<HTMLElement>(".page-header__meta");
  if (!metadata) return;
  metadata.replaceChildren(...items.map((item) => node("span", item, undefined, header.ownerDocument)));
  metadata.hidden = items.length === 0;
}

export interface ToolbarGroupOptions {
  label: string;
  items: HTMLElement[];
  alignEnd?: boolean;
}

export interface ToolbarOptions {
  label: string;
  groups: ToolbarGroupOptions[];
  className?: string;
  ownerDocument?: Document;
}

/** Group independent controls in source order without adding composite keyboard behavior. */
export function createToolbar(options: ToolbarOptions): HTMLElement {
  const ownerDocument = options.ownerDocument ?? document;
  const className = ["toolbar", options.className].filter(Boolean).join(" ");
  const toolbar = node("div", undefined, className, ownerDocument);
  toolbar.setAttribute("role", "group");
  toolbar.setAttribute("aria-label", options.label);

  options.groups.forEach((groupOptions) => {
    const group = node("div", undefined, `toolbar__group${groupOptions.alignEnd ? " toolbar__group--end" : ""}`, ownerDocument);
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", groupOptions.label);
    group.append(...groupOptions.items);
    toolbar.append(group);
  });

  return toolbar;
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

export interface FindingCardOptions {
  ownerDocument?: Document;
}

/** Render a reusable evidence card with a clear severity and next action. */
export function renderFindingCard(finding: FindingCardModel, options: FindingCardOptions = {}): HTMLElement {
  const ownerDocument = options.ownerDocument ?? document;
  const card = node("article", undefined, `finding-card finding-card--${finding.severity}`, ownerDocument);
  card.dataset.findingKey = finding.key;
  card.setAttribute("role", "listitem");
  card.setAttribute("aria-labelledby", `finding-card-${finding.key}-title`);

  const heading = node("div", undefined, "finding-card__heading", ownerDocument);
  const title = node("h4", finding.title, undefined, ownerDocument);
  title.id = `finding-card-${finding.key}-title`;
  const badge = statusBadge(
    finding.severity === "action" ? "Action needed" : "Review",
    finding.severity === "action" ? "warning" : "neutral",
    ownerDocument,
  );
  heading.append(title, badge);

  const evidence = node("p", undefined, "finding-card__evidence", ownerDocument);
  evidence.append(node("strong", "Evidence: ", undefined, ownerDocument), ownerDocument.createTextNode(finding.evidence));
  card.append(heading, evidence);
  if (finding.updatedAt !== null) {
    card.append(node("p", `Updated ${formatTimestamp(finding.updatedAt)}`, "finding-card__updated", ownerDocument));
  }
  card.append(linkButton(finding.action.href, finding.action.label, "secondary", ownerDocument));
  return card;
}

export interface FindingListOptions extends FindingCardOptions {
  emptyMessage?: string;
}

/** Render findings as a reusable accessible list, including a useful clear state. */
export function renderFindingList(
  findings: FindingCardModel[],
  options: FindingListOptions | string = {},
): HTMLElement {
  const emptyMessage = typeof options === "string" ? options : options.emptyMessage ?? "No current issues need attention.";
  const ownerDocument = typeof options === "string" ? document : options.ownerDocument ?? document;
  if (!findings.length) return node("p", emptyMessage, "finding-list__empty", ownerDocument);
  const list = node("div", undefined, "finding-list", ownerDocument);
  list.setAttribute("role", "list");
  list.append(...findings.map((finding) => renderFindingCard(finding, { ownerDocument })));
  return list;
}
