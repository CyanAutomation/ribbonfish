import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workerDirectory = resolve(scriptDirectory, "..");
const args = process.argv.slice(2);
let config = "wrangler.dev.toml";
let bucket = "ribbonfish-management-dev";
let local = false;
const seenOptions = new Set();

for (let index = 0; index < args.length; index += 1) {
  const option = args[index];
  if (option === "--local") {
    if (seenOptions.has(option)) throw new Error("--local may only be specified once");
    seenOptions.add(option);
    local = true;
    continue;
  }
  if (option === "--config" || option === "--bucket") {
    if (seenOptions.has(option)) throw new Error(`${option} may only be specified once`);
    seenOptions.add(option);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`usage: publish-admin-assets.mjs [--config wrangler.toml] [--bucket bucket-name] [--local]`);
    }
    if (option === "--config") config = value;
    else bucket = value;
    index += 1;
    continue;
  }
  throw new Error("usage: publish-admin-assets.mjs [--config wrangler.toml] [--bucket bucket-name] [--local]");
}

execFileSync(process.execPath, [resolve(scriptDirectory, "build-admin.mjs")], {
  cwd: workerDirectory,
  stdio: "inherit",
});

const buildDirectory = resolve(workerDirectory, ".admin-build");
const files = [
  ["index.html", "text/html; charset=utf-8"],
  ["app.js", "text/javascript; charset=utf-8"],
  ["styles.css", "text/css; charset=utf-8"],
];

for (const [file, contentType] of files) {
  execFileSync("npx", [
    "wrangler", "r2", "object", "put", `${bucket}/admin/${file}`,
    "--file", resolve(buildDirectory, file),
    "--content-type", contentType,
    local ? "--local" : "--remote",
    "--force",
    "--config", resolve(workerDirectory, config),
  ], { cwd: workerDirectory, stdio: "inherit" });
}
