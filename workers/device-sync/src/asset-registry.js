export const ASSET_WRITE_LEASE_MS = 60 * 60 * 1000;
export const ASSET_STAGING_MS = 7 * 24 * 60 * 60 * 1000;

const HAS_ASSET_REFERENCE_SQL = `
  SELECT 1 AS present FROM playlist_assets WHERE sha256 = ?
  UNION ALL SELECT 1 AS present FROM capture_targets WHERE placeholder_sha256 = ? OR current_sha256 = ?
  UNION ALL SELECT 1 AS present FROM capture_history WHERE sha256 = ?
  LIMIT 1`;

export class AssetDeletionInProgressError extends Error {
  constructor() {
    super("Asset cleanup is in progress; retry the upload shortly.");
    this.name = "AssetDeletionInProgressError";
  }
}

export async function hasAssetReference(db, sha256) {
  return Boolean(await db.prepare(HAS_ASSET_REFERENCE_SQL).bind(sha256, sha256, sha256, sha256).first());
}

export async function beginAssetWrite(db, sha256, size, now) {
  await db.prepare(
    `INSERT INTO managed_assets (sha256, size, state, expires_at, write_lease_until, updated_at)
     VALUES (?, ?, 'pending', ?, ?, ?)
     ON CONFLICT(sha256) DO UPDATE SET
       size = excluded.size,
       state = CASE WHEN managed_assets.state = 'deleting' THEN 'deleting' ELSE 'pending' END,
       expires_at = CASE WHEN managed_assets.state = 'deleting' THEN NULL ELSE excluded.expires_at END,
       write_lease_until = CASE WHEN managed_assets.state = 'deleting' THEN NULL ELSE excluded.write_lease_until END,
       updated_at = excluded.updated_at`,
  ).bind(sha256, size, now + ASSET_WRITE_LEASE_MS, now + ASSET_WRITE_LEASE_MS, now).run();
  const row = await db.prepare("SELECT state FROM managed_assets WHERE sha256 = ?").bind(sha256).first();
  if (row?.state === "deleting") throw new AssetDeletionInProgressError();
}

export async function finishAssetWrite(db, sha256, size, now, stagingMs = ASSET_STAGING_MS) {
  const referenced = await hasAssetReference(db, sha256);
  const result = await db.prepare(
    `UPDATE managed_assets SET size = ?, state = ?, expires_at = ?, write_lease_until = NULL, updated_at = ?
     WHERE sha256 = ? AND state IN ('pending', 'staged', 'live')`,
  ).bind(size, referenced ? "live" : "staged", referenced ? null : now + stagingMs, now, sha256).run();
  if (result.meta?.changes !== 1) throw new AssetDeletionInProgressError();
}

export function markAssetLiveStatement(db, sha256, size, now) {
  return db.prepare(
    `INSERT INTO managed_assets (sha256, size, state, expires_at, updated_at)
     VALUES (?, ?, 'live', NULL, ?)
     ON CONFLICT(sha256) DO UPDATE SET
       size = excluded.size, state = 'live', expires_at = NULL, write_lease_until = NULL,
       updated_at = excluded.updated_at
     WHERE managed_assets.state != 'deleting'`,
  ).bind(sha256, size, now);
}
