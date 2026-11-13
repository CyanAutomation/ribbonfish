import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const assetNames = ["favicon.svg", "ribbonfish-mark.svg", "ribbonfish-loading.svg"] as const;

test("Ribbonfish brand assets are real self-contained vector SVGs", async () => {
  for (const name of assetNames) {
    const svg = await readFile(new URL(`../public/admin/${name}`, import.meta.url), "utf8");
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.match(svg, /viewBox="/);
    assert.match(svg, /<path\b/);
    assert.doesNotMatch(svg, /<image\b|data:image\/|<foreignObject\b|<script\b/i);
  }
});

test("management UI uses the S identity and exposes the infinity mascot for loading", async () => {
  const html = await readFile(new URL("../public/admin/index.html", import.meta.url), "utf8");
  const css = await readFile(new URL("../public/admin/styles.css", import.meta.url), "utf8");
  assert.match(html, /href="\/admin\/favicon\.svg"/);
  assert.match(html, /src="\/admin\/ribbonfish-mark\.svg"/);
  assert.match(html, /src="\/admin\/ribbonfish-loading\.svg"/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
});

test("management asset publisher and HTTP allowlist include both marks and the SVG favicon", async () => {
  const publisher = await readFile(new URL("../scripts/publish-admin-assets.ts", import.meta.url), "utf8");
  const routes = await readFile(new URL("./admin.ts", import.meta.url), "utf8");
  for (const name of assetNames) {
    assert.ok(publisher.includes(`["${name}", "image/svg+xml"]`), `${name} must be published to R2`);
    assert.ok(routes.includes(`"/admin/${name}"`), `${name} must be served by the management worker`);
  }
});
