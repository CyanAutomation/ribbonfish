import { HTTPError } from "./http-error.ts";
import { readBoundedStream } from "./read-bounded-stream.ts";

export async function readRequestBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  const body = request.body;
  if (!body) throw new HTTPError(400, "request body is required");
  return readBoundedStream(body, maxBytes, () => new HTTPError(413, "request body exceeds size limit"));
}

export function parseJSONBody(bodyBytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bodyBytes));
  } catch {
    throw new HTTPError(400, "request body must be valid JSON");
  }
}
