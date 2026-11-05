import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
const wrangler = createRequire(import.meta.url).resolve("wrangler");

test("resvg WebAssembly and bundled font render under the Cloudflare Workers runtime", async (t) => {
  const port = 9867;
  const child = spawn(process.execPath, [wrangler, "dev", "--config", "wrangler.api-render-test.toml", "--local", "--port", String(port)], {
    cwd: root, env: { ...process.env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
  child.stderr.on("data", (chunk) => { logs += chunk.toString(); });
  t.after(() => child.kill("SIGTERM"));
  const data = {
    width: 1920, height: 1080,
    sources: Array.from({ length: 7 }, (_, index) => ({
      id: `sample-${index + 1}`, provider: index < 5 ? "uptime-kuma" : "atlassian-statuspage",
      displayName: `Service region ${index + 1}`, fetchedAt: "2026-01-01T00:00:00.000Z",
      freshness: index === 6 ? "unavailable" : "fresh", status: index === 6 ? "stale" : index === 2 ? "degraded" : "operational",
      statusDescription: index === 6 ? "Status source unavailable" : index === 2 ? "Partial service disruption" : "All services operational",
      ...(index === 6 ? { error: "Status API request timed out." } : {}),
      components: index === 6 ? [] : Array.from({ length: index === 0 ? 9 : 3 }, (_, component) => ({
        id: `service-${component + 1}`, name: component === 0 ? "Core service" : `Regional service ${component + 1}`,
        status: component === 1 && index === 2 ? "degraded" : "operational", ...(component === 0 ? { latencyMs: 87 } : {}),
        sampledAt: null, groupId: "group-1", groupName: index === 5 ? "Platform" : "Services",
      })),
      incidents: index === 2 ? [{ id: "event-1", name: "Elevated response time", status: "investigating", impact: "minor", updatedAt: null }] : [],
      maintenance: [],
    })),
  };
  let response: Response | null = null;
  let failure: unknown;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      response = await fetch(`http://127.0.0.1:${port}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
      break;
    } catch (error) { failure = error; await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  assert.ok(response, `Worker did not become available: ${String(failure)}\n${logs}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(response.status, 200, `${new TextDecoder().decode(bytes)}\n${logs}`);
  assert.equal(response.headers.get("Content-Type"), "image/png");
  assert.equal(bytes[0], 137);
  assert.equal(String.fromCharCode(...bytes.slice(1, 4)), "PNG");
  assert.equal(new DataView(bytes.buffer, bytes.byteOffset).getUint32(16), 1920);
  assert.equal(new DataView(bytes.buffer, bytes.byteOffset).getUint32(20), 1080);
  assert.ok(bytes.byteLength < 32 * 1024 * 1024);
  const output = join(root, "../../examples/api-dashboard/status-dashboard.png");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, bytes);
});
