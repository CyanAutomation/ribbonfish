#!/usr/bin/env node
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { migrationLedgerSQL } from "./migration-ledger.js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workerDirectory = resolve(scriptDirectory, "..");
const migrationsDirectory = resolve(workerDirectory, "migrations");
let target = "";
let config = "wrangler.management.toml";
let database = "ribbonfish-devices";

const args = process.argv.slice(2);
while (args.length) {
  const argument = args.shift();
  if (argument === "--local") {
    if (target) throw new Error("Choose --local once");
    target = argument;
  } else if (argument === "--remote") {
    throw new Error("Remote database bootstrap is disabled; use the production migration workflow.");
  } else if (argument === "--config" && args[0]) config = args.shift();
  else if (argument === "--database" && args[0]) database = args.shift();
  else throw new Error("Usage: node scripts/bootstrap-database.mjs --local [--config FILE] [--database NAME]");
}
if (!target) throw new Error("Choose --local explicitly");

const migrations = (await readdir(migrationsDirectory)).filter((name) => name.endsWith(".sql")).sort();
const ledgerSQL = migrationLedgerSQL(migrations);
const schemaPath = resolve(workerDirectory, "schema.sql");
const tempDirectory = await mkdtemp(resolve(tmpdir(), "ribbonfish-d1-bootstrap-"));
const ledgerPath = resolve(tempDirectory, "migration-ledger.sql");
await writeFile(ledgerPath, ledgerSQL, { mode: 0o600 });

function run(commandArgs) {
  const result = spawnSync("npx", commandArgs, { cwd: workerDirectory, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error("Wrangler command failed with status " + result.status);
}

try {
  const common = ["wrangler", "--config", config, "d1", "execute", database, "--local"];
  run([...common, "--file", schemaPath]);
  run([...common, "--file", ledgerPath]);
  console.log("Initialized " + target.slice(2) + " D1 database " + database + " from schema.sql.");
} finally {
  await rm(tempDirectory, { recursive: true, force: true });
}
