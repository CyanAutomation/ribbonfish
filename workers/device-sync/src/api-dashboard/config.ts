import type { Provider } from "./model.ts";

export type SourceConfig = {
  [key: string]: unknown;
  id: string;
  provider: Provider;
  display_name: string;
  enabled: boolean;
  hostname: string;
  slug?: string;
};

export type ApiDashboardConfig = { sources: SourceConfig[]; width: number; height: number };
export type SourceFieldName = "id" | "provider" | "display_name" | "enabled" | "hostname" | "slug";
export type SourceFieldErrors = Partial<Record<SourceFieldName, string>>;

export const DEFAULT_API_DASHBOARD_INTERVAL = 300;
export const MAX_API_DASHBOARD_SOURCES = 30;

/** Shared source validation used by the management editor and Worker API. */
export function sourceConfigErrors(value: unknown): SourceFieldErrors {
  const errors: SourceFieldErrors = {};
  const row = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const hostname = typeof row.hostname === "string" ? row.hostname : "";
  if (typeof row.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/.test(row.id)) errors.id = "Use 1 to 63 letters, numbers, dots, underscores or hyphens.";
  if (row.provider !== "uptime-kuma" && row.provider !== "atlassian-statuspage") errors.provider = "Choose a supported API provider.";
  if (typeof row.display_name !== "string" || !row.display_name.trim() || row.display_name.length > 100 || /[\u0000-\u001f\u007f]/.test(row.display_name)) errors.display_name = "Enter a display name from 1 to 100 characters.";
  if (typeof row.hostname !== "string" || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(hostname) || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname) || ["localhost", ".localhost", ".local", ".internal", ".test", ".invalid", ".onion", ".arpa"].some((suffix) => suffix.startsWith(".") ? hostname.endsWith(suffix) : hostname === suffix)) {
    errors.hostname = "Enter a public DNS hostname without a URL or path.";
  }
  if (typeof row.enabled !== "boolean") errors.enabled = "Choose whether this source is enabled.";
  if (row.provider === "uptime-kuma" && (typeof row.slug !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(row.slug))) errors.slug = "Enter the status-page slug using letters, numbers, underscores or hyphens.";
  return errors;
}

export function parseApiDashboardConfig(value: unknown): ApiDashboardConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Dashboard configuration must be an object.");
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.sources) || input.sources.length < 1 || input.sources.length > MAX_API_DASHBOARD_SOURCES) throw new Error("Dashboard must have between 1 and 30 sources.");
  const sources = input.sources.map((item, index) => {
    const errors = sourceConfigErrors(item);
    const first = Object.values(errors)[0];
    if (first) throw new Error(`Source ${index + 1}: ${first}`);
    const row = item as Record<string, unknown>;
    return { ...row, id: row.id as string, provider: row.provider as Provider, display_name: row.display_name as string,
      hostname: row.hostname as string, enabled: row.enabled as boolean,
      ...(typeof row.slug === "string" ? { slug: row.slug } : {}) };
  });
  if (new Set(sources.map((source) => source.id)).size !== sources.length) throw new Error("Dashboard source IDs must be unique.");
  const width = input.width ?? 1920;
  const height = input.height ?? 1080;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || Number(width) < 640 || Number(width) > 3840 || Number(height) < 360 || Number(height) > 2160 || Number(width) * Number(height) > 3840 * 2160) throw new Error("Dashboard resolution is outside the supported range.");
  return { sources, width: Number(width), height: Number(height) };
}
