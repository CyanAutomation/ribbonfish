import { HTTPError } from "./http-error.ts";
import { parseJSONBody, readRequestBody } from "./request-body.ts";

const MAX_JSON_BYTES = 64 << 10;

export async function readAdminJSON(request: Request): Promise<unknown> {
  if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new HTTPError(415, "Content-Type must be application/json");
  }
  const bytes = await readRequestBody(request, MAX_JSON_BYTES);
  return parseJSONBody(bytes);
}
