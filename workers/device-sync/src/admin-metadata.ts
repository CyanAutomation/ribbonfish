import { isRecord, isString } from "./validation.ts";
import type { SqlRow } from "./worker-contracts.ts";

export function parseMetadata(value: unknown): SqlRow | null {
  if (!isString(value)) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed as SqlRow : {};
  } catch { return {}; }
}

export function parseMetadataArray(value: unknown): unknown[] {
  if (!isString(value)) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}
