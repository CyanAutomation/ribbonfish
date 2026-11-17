import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import postcss from "postcss";

const stylesheetURL = new URL("../public/admin/styles.css", import.meta.url);

function declarationsFor(root: postcss.Root, selector: string) {
  const declarations: postcss.Declaration[] = [];
  root.walkRules((rule) => {
    if (!rule.selector.split(",").map((part) => part.trim()).includes(selector)) return;
    rule.walkDecls((declaration) => declarations.push(declaration));
  });
  return declarations;
}

function cssValue(root: postcss.Root, selector: string, property: string) {
  const declaration = declarationsFor(root, selector).find((item) => item.prop === property);
  assert.ok(declaration, `${selector} declares ${property}`);
  return declaration.value;
}

function tokenValue(root: postcss.Root, name: string) {
  return cssValue(root, ":root", name);
}

function resolveColor(root: postcss.Root, value: string): string {
  const variable = /^var\((--[\w-]+)\)$/.exec(value);
  if (variable) return tokenValue(root, variable[1]);
  if (value === "white") return "#ffffff";
  if (value === "black") return "#000000";
  return value;
}

function luminance(color: string) {
  const match = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(color);
  assert.ok(match, `${color} is a supported CSS hex color`);
  const hex = match[1].length === 3 ? [...match[1]].map((channel) => channel + channel).join("") : match[1];
  const channels = [0, 2, 4].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255);
  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

function contrast(first: string, second: string) {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test("destructive and warning text meets WCAG contrast using the colors applied by the UI", async () => {
  const css = postcss.parse(await readFile(stylesheetURL, "utf8"));
  const danger = tokenValue(css, "--color-danger");
  const surface = tokenValue(css, "--color-surface");
  const dangerBackground = tokenValue(css, "--color-danger-bg");

  assert.equal(cssValue(css, ".button--danger", "color"), "var(--color-danger)");
  assert.equal(cssValue(css, ".button--danger", "background"), "var(--color-surface)");
  assert.equal(cssValue(css, ".button--danger:hover:not(:disabled)", "color"), "var(--color-danger-hover)");
  assert.equal(cssValue(css, ".button--danger:hover:not(:disabled)", "background"), "var(--color-danger-bg)");
  assert.equal(cssValue(css, ".confirm-dialog .button--danger", "background"), "var(--color-danger)");
  assert.equal(cssValue(css, ".confirm-dialog .button--danger", "color"), "white");
  assert.equal(cssValue(css, ".environment-tag--warning", "background"), "var(--color-danger)");
  assert.equal(cssValue(css, ".environment-tag--warning", "color"), "white");
  assert.equal(cssValue(css, ".environment-notice", "color"), "var(--color-danger)");

  // WCAG 2.2 SC 1.4.3: normal text needs a contrast ratio of at least 4.5:1.
  assert.ok(contrast(resolveColor(css, cssValue(css, ".button--danger", "color")), surface) >= 4.5,
    "outlined destructive actions remain readable on the page surface");
  assert.ok(contrast(resolveColor(css, cssValue(css, ".button--danger:hover:not(:disabled)", "color")), dangerBackground) >= 4.5,
    "hovered destructive actions remain readable on the warning surface");
  assert.ok(contrast(resolveColor(css, cssValue(css, ".confirm-dialog .button--danger", "color")), danger) >= 4.5,
    "confirmed destructive actions and warning tags remain readable on the danger color");
  assert.ok(contrast(resolveColor(css, cssValue(css, ".environment-tag--warning", "color")), danger) >= 4.5,
    "warning tags remain readable on the danger color");
  assert.ok(contrast(resolveColor(css, cssValue(css, ".environment-notice", "color")), dangerBackground) >= 4.5,
    "environment notices remain readable on the warning surface");
});
