/** Match the existing strong ETag and wildcard semantics used by both APIs. */
export function matchesETag(header: string | null, etag: string): boolean {
  return (header ?? "").split(",").map((value) => value.trim()).some((value) => value === "*" || value === etag);
}
