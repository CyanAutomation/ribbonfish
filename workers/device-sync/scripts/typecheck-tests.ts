import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const directory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsc = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin/tsc");

function copyTests(source: string, destination: string, root = source): void {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const path = join(source, entry.name);
    if (entry.isDirectory()) copyTests(path, destination, root);
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      const contents = readFileSync(path, "utf8");
      if (!contents.startsWith("// @typecheck-node-test")) continue;
      const target = join(destination, relative(root, path));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, contents);
    }
  }
}

// Compile Worker declarations separately so test globals come only from Node.
// Node-only tests opt into this checker with @typecheck-node-test. Browser
// tests use a separate DOM type environment; all tests run under `node --test`.
export function checkNodeTests(source = join(directory, "src")): { status: number; output: string } {
  const temporary = mkdtempSync(join(directory, ".node-test-types-"));
  try {
    const emit = spawnSync(process.execPath, [tsc, "-p", join(directory, "tsconfig.worker.json"),
      "--rootDir", join(directory, "src"), "--noEmit", "false", "--declaration", "--emitDeclarationOnly",
      "--outDir", temporary], { encoding: "utf8" });
    if (emit.error) throw emit.error;
    if (emit.status !== 0) return { status: emit.status ?? 1, output: emit.stdout + emit.stderr };
    copyTests(source, temporary);
    writeFileSync(join(temporary, "tsconfig.json"), JSON.stringify({
      extends: join(directory, "tsconfig.tests.json"),
      include: ["**/*.test.ts"],
    }));
    const check = spawnSync(process.execPath, [tsc, "-p", join(temporary, "tsconfig.json"), "--pretty", "false"], { encoding: "utf8" });
    if (check.error) throw check.error;
    return { status: check.status ?? 1, output: check.stdout + check.stderr };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = checkNodeTests();
  if (result.output) process.stderr.write(result.output);
  process.exitCode = result.status;
}
