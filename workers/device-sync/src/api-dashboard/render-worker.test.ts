import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
const wrangler = createRequire(import.meta.url).resolve("wrangler");

async function postWhenReady(child: ChildProcess, payload: unknown, workerURL: () => string | undefined, readLogs: () => string) {
  const deadline = Date.now() + 20_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Worker exited with code ${child.exitCode}: ${readLogs()}`);
    }
    const url = workerURL();
    if (!url) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      continue;
    }
    try {
      return await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(1_000),
      });
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Worker did not become available: ${String(lastError)}\n${readLogs()}`);
}

async function stopWorker(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  if (process.platform !== "win32" && child.pid) {
    try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
  } else {
    child.kill("SIGTERM");
  }
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

test("Worker raster output is valid and changes when service health changes", { timeout: 30_000 }, async (t) => {
  const userConfig = await mkdtemp(join(tmpdir(), "ribbonfish-wrangler-config-"));
  const child = spawn(process.execPath, [wrangler, "dev", "--config", "wrangler.api-render-test.toml", "--local", "--ip", "127.0.0.1", "--port", "0"], {
    cwd: root,
    env: { ...process.env, CI: "1", XDG_CONFIG_HOME: userConfig, WRANGLER_SEND_METRICS: "false" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  let logs = "";
  child.stdout?.on("data", (chunk) => { logs += chunk.toString(); });
  child.stderr?.on("data", (chunk) => { logs += chunk.toString(); });
  const workerURL = () => /Ready on (https?:\/\/\S+)/.exec(logs)?.[1];
  t.after(async () => {
    await stopWorker(child);
    await rm(userConfig, { recursive: true, force: true });
  });

  const realistic = JSON.parse(await readFile(new URL("./fixtures/realistic-seven-source.json", import.meta.url), "utf8"));
  const operational = structuredClone(realistic);
  for (const source of operational.sources) {
    source.freshness = "fresh";
    source.status = "operational";
    source.error = undefined;
    source.incidents = [];
    source.maintenance = [];
    for (const component of source.components) if (!component.isGroup) component.status = "operational";
  }

  const outputs: Buffer[] = [];
  for (const scenario of [realistic, operational]) {
    const response = await postWhenReady(child, scenario, workerURL, () => logs);
    if (response.status !== 200) throw new Error(`Unexpected render response ${response.status}: ${await response.text()}\n${logs}`);
    assert.equal(response.headers.get("Content-Type"), "image/png");
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.toString("hex", 0, 8), "89504e470d0a1a0a", "response is a PNG image");
    assert.equal(bytes.readUInt32BE(16), scenario.width);
    assert.equal(bytes.readUInt32BE(20), scenario.height);
    outputs.push(bytes);
  }

  assert.notDeepEqual(outputs[0], outputs[1], "the Worker image reflects service health instead of returning a fixed or blank image");
});
