import { formatTimestamp } from "./ui-utils.ts";
import { linkButton, node, statusBadge } from "./ui-primitives.ts";

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
