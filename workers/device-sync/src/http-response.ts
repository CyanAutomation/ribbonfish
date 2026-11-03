/** Headers for responses containing private device or management data. */
export function privateHeaders(values: Record<string, string> = {}): Headers {
  const headers = new Headers(values);
  headers.set("Cache-Control", "private, no-store, no-transform");
  headers.set("X-Content-Type-Options", "nosniff");
  return headers;
}

/** Serialize a response while preserving the private response policy. */
export function jsonResponse(value: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  const headers = privateHeaders({ "Content-Type": "application/json; charset=utf-8", ...extraHeaders });
  return new Response(JSON.stringify(value), { status, headers });
}
