import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workerDirectory = resolve(scriptDirectory, "..");
const args = process.argv.slice(2);
let config = "wrangler.management.toml";
let bucket = "ribbonfish-assets";
let local = true;
let modeOptionSeen = false;
const seenOptions = new Set();

for (let index = 0; index < args.length; index += 1) {
  const option = args[index];
  if (option === "--local" || option === "--remote") {
    if (modeOptionSeen) throw new Error("choose either --local or --remote, once");
    modeOptionSeen = true;
    local = option === "--local";
    continue;
  }
  if (option === "--config" || option === "--bucket") {
    if (seenOptions.has(option)) throw new Error(`${option} may only be specified once`);
    seenOptions.add(option);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error("usage: publish-admin-assets.mjs [--config wrangler.management.toml] [--bucket bucket-name] [--local|--remote]");
    }
    if (option === "--config") config = value;
    else bucket = value;
    index += 1;
    continue;
  }
  throw new Error("usage: publish-admin-assets.mjs [--config wrangler.management.toml] [--bucket bucket-name] [--local|--remote]");
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
  ["capture-pending.png", "image/png"],
];

for (const [file, contentType] of files) {
  const source = file === "capture-pending.png"
    ? resolve(workerDirectory, "public/admin", file)
    : resolve(buildDirectory, file);
  execFileSync("npx", [
    "wrangler", "r2", "object", "put", `${bucket}/admin/${file}`,
    "--file", source,
    "--content-type", contentType,
    local ? "--local" : "--remote",
    "--force",
    "--config", resolve(workerDirectory, config),
  ], { cwd: workerDirectory, stdio: "inherit" });
}
