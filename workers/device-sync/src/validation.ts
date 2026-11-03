/** Narrow an untrusted value to a non-array object before inspecting its fields. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
