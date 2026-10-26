#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { isValidPositiveDuration } from "../src/duration.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_ASSET_BYTES = 32 * 1024 * 1024;

function usage() {
  console.error("Usage: node scripts/publish-playlist.mjs <playlist.json> [--activate] [--database NAME] [--bucket NAME]");
  process.exit(2);
}

const args = process.argv.slice(2);
const filename = args.shift();
if (!filename) usage();
let activate = false;
let database = "ribbonfish-devices";
let bucket = "ribbonfish-assets";
while (args.length) {
  const flag = args.shift();
  if (flag === "--activate") activate = true;
  else if (flag === "--database" && args[0]) database = args.shift();
  else if (flag === "--bucket" && args[0]) bucket = args.shift();
  else usage();
}

const sourcePath = resolve(filename);
const input = JSON.parse(await readFile(sourcePath, "utf8"));
if (!input || !ID_PATTERN.test(input.id ?? "") ||
    !isValidPositiveDuration(input.rotation_interval) || !Array.isArray(input.assets) ||
    input.assets.length < 1 || input.assets.length > 256) {
  throw new Error("playlist must have a valid id, positive rotation_interval, and 1-256 assets");
}

const assets = [];
for (const [position, source] of input.assets.entries()) {
  if (!source || typeof source.path !== "string" || source.path.trim() === "") {
    throw new Error(`assets[${position}].path is required`);
  }
  const assetPath = resolve(dirname(sourcePath), source.path);
  const bytes = await readFile(assetPath);
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_ASSET_BYTES) {
    throw new Error(`asset ${source.path} must be 1 byte to 32 MiB`);
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (source.sha256 && source.sha256 !== sha256) throw new Error(`asset digest mismatch: ${source.path}`);
  if (source.size !== undefined && source.size !== bytes.byteLength) throw new Error(`asset size mismatch: ${source.path}`);
  assets.push({ path: assetPath, sha256, size: bytes.byteLength });
}

const revision = `r-${randomUUID().replaceAll("-", "")}`;
const sqlString = (value) => `'${String(value).replaceAll("'", "''")}'`;
const temporaryDirectory = await mkdtemp(resolve(tmpdir(), "ribbonfish-playlist-"));
const run = (command, commandArgs) => {
  const result = spawnSync(command, commandArgs, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
};

try {
  for (const asset of assets) {
    run("npx", ["wrangler", "r2", "object", "put", `${bucket}/assets/${asset.sha256}`, "--file", asset.path]);
  }

  const playlistStatements = [
    `INSERT INTO playlists (playlist_id, revision, rotation_interval, created_at) VALUES (${sqlString(input.id)}, ${sqlString(revision)}, ${sqlString(input.rotation_interval)}, ${Date.now()});`,
    ...assets.map((asset, position) =>
      `INSERT INTO playlist_assets (playlist_id, revision, position, sha256, size) VALUES (${sqlString(input.id)}, ${sqlString(revision)}, ${position}, ${sqlString(asset.sha256)}, ${asset.size});`),
  ];
  const playlistSQL = resolve(temporaryDirectory, "playlist.sql");
  await writeFile(playlistSQL, `${playlistStatements.join("\n")}\n`, { mode: 0o600 });
  run("npx", ["wrangler", "d1", "execute", database, "--remote", "--file", playlistSQL]);

  if (activate) {
    const activeSQL = resolve(temporaryDirectory, "activate.sql");
    const activation = `INSERT INTO active_playlist (singleton, playlist_id, revision) VALUES (1, ${sqlString(input.id)}, ${sqlString(revision)}) ON CONFLICT(singleton) DO UPDATE SET playlist_id = excluded.playlist_id, revision = excluded.revision;\n`;
    await writeFile(activeSQL, activation, { mode: 0o600 });
    run("npx", ["wrangler", "d1", "execute", database, "--remote", "--file", activeSQL]);
  }

  console.log(`Published playlist ${input.id} revision ${revision}${activate ? " and activated it" : ""}.`);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
