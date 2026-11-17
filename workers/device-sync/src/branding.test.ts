import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

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
test("management shell exposes the Ribbonfish identity and an accessible loading status", async () => {
  const html = await readFile(new URL("../public/admin/index.html", import.meta.url), "utf8");
  const { document } = new JSDOM(html).window;
  const brand = document.querySelector("#brand-lockup");
  const loading = document.querySelector("#ribbonfish-loading");

  assert.equal(brand?.querySelector(".brand-lockup__name")?.textContent, "Ribbonfish");
  assert.equal(brand?.querySelector("img")?.getAttribute("src"), "/admin/ribbonfish-mark.svg");
  assert.equal(brand?.querySelector("img")?.getAttribute("alt"), "", "the adjacent heading supplies the brand name");
  assert.equal(loading?.getAttribute("role"), "status");
  assert.equal(loading?.getAttribute("aria-live"), "polite");
  assert.equal(loading?.querySelector("img")?.getAttribute("src"), "/admin/ribbonfish-loading.svg");
  assert.equal(loading?.querySelector("img")?.getAttribute("alt"), "", "the mascot is decorative");
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
