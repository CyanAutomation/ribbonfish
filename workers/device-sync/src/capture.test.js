import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  captureScreenshot,
  normalizeCaptureURL,
  validateCaptureSettings,
} from "./capture.js";

const png = new Uint8Array(await readFile(new URL("../../../agent/defaults/assets/service-health.png", import.meta.url)));

test("capture URLs require canonical public HTTPS hostnames", () => {
  assert.equal(normalizeCaptureURL("https://Example.com/dashboard#status"), "https://example.com/dashboard#status");
  for (const url of [
    "http://example.com",
    "https://user:pass@example.com/",
    "https://localhost/",
    "https://worker.local/",
    "https://127.0.0.1/",
    "https://169.254.169.254/latest/meta-data/",
    "https://[::1]/",
    "https://example.com:8443/",
  ]) {
    assert.throws(() => normalizeCaptureURL(url), /public HTTPS URL/i, url);
  }
});

test("capture settings enforce the one-minute floor and bounded viewport", () => {
  assert.deepEqual(validateCaptureSettings({
    capture_interval_seconds: 300,
    viewport: { width: 1920, height: 1080 },
  }), {
    capture_interval_seconds: 300,
    viewport_width: 1920,
    viewport_height: 1080,
  });
  for (const input of [
    { capture_interval_seconds: 59, viewport: { width: 1920, height: 1080 } },
    { capture_interval_seconds: 60, viewport: { width: 0, height: 1080 } },
    { capture_interval_seconds: 60, viewport: { width: 4096, height: 2160 } },
    { capture_interval_seconds: 60.5, viewport: { width: 1920, height: 1080 } },
  ]) {
    assert.throws(() => validateCaptureSettings(input));
  }
});

test("browser capture validates its response and stores bytes through the shared asset path", async () => {
  const writes = [];
  const env = {
    CAPTURE_ALLOWED_HOSTS: "example.com",
    BROWSER: {
      async quickAction(action, options) {
        assert.equal(action, "screenshot");
        assert.equal(options.url, "https://example.com/");
        assert.deepEqual(options.viewport, { width: 1280, height: 720 });
        assert.deepEqual(options.screenshotOptions, { type: "png", fullPage: false });
        return new Response(png, {
          headers: { "Content-Type": "image/png", "X-Browser-Ms-Used": "1234" },
        });
      },
    },
    ASSETS: {
      async head() { return null; },
      async put(key, bytes) { writes.push({ key, bytes: new Uint8Array(bytes) }); },
    },
  };

  const result = await captureScreenshot({
    url: "https://example.com/",
    viewport_width: 1280,
    viewport_height: 720,
  }, env);

  assert.equal(result.size, png.byteLength);
  assert.equal(result.browserMs, 1234);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.equal(writes[0].key, `assets/${result.sha256}`);
  assert.deepEqual(writes[0].bytes, png);
});

test("browser capture rejects error and non-PNG responses without storing an asset", async () => {
  let writes = 0;
  const env = {
    CAPTURE_ALLOWED_HOSTS: "example.com",
    BROWSER: { async quickAction() { return new Response("upstream failed", { status: 503 }); } },
    ASSETS: { async head() { return null; }, async put() { writes += 1; } },
  };
  await assert.rejects(
    captureScreenshot({ url: "https://example.com/", viewport_width: 1280, viewport_height: 720 }, env),
    (error) => /Browser Run.*503/i.test(error.message) && error.browserStarted,
  );
  env.BROWSER.quickAction = async () => new Response("not a png", { headers: { "Content-Type": "text/html" } });
  await assert.rejects(captureScreenshot({ url: "https://example.com/", viewport_width: 1280, viewport_height: 720 }, env), /PNG/i);
  assert.equal(writes, 0);
});

test("browser capture does not navigate to hosts outside the configured capture allowlist", async () => {
  let browserCalls = 0;
  const env = {
    CAPTURE_ALLOWED_HOSTS: "example.com",
    BROWSER: { async quickAction() { browserCalls += 1; throw new Error("must not start browser"); } },
    ASSETS: { async head() { return null; }, async put() { throw new Error("must not store asset"); } },
  };

  await assert.rejects(
    captureScreenshot({ url: "https://attacker.example/", viewport_width: 1280, viewport_height: 720 }, env),
    /allowlist/i,
  );
  assert.equal(browserCalls, 0);
});
