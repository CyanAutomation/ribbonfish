import { sha256Hex } from "./crypto-primitives.ts";
import type { WorkerEnvironment } from "./worker-contracts.ts";

export interface PlaylistRevisionAsset {
  position: number;
  sha256: string;
  size: number;
  captured_at?: number | null;
}

export interface PlaylistContent {
  assets: PlaylistRevisionAsset[];
  effective_revision: string;
  has_captures: boolean;
}

/** Resolve the canonical agent revision; capture timestamps are part of its identity for all API versions. */
async function resolvePlaylistRevision(
  storedRevision: string,
  assets: PlaylistRevisionAsset[],
  hasCaptures: boolean,
): Promise<string> {
  if (!hasCaptures) return storedRevision;
  const orderedAssets = [...assets].sort((left, right) => left.position - right.position);
  const content = `${storedRevision}\n${orderedAssets.map(({ sha256, size, captured_at }) =>
    `${sha256}:${size}:${Number.isSafeInteger(captured_at) && Number(captured_at) > 0 ? captured_at : ""}`).join("\n")}`;
  return (await sha256Hex(content)).slice(0, 64);
}

/** Read the content and canonical revision that playlist delivery would serve. */
export async function readPlaylistContent(
  env: WorkerEnvironment,
  playlistID: string,
  storedRevision: string,
  now = Date.now(),
): Promise<PlaylistContent> {
  const captureCutoff = now - 30 * 24 * 60 * 60 * 1000;
  const [assetResult, captureResult] = await Promise.all([
    env.DB.prepare(
      "SELECT position, sha256, size FROM playlist_assets WHERE playlist_id = ? AND revision = ? ORDER BY position",
    ).bind(playlistID, storedRevision).all<PlaylistRevisionAsset>(),
    env.DB.prepare(
      "SELECT p.position, " +
      "CASE WHEN t.current_sha256 IS NOT NULL AND t.last_success_at >= ? THEN t.current_sha256 ELSE t.placeholder_sha256 END AS sha256, " +
      "CASE WHEN t.current_size IS NOT NULL AND t.last_success_at >= ? THEN t.current_size ELSE t.placeholder_size END AS size, " +
      "CASE WHEN t.capture_type = 'browser-screenshot' AND t.current_sha256 IS NOT NULL AND t.last_success_at >= ? THEN t.last_success_at ELSE NULL END AS captured_at " +
      "FROM playlist_capture_items p JOIN capture_targets t ON t.capture_id = p.capture_id " +
      "WHERE p.playlist_id = ? AND p.revision = ? ORDER BY p.position",
    ).bind(captureCutoff, captureCutoff, captureCutoff, playlistID, storedRevision).all<PlaylistRevisionAsset>(),
  ]);

  const capturedAssets = (captureResult.results ?? []).map((asset) => {
    const capturedAt = Number.isSafeInteger(asset.captured_at) && Number(asset.captured_at) > 0
      ? Number(asset.captured_at)
      : undefined;
    return {
      position: asset.position,
      sha256: asset.sha256,
      size: asset.size,
      ...(capturedAt === undefined ? {} : { captured_at: capturedAt }),
    };
  });
  const assets = [
    ...(assetResult.results ?? []).map((asset, index) => ({
      position: Number.isSafeInteger(asset.position) ? asset.position : index,
      sha256: asset.sha256,
      size: asset.size,
    })),
    ...capturedAssets,
  ].sort((left, right) => left.position - right.position);
  const hasCaptures = capturedAssets.length > 0 || (captureResult.results?.length ?? 0) > 0;

  return {
    assets,
    effective_revision: await resolvePlaylistRevision(storedRevision, assets, hasCaptures),
    has_captures: hasCaptures,
  };
}
