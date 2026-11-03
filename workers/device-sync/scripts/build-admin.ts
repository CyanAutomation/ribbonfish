import { copyFile, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workerDirectory = resolve(scriptDirectory, "..");
const sourceDirectory = resolve(workerDirectory, "public/admin");
const outputDirectory = resolve(workerDirectory, ".admin-build");

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await Promise.all(["index.html", "styles.css"].map((file) =>
  copyFile(resolve(sourceDirectory, file), resolve(outputDirectory, file))));

await build({
  entryPoints: [resolve(sourceDirectory, "app.js")],
  outfile: resolve(outputDirectory, "app.js"),
  bundle: true,
  minify: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  legalComments: "none",
});
