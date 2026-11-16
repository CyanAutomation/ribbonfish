import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import postcss from "postcss";

const adminRoot = new URL("../public/admin/", import.meta.url);

async function readAdminAssets() {
  const [cssText, html] = await Promise.all([
    readFile(new URL("styles.css", adminRoot), "utf8"),
    readFile(new URL("index.html", adminRoot), "utf8"),
  ]);
  return { cssText, css: postcss.parse(cssText), html };
}

function rulesFor(root: postcss.Root, selector: string) {
  const rules: postcss.Rule[] = [];
  root.walkRules((rule) => {
    if (rule.selector.split(",").map((part) => part.trim()).includes(selector)) rules.push(rule);
  });
  return rules;
}

test("admin stylesheet drops selectors with no markup or module references", async () => {
  const { cssText } = await readAdminAssets();
  for (const selector of [".section-nav", ".section-nav__more", ".child-tiles", ".dashboard-home"]) {
    assert.doesNotMatch(cssText, new RegExp(selector.replaceAll(".", "\\.")));
  }
});

test("admin layout uses the shared rem breakpoint set and scopes grid headings", async () => {
  const { css, cssText } = await readAdminAssets();
  const maxWidths = [...cssText.matchAll(/@media\s*\(max-width:\s*([^)]+)\)/g)].map((match) => match[1].trim());
  assert.deepEqual([...new Set(maxWidths)].sort(), ["26.25rem", "37.5rem", "43.75rem", "53.125rem", "56rem"]);
  assert.equal(rulesFor(css, "h3").some((rule) => rule.nodes?.some((decl) => decl.type === "decl" && decl.prop === "grid-column")), false);
  assert.doesNotMatch(cssText, /\.field--wide,\s*h3\s*\{/);
});

test("capture efficiency analysis has dedicated layout rules", async () => {
  const { css } = await readAdminAssets();
  for (const selector of [
    ".capture-duration-analysis",
    ".capture-duration-analysis__sites",
    ".capture-duration-analysis__site",
    ".capture-duration-analysis__review",
  ]) {
    assert.ok(rulesFor(css, selector).length > 0, `${selector} has a stylesheet rule`);
  }
});

test("tile, chart, and brand glow colours are defined by CSS tokens", async () => {
  const { css, cssText } = await readAdminAssets();
  const tokenNames = [
    "--color-tile-blue-start", "--color-tile-blue-end",
    "--color-tile-teal-start", "--color-tile-teal-end",
    "--color-tile-plum-start", "--color-tile-plum-end",
    "--color-brand-glow-start", "--color-brand-glow-end",
    "--color-chart-0", "--color-chart-1", "--color-chart-2",
    "--color-chart-3", "--color-chart-4", "--color-chart-5",
  ];
  const rootTokens = new Set<string>();
  css.walkRules(":root", (rule) => rule.walkDecls((decl) => rootTokens.add(decl.prop)));
  for (const token of tokenNames) assert.ok(rootTokens.has(token), `${token} is declared in :root`);
  assert.doesNotMatch(cssText, /\.module-tile[^{}]*\{[^}]*#[\da-f]{3,8}/i);
  assert.doesNotMatch(cssText, /\.browser-usage-chart__segment--\d+\s*\{[^}]*#[\da-f]{3,8}/i);
  assert.doesNotMatch(cssText, /\.brand-lockup__name::after\s*\{[^}]*#[\da-f]{3,8}/i);
});

test("sidebar and home navigation have distinct accessible names", async () => {
  const { html } = await readAdminAssets();
  const labels = [...html.matchAll(/<nav\b[^>]*aria-label="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(labels).size, labels.length);
});
