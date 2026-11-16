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

function declarationsFor(root: postcss.Root, selector: string) {
  const declarations: postcss.Declaration[] = [];
  for (const rule of rulesFor(root, selector)) rule.walkDecls((declaration) => declarations.push(declaration));
  return declarations;
}

function tokenValue(root: postcss.Root, name: string) {
  const declaration = declarationsFor(root, ":root").find((item) => item.prop === name);
  assert.ok(declaration, `${name} is declared in :root`);
  return declaration.value;
}

function contrast(first: string, second: string) {
  const luminance = (hex: string) => {
    const rgb = hex.match(/[\da-f]{2}/gi)?.map((channel) => parseInt(channel, 16) / 255) ?? [];
    assert.equal(rgb.length, 3, `${hex} is a 6-digit hex colour`);
    const linear = rgb.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  };
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
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
    "--color-brand-glow-start", "--color-brand-glow-end",
    "--color-chart-0", "--color-chart-1", "--color-chart-2",
    "--color-chart-3", "--color-chart-4", "--color-chart-5",
  ];
  const rootTokens = new Set<string>();
  css.walkRules(":root", (rule) => rule.walkDecls((decl) => rootTokens.add(decl.prop)));
  for (const token of tokenNames) assert.ok(rootTokens.has(token), `${token} is declared in :root`);
  assert.doesNotMatch(cssText, /\.module-tile|#168d9b/i);
  assert.doesNotMatch(cssText, /\.browser-usage-chart__segment--\d+\s*\{[^}]*#[\da-f]{3,8}/i);
  assert.doesNotMatch(cssText, /\.brand-lockup__name::after\s*\{[^}]*#[\da-f]{3,8}/i);
});

test("sidebar and home navigation have distinct accessible names", async () => {
  const { html } = await readAdminAssets();
  const labels = [...html.matchAll(/<nav\b[^>]*aria-label="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(labels).size, labels.length);
});

test("admin type scale and desktop controls stay dense while touch controls stay large", async () => {
  const { css } = await readAdminAssets();
  assert.equal(tokenValue(css, "--font-size-body"), "1rem");
  assert.equal(tokenValue(css, "--font-size-small"), ".875rem");
  assert.equal(tokenValue(css, "--control-height"), "2.25rem");
  assert.ok(declarationsFor(css, ".button").some((item) => item.prop === "padding" && item.value === ".4rem .85rem"));
  assert.ok(declarationsFor(css, ".field-control").some((item) => item.prop === "padding" && item.value === ".4rem .65rem"));
  for (const selector of [".data-table", ".data-card", "label", ".field-hint"]) {
    assert.ok(declarationsFor(css, selector).some((item) => item.prop === "font-size" && item.value === "var(--font-size-small)"),
      `${selector} uses the dense text size`);
  }
  let touchControlSize = false;
  css.walkAtRules("media", (media) => {
    if (!/pointer:\s*coarse|max-width:\s*43\.75rem/.test(media.params)) return;
    media.walkRules(":root", (rule) => {
      touchControlSize ||= rule.nodes.some((node) => node.type === "decl" && node.prop === "--control-height" && node.value === "2.75rem");
    });
  });
  assert.ok(touchControlSize, "coarse pointer and narrow layouts retain the larger target size");
});

test("header navigation toggle has an icon, accessible name, tooltip and controls", async () => {
  const { html, css } = await readAdminAssets();
  const toggle = html.match(/<button\b[^>]*id="module-navigation-toggle"[^>]*>([\s\S]*?)<\/button>/)?.[0];
  assert.ok(toggle);
  assert.match(toggle, /aria-label="Toggle navigation"/);
  assert.match(toggle, /title="Toggle navigation"/);
  assert.match(toggle, /aria-controls="module-navigation"/);
  assert.match(toggle, /aria-expanded="true"/);
  assert.match(toggle, /<svg\b[^>]*aria-hidden="true"/);
  assert.match(toggle, /class="[^"]*button--header/);
  assert.ok(rulesFor(css, ".button--header").length > 0);
});

test("header, sidebar, and main share the wide layout grid and environment warnings are prominent", async () => {
  const { css } = await readAdminAssets();
  const shellColumns = declarationsFor(css, ".management-shell")
    .find((item) => item.prop === "grid-template-columns")?.value;
  const headerColumns = declarationsFor(css, ".app-header")
    .find((item) => item.prop === "grid-template-columns")?.value;
  assert.equal(headerColumns, shellColumns);
  assert.ok(declarationsFor(css, "main").some((item) => item.prop === "width" && item.value === "min(1400px, calc(100% - 1rem))"));
  assert.ok(declarationsFor(css, ".overview-metrics").some((item) => item.prop === "display" && item.value === "grid"));
  assert.ok(declarationsFor(css, ".environment-tag--warning").some((item) => item.prop === "background" && item.value === "var(--color-danger)"));
  assert.ok(declarationsFor(css, ".environment-notice").some((item) => item.prop === "border-inline-start" && item.value.includes("var(--color-danger)")));
});

test("destructive actions are outlined outside confirmation and contrast clears the reported thresholds", async () => {
  const { css } = await readAdminAssets();
  const action = declarationsFor(css, ".button--danger");
  assert.ok(action.some((item) => item.prop === "background" && item.value === "var(--color-surface)"));
  assert.ok(action.some((item) => item.prop === "color" && item.value === "var(--color-danger)"));
  assert.ok(declarationsFor(css, ".confirm-dialog .button--danger")
    .some((item) => item.prop === "background" && item.value === "var(--color-danger)"));
  assert.ok(contrast("#ffffff", "#13717f") >= 4.5);
  assert.ok(contrast(tokenValue(css, "--color-brand-border-muted"), tokenValue(css, "--color-brand-dark")) >= 3);
});
