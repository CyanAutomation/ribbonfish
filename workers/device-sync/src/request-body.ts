import { HTTPError } from "./http-error.ts";

export async function readRequestBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) throw new HTTPError(400, "request body is required");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new HTTPError(413, "request body exceeds size limit");
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

export function parseJSONBody(bodyBytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bodyBytes));
  } catch {
    throw new HTTPError(400, "request body must be valid JSON");
  }
}
