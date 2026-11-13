import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const assetNames = ["favicon.svg", "ribbonfish-mark.svg", "ribbonfish-loading.svg"] as const;
const appIconAssets = [
  ["site.webmanifest", "application/manifest+json; charset=utf-8"],
  ["apple-touch-icon.png", "image/png"],
  ["favicon-192.png", "image/png"],
  ["favicon-512.png", "image/png"],
] as const;

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
  const app = await readFile(new URL("../public/admin/app.ts", import.meta.url), "utf8");
  assert.match(html, /href="\/admin\/favicon\.svg"/);
  assert.match(html, /src="\/admin\/ribbonfish-mark\.svg"/);
  assert.match(html, /src="\/admin\/ribbonfish-loading\.svg"/);
  assert.match(app, /createBrandLockup\(/);
  assert.match(app, /createRefreshCoordinator\(/);
  assert.match(app, /refresh\("initial"\)/);
  assert.match(app, /refresh\("manual"\)/);
  assert.match(app, /refresh\("background"\)/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
});

test("management page exposes install icons and a scoped web app manifest", async () => {
  const html = await readFile(new URL("../public/admin/index.html", import.meta.url), "utf8");
  const manifest = JSON.parse(await readFile(new URL("../public/admin/site.webmanifest", import.meta.url), "utf8"));
  assert.match(html, /rel="manifest" href="\/admin\/site\.webmanifest"/);
  assert.match(html, /rel="apple-touch-icon" href="\/admin\/apple-touch-icon\.png"/);
  assert.match(html, /name="theme-color" content="#102a43"/);
  assert.equal(manifest.name, "Ribbonfish Management");
  assert.equal(manifest.start_url, "/admin/");
  assert.equal(manifest.scope, "/admin/");
  assert.deepEqual(manifest.icons.map(({ sizes, type }) => [sizes, type]), [
    ["192x192", "image/png"],
    ["512x512", "image/png"],
  ]);

  for (const [name, size] of [["apple-touch-icon.png", 180], ["favicon-192.png", 192], ["favicon-512.png", 512]] as const) {
    const png = await readFile(new URL(`../public/admin/${name}`, import.meta.url));
    assert.equal(png.toString("hex", 0, 8), "89504e470d0a1a0a", `${name} is a PNG`);
    assert.equal(png.readUInt32BE(16), size, `${name} width`);
    assert.equal(png.readUInt32BE(20), size, `${name} height`);
  }
});

test("management asset publisher and HTTP allowlist include brand and install icon assets", async () => {
  const publisher = await readFile(new URL("../scripts/publish-admin-assets.ts", import.meta.url), "utf8");
  const routes = await readFile(new URL("./admin.ts", import.meta.url), "utf8");
  for (const name of assetNames) {
    assert.ok(publisher.includes(`["${name}", "image/svg+xml"]`), `${name} must be published to R2`);
    assert.ok(routes.includes(`"/admin/${name}"`), `${name} must be served by the management worker`);
  }
  for (const [name, contentType] of appIconAssets) {
    assert.ok(publisher.includes(`["${name}", "${contentType}"]`), `${name} must be published to R2`);
    assert.ok(routes.includes(`"/admin/${name}"`), `${name} must be served by the management worker`);
    assert.ok(routes.includes(`contentType: "${contentType}"`), `${name} has the matching response content type`);
  }
});
