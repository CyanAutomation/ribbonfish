/** Narrow an untrusted value to a non-array object before inspecting its fields. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Narrow an untrusted value to a string without JavaScript coercion. */
export function isString(value: unknown): value is string {
  return typeof value === "string";
}

/** Check a JSON-like object has exactly the listed own enumerable keys. */
export function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** Check a JSON-like object contains no keys outside the allowlist. */
export function hasOnlyKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).every((key) => keys.includes(key));
}
