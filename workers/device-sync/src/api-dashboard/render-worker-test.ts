import { renderDashboardPNG } from "./render.ts";
import type { DashboardSource } from "./model.ts";

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") return new Response("POST required", { status: 405 });
    try {
      const input = await request.json() as { sources?: DashboardSource[]; width?: number; height?: number };
      const png = await renderDashboardPNG(input.sources ?? [], input.width ?? 1920, input.height ?? 1080);
      return new Response(png, { headers: { "Content-Type": "image/png", "Content-Length": String(png.byteLength) } });
    } catch (error) {
      return new Response(error instanceof Error ? error.message : "render failed", { status: 400 });
    }
  },
};
