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
        path === "/admin/api/overview" ? overview : path === "/admin/api/intervals" ? {
          capture: { default: 86400, options: [
            { value: 900, label: "15 minutes" }, { value: 1800, label: "30 minutes" },
            { value: 3600, label: "1 hour" }, { value: 21600, label: "6 hours" }, { value: 86400, label: "24 hours" },
          ] },
          rotation: { default: "90s", options: [
            { value: "30s", label: "30 seconds" }, { value: "60s", label: "60 seconds" },
            { value: "90s", label: "90 seconds" }, { value: "120s", label: "120 seconds" }, { value: "5m", label: "5 minutes" },
          ] },
        } : [],
    };
  };
  try {
    window.eval(bundle.outputFiles[0].text);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ["/admin/api/overview", "/admin/api/enrollment-requests", "/admin/api/capture-decisions", "/admin/api/intervals"]);
    assert.match(window.document.querySelector("#playlists").textContent, /No playlists yet/);
    assert.match(window.document.querySelector("#devices").textContent, /No devices have been approved/);
    const rotation = window.document.querySelector("[name=rotation_interval]");
    const capture = window.document.querySelector("[name=capture_interval_seconds]");
    assert.deepEqual([...rotation.options].map((option) => option.value), ["30s", "60s", "90s", "120s", "5m"]);
    assert.deepEqual([...capture.options].map((option) => option.value), ["900", "1800", "3600", "21600", "86400"]);
    assert.equal(rotation.value, "90s");
    assert.equal(capture.value, "86400");

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
