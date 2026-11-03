import { hasExactKeys } from "./validation.ts";
import { isSupportedRotationInterval } from "./intervals.ts";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const MAX_ASSET_BYTES = 32 << 20;

/** Validate data read from storage before serving it to devices. */
export function validatePlaylist(playlist: unknown): void {
  if (!hasExactKeys(playlist, ["version", "revision", "id", "rotation_interval", "assets"]) ||
      playlist.version !== 2 || !ID_PATTERN.test(String(playlist.revision ?? "")) ||
      !ID_PATTERN.test(String(playlist.id ?? "")) || !isSupportedRotationInterval(playlist.rotation_interval) ||
      !Array.isArray(playlist.assets) || playlist.assets.length < 1 || playlist.assets.length > 256) {
    throw new Error("invalid playlist envelope");
  }
  for (const asset of playlist.assets) {
    if (!hasExactKeys(asset, ["sha256", "size"]) || !DIGEST_PATTERN.test(String(asset.sha256 ?? "")) ||
        typeof asset.size !== "number" || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > MAX_ASSET_BYTES) {
      throw new Error("invalid asset reference");
    }
  }
}
