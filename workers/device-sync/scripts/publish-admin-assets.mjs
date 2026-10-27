import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workerDirectory = resolve(scriptDirectory, "..");
const args = process.argv.slice(2);
const configArgumentIndex = args.indexOf("--config");
const config = configArgumentIndex < 0 ? "wrangler.dev.toml" : args[configArgumentIndex + 1];
const local = args.includes("--local");

if (!config || config.startsWith("--") || args.some((arg) => arg !== "--local" && arg !== "--config" && arg !== config)) {
  throw new Error("usage: publish-admin-assets.mjs [--config wrangler.dev.toml] [--local]");
}

const files = [
  ["index.html", "text/html; charset=utf-8"],
  ["app.js", "text/javascript; charset=utf-8"],
  ["styles.css", "text/css; charset=utf-8"],
];

for (const [file, contentType] of files) {
  execFileSync("npx", [
    "wrangler", "r2", "object", "put", `ribbonfish-management-dev/admin/${file}`,
    "--file", resolve(workerDirectory, "public/admin", file),
    "--content-type", contentType,
    local ? "--local" : "--remote",
    "--force",
    "--config", resolve(workerDirectory, config),
  ], { cwd: workerDirectory, stdio: "inherit" });
}
