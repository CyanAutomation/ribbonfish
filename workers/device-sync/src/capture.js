import { MAX_ASSET_BYTES, isPNG, storePngAsset } from "./asset-store.js";
import { ASSET_WRITE_LEASE_MS } from "./asset-registry.js";

export const MIN_CAPTURE_INTERVAL_SECONDS = 60;
export const MAX_CAPTURE_INTERVAL_SECONDS = 30 * 24 * 60 * 60;
export const MAX_CAPTURE_TIMEOUT_MS = 45_000;
export const MAX_CAPTURE_PIXELS = 3840 * 2160;

const MAX_URL_LENGTH = 2048;
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".test", ".invalid", ".onion", ".arpa"];

export class CaptureError extends Error {
  constructor(message, { retryable = false, status = null, browserMs = 0, browserStarted = false, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CaptureError";
    this.retryable = retryable;
    this.status = status;
    this.browserMs = browserMs;
    this.browserStarted = browserStarted;
  }
}

export function normalizeCaptureURL(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_LENGTH) {
    throw new Error("Enter a public HTTPS URL no longer than 2048 characters.");
  }
  let url;
  try { url = new URL(value); } catch { throw new Error("Enter a valid public HTTPS URL."); }
  const hostname = url.hostname.toLowerCase();
  const isIPv4 = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname);
  const isIPv6 = hostname.startsWith("[") && hostname.endsWith("]");
  const isSingleLabel = !hostname.includes(".");
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") ||
      isIPv4 || isIPv6 || isSingleLabel || BLOCKED_SUFFIXES.some((suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix))) {
    throw new Error("Enter a public HTTPS URL without credentials, private hosts, or a non-standard port.");
  }
  url.hostname = hostname;
  url.port = "";
  return url.toString();
}

export function validateCaptureTargetURL(value, allowedHosts) {
  const normalized = normalizeCaptureURL(value);
  const hostname = new URL(normalized).hostname.toLowerCase();
  const allowlist = new Set(String(allowedHosts ?? "")
    .split(",").map((host) => host.trim().toLowerCase()).filter(Boolean));
  if (!allowlist.has(hostname)) {
    throw new Error("The webpage host is not on the configured capture allowlist.");
  }
  return normalized;
}

export function validateCaptureSettings(value) {
  const interval = value?.capture_interval_seconds;
  const viewport = value?.viewport;
  if (!Number.isSafeInteger(interval) || interval < MIN_CAPTURE_INTERVAL_SECONDS || interval > MAX_CAPTURE_INTERVAL_SECONDS) {
    throw new Error("Capture interval must be between 60 seconds and 30 days.");
  }
  if (!viewport || !Number.isSafeInteger(viewport.width) || !Number.isSafeInteger(viewport.height) ||
      viewport.width < 320 || viewport.width > 3840 || viewport.height < 240 || viewport.height > 2160 ||
      viewport.width * viewport.height > MAX_CAPTURE_PIXELS) {
    throw new Error("Viewport must be between 320×240 and 3840×2160, within the supported pixel limit.");
  }
  return {
    capture_interval_seconds: interval,
    viewport_width: viewport.width,
    viewport_height: viewport.height,
  };
}

export async function captureScreenshot(target, env) {
  const url = validateCaptureTargetURL(target.url, env.CAPTURE_ALLOWED_HOSTS);
  const width = target.viewport_width;
  const height = target.viewport_height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width < 320 || width > 3840 || height < 240 || height > 2160 || width * height > MAX_CAPTURE_PIXELS) {
    throw new CaptureError("Stored capture viewport is invalid.");
  }
  if (!env.BROWSER || typeof env.BROWSER.quickAction !== "function") {
    throw new CaptureError("Browser Run binding is unavailable.", { retryable: true });
  }

  let response;
  try {
    response = await env.BROWSER.quickAction("screenshot", {
      url,
      viewport: { width, height },
      screenshotOptions: { type: "png", fullPage: false },
      gotoOptions: { waitUntil: "domcontentloaded", timeout: MAX_CAPTURE_TIMEOUT_MS },
    });
  } catch (error) {
    throw new CaptureError("Browser Run screenshot request failed.", { retryable: true, browserStarted: true, cause: error });
  }

  const browserMs = parseBrowserMilliseconds(response.headers.get("X-Browser-Ms-Used"));
  const completedRequest = { browserMs, browserStarted: true };
  if (!response.ok) {
    throw new CaptureError(`Browser Run screenshot request returned ${response.status}.`, {
      retryable: response.status === 429 || response.status >= 500,
      status: response.status,
      ...completedRequest,
    });
  }
  if (response.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "image/png") {
    throw new CaptureError("Browser Run did not return a PNG screenshot.", completedRequest);
  }

  const bytes = await readBoundedBody(response, MAX_ASSET_BYTES, completedRequest);
  if (!isPNG(bytes)) throw new CaptureError("Browser Run returned an invalid PNG screenshot.", completedRequest);
  try {
    const asset = await storePngAsset(bytes, env.ASSETS, {
      db: env.DB,
      stagingMs: ASSET_WRITE_LEASE_MS,
    });
    return { sha256: asset.sha256, size: asset.size, ...completedRequest };
  } catch (error) {
    throw new CaptureError("Screenshot could not be stored as an asset.", {
      retryable: true, ...completedRequest, cause: error,
    });
  }
}

function parseBrowserMilliseconds(value) {
  if (!value || !/^\d+$/.test(value)) return 0;
  const milliseconds = Number(value);
  return Number.isSafeInteger(milliseconds) ? milliseconds : 0;
}

async function readBoundedBody(response, maxBytes, captureInfo) {
  const length = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(length) && length > maxBytes) {
    await response.body?.cancel();
    throw new CaptureError("Screenshot exceeds the configured image size limit.", captureInfo);
  }
  if (!response.body) throw new CaptureError("Browser Run returned an empty screenshot.", captureInfo);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new CaptureError("Screenshot exceeds the configured image size limit.", captureInfo);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
