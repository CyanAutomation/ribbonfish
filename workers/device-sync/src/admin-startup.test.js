import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

test("management page starts, renders its data, and dismisses errors", async () => {
  const html = await readFile(new URL("../public/admin/index.html", import.meta.url), "utf8");
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL("../public/admin/app.js", import.meta.url))],
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
  });
  const dom = new JSDOM(html, { url: "https://example.test/admin/", runScripts: "outside-only" });
  const { window } = dom;
  const calls = [];
  let fail = false;
  const overview = {
    environment: { production: true },
    asset_health: { missing: [] },
    playlists: [], devices: [], audit: [], capture_targets: [],
    active_playlist: null,
  };
  window.fetch = async (path) => {
    calls.push(path);
    return {
      ok: !fail,
      json: async () => fail ? { error: "Refresh failed" } :
        path === "/admin/api/overview" ? overview : [],
    };
  };
  try {
    window.eval(bundle.outputFiles[0].text);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ["/admin/api/overview", "/admin/api/enrollment-requests", "/admin/api/capture-decisions"]);
    assert.match(window.document.querySelector("#playlists").textContent, /No playlists yet/);
    assert.match(window.document.querySelector("#devices").textContent, /No devices have been approved/);

    fail = true;
    window.document.querySelector("#reload").click();
    await new Promise((resolve) => setImmediate(resolve));
    const notice = window.document.querySelector('[data-feedback-slot="global"]');
    assert.equal(notice.hidden, false);
    assert.match(notice.textContent, /Refresh failed/);
    notice.querySelector("[data-dismiss-feedback]").click();
    assert.equal(notice.hidden, true);
  } finally {
    window.close();
  }
});
