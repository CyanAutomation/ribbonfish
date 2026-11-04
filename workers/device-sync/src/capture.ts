import { MAX_ASSET_BYTES, isPNG, storePngAsset } from "./asset-store.ts";
import { ASSET_WRITE_LEASE_MS } from "./asset-registry.ts";
import { isSupportedCaptureInterval } from "./intervals.ts";

export const MAX_CAPTURE_TIMEOUT_MS = 45_000;
export const MAX_CAPTURE_PIXELS = 3840 * 2160;

const MAX_URL_LENGTH = 2048;
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".test", ".invalid", ".onion", ".arpa"];

interface CaptureErrorOptions {
  retryable?: boolean;
  status?: number | null;
  browserMs?: number;
  browserRunElapsedMs?: number;
  browserStarted?: boolean;
  cause?: unknown;
}

export interface CaptureTarget {
  url: string;
  viewport_width: number;
  viewport_height: number;
  wait_for_selector?: string | null;
}

export class CaptureError extends Error {
  retryable: boolean;
  status: number | null;
  browserMs: number;
  browserRunElapsedMs: number;
  browserStarted: boolean;
  constructor(message: string, { retryable = false, status = null, browserMs = 0, browserRunElapsedMs = 0, browserStarted = false, cause }: CaptureErrorOptions = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CaptureError";
    this.retryable = retryable;
    this.status = status;
    this.browserMs = browserMs;
    this.browserRunElapsedMs = browserRunElapsedMs;
    this.browserStarted = browserStarted;
  }
}

export function normalizeCaptureURL(value: unknown) {
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

export function validateCaptureTargetURL(value: unknown, allowedHosts: unknown) {
  const normalized = normalizeCaptureURL(value);
  const hostname = new URL(normalized).hostname.toLowerCase();
  const allowlist = new Set(String(allowedHosts ?? "")
    .split(",").map((host) => host.trim().toLowerCase()).filter(Boolean));
  if (allowlist.size > 0 && !allowlist.has(hostname)) {
    throw new Error("The webpage host is not on the configured capture allowlist.");
  }
  return normalized;
}

export function validateCaptureSettings(value: { capture_interval_seconds?: unknown; viewport?: { width?: unknown; height?: unknown } | null; wait_for_selector?: unknown } | null | undefined) {
  const interval = value?.capture_interval_seconds;
  const viewport = value?.viewport;
  if (!isSupportedCaptureInterval(interval)) {
    throw new Error("Capture interval must be one of the supported values: 15m, 30m, 1h, 3h, 6h, 12h, or 24h.");
  }
  if (!viewport || typeof viewport.width !== "number" || typeof viewport.height !== "number" || !Number.isSafeInteger(viewport.width) || !Number.isSafeInteger(viewport.height) ||
      viewport.width < 320 || viewport.width > 3840 || viewport.height < 240 || viewport.height > 2160 ||
      viewport.width * viewport.height > MAX_CAPTURE_PIXELS) {
    throw new Error("Viewport must be between 320×240 and 3840×2160, within the supported pixel limit.");
  }
  return {
    capture_interval_seconds: interval,
    viewport_width: viewport.width,
    viewport_height: viewport.height,
    wait_for_selector: normalizeCaptureSelector(value?.wait_for_selector),
  };
}

export function normalizeCaptureSelector(value: unknown) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error("Wait for selector must be text up to 256 characters.");
  const selector = value.trim();
  if (!selector) return null;
  if (selector.length > 256 || /[\u0000-\u001f\u007f]/.test(selector)) {
    throw new Error("Wait for selector must be text up to 256 characters without control characters.");
  }
  return selector;
}

export async function captureScreenshot(target: CaptureTarget, env: Pick<ManagementBindings, "CAPTURE_ALLOWED_HOSTS" | "BROWSER" | "ASSETS" | "DB">) {
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
  const waitForSelector = normalizeCaptureSelector(target.wait_for_selector);

  let response;
  const browserRunStartedAt = performance.now();
  try {
    response = await env.BROWSER.quickAction("screenshot", {
      url,
      viewport: { width, height },
      screenshotOptions: { type: "png", fullPage: false },
      gotoOptions: { waitUntil: "domcontentloaded", timeout: MAX_CAPTURE_TIMEOUT_MS },
      ...(waitForSelector ? { waitForSelector: { selector: waitForSelector } } : {}),
    });
  } catch (error) {
    throw new CaptureError("Browser Run screenshot request failed.", {
      retryable: true,
      browserStarted: true,
      browserRunElapsedMs: elapsedSince(browserRunStartedAt),
      cause: error,
    });
  }

  let browserMs = 0;
  try { browserMs = parseBrowserMilliseconds(response?.headers?.get?.("X-Browser-Ms-Used")); } catch {}
  const completedRequest = { browserMs, browserStarted: true, browserRunElapsedMs: elapsedSince(browserRunStartedAt) };
  if (!response || typeof response.ok !== "boolean" || typeof response.headers?.get !== "function") {
    throw new CaptureError("Browser Run returned an invalid response.", completedRequest);
  }
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

function elapsedSince(startedAt: number) {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function parseBrowserMilliseconds(value: string | null) {
  if (!value || !/^\d+$/.test(value)) return 0;
  const milliseconds = Number(value);
  return Number.isSafeInteger(milliseconds) ? milliseconds : 0;
}

async function readBoundedBody(response: Response, maxBytes: number, captureInfo: CaptureErrorOptions) {
  const length = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(length) && length > maxBytes) {
    await response.body?.cancel();
    throw new CaptureError("Screenshot exceeds the configured image size limit.", captureInfo);
  }
  if (!response.body) throw new CaptureError("Browser Run returned an empty screenshot.", captureInfo);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
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
