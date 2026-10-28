import { markAssetLiveStatement } from "./asset-registry.js";
import { storePngAsset } from "./asset-store.js";

export const ASSET_RECONCILIATION_PAGE_SIZE = 40;
export const LEGACY_ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;
const RECONCILIATION_LEASE_MS = 55_000;
const ASSET_KEY_PATTERN = /^assets\/([a-f0-9]{64})$/;
const MAX_MISSING_REFERENCES_PER_PASS = 3;

const REFERENCE_CTE = `
  SELECT sha256, size, 'playlist' AS kind FROM playlist_assets
  UNION ALL SELECT placeholder_sha256, placeholder_size, 'placeholder' FROM capture_targets
  UNION ALL SELECT current_sha256, current_size, 'current' FROM capture_targets WHERE current_sha256 IS NOT NULL
  UNION ALL SELECT sha256, size, 'history' FROM capture_history`;
const NOT_REFERENCED_SQL = `
  NOT EXISTS (SELECT 1 FROM playlist_assets WHERE sha256 = ?)
  AND NOT EXISTS (SELECT 1 FROM capture_targets WHERE placeholder_sha256 = ? OR current_sha256 = ?)
  AND NOT EXISTS (SELECT 1 FROM capture_history WHERE sha256 = ?)`;

export async function deleteIfUnreferenced(env, sha256, now = Date.now()) {
  return (await deleteUnreferencedAssets(env, [sha256], now)) === 1;
}

export async function deleteUnreferencedAssets(env, sha256s, now = Date.now()) {
  const candidates = [...new Set(sha256s.filter((sha256) => /^[a-f0-9]{64}$/.test(sha256)))];
  if (!candidates.length) return 0;
  let deleted = 0;
  for (let offset = 0; offset < candidates.length; offset += ASSET_RECONCILIATION_PAGE_SIZE) {
    deleted += await deleteUnreferencedAssetPage(
      env,
      candidates.slice(offset, offset + ASSET_RECONCILIATION_PAGE_SIZE),
      now,
    );
  }
  return deleted;
}

async function deleteUnreferencedAssetPage(env, candidates, now) {
  const snapshots = await readAssetSnapshots(env.DB, candidates);
  const statements = [];
  const actions = [];
  for (const sha256 of candidates) {
    const snapshot = snapshots.get(sha256);
    if (hasReferences(snapshot)) continue;
    if (snapshot?.state === "deleting") {
      actions.push({ sha256, alreadyClaimed: true });
      continue;
    }
    if (snapshot?.write_lease_until > now ||
        (snapshot?.state && snapshot.state !== "live" && snapshot.expires_at > now)) continue;
    if (snapshot?.state) {
      statements.push(claimAssetDeletionStatement(env.DB, sha256, now));
      actions.push({ sha256, alreadyClaimed: false });
    } else {
      statements.push(env.DB.prepare(
        `INSERT OR IGNORE INTO managed_assets (sha256, size, state, expires_at, write_lease_until, updated_at)
         SELECT ?, ?, 'deleting', NULL, NULL, ? WHERE ${NOT_REFERENCED_SQL}`,
      ).bind(sha256, snapshot?.referenceSize ?? 1, now, sha256, sha256, sha256, sha256));
      actions.push({ sha256, alreadyClaimed: false });
    }
  }
  const results = statements.length ? await env.DB.batch(statements) : [];
  let statementIndex = 0;
  const claimed = [];
  for (const action of actions) {
    if (action.alreadyClaimed) {
      claimed.push(action.sha256);
      continue;
    }
    if (results[statementIndex++]?.meta?.changes === 1) claimed.push(action.sha256);
  }
  return deleteClaimedAssets(env, claimed, now);
}

export async function reconcileAssets(env, now = Date.now()) {
  const leaseToken = crypto.randomUUID();
  const lease = await env.DB.prepare(
    "UPDATE asset_reconciliation_state SET lease_token = ?, lease_until = ? " +
    "WHERE singleton = 1 AND (lease_until IS NULL OR lease_until <= ?)",
  ).bind(leaseToken, now + RECONCILIATION_LEASE_MS, now).run();
  if (lease.meta?.changes !== 1) {
    const state = await env.DB.prepare("SELECT singleton FROM asset_reconciliation_state WHERE singleton = 1").first();
    if (!state) throw new Error("Asset reconciliation migration has not been applied.");
    return { skipped: true, deleted: 0, repaired: 0, issues: 0 };
  }

  try {
    const state = await env.DB.prepare(
      "SELECT r2_cursor, reference_cursor FROM asset_reconciliation_state WHERE singleton = 1",
    ).first();
    const pageSize = boundedPageSize(env.ASSET_RECONCILIATION_PAGE_SIZE);
    const orphanRecordsClaimed = await claimOrphanedAssetRecords(env.DB, pageSize, now);
    let deleted = await retryClaimedDeletions(env, pageSize, now);
    const listed = await env.ASSETS.list({
      prefix: "assets/",
      limit: pageSize,
      ...(state.r2_cursor ? { cursor: state.r2_cursor } : {}),
    });
    if (listed.truncated && typeof listed.cursor !== "string") {
      throw new Error("R2 returned a truncated asset page without a continuation cursor.");
    }
    const page = listed.objects ?? [];
    const inventory = await inspectObjectPage(env, page, now);
    deleted += inventory.deleted;

    const references = await env.DB.prepare(
      `WITH refs AS (${REFERENCE_CTE})
       SELECT sha256, MAX(size) AS size FROM refs
       WHERE sha256 > ? GROUP BY sha256 ORDER BY sha256 LIMIT ?`,
    ).bind(state.reference_cursor ?? "", pageSize).all();
    const referenceRows = references.results ?? [];
    const referenceResult = await inspectReferencePage(env, referenceRows, now);
    const nextR2Cursor = listed.truncated ? listed.cursor : null;
    const referencesTruncated = referenceResult.hasMore || referenceRows.length === pageSize;
    const nextReferenceCursor = referenceResult.hasMore
      ? referenceResult.lastProcessedSha
      : referencesTruncated ? referenceRows[referenceRows.length - 1].sha256 : null;
    const complete = nextR2Cursor === null && nextReferenceCursor === null;
    await env.DB.prepare(
      "UPDATE asset_reconciliation_state SET r2_cursor = ?, reference_cursor = ?, " +
      "last_completed_at = CASE WHEN ? = 1 THEN ? ELSE last_completed_at END " +
      "WHERE singleton = 1 AND lease_token = ?",
    ).bind(nextR2Cursor, nextReferenceCursor, complete ? 1 : 0, now, leaseToken).run();

    return {
      skipped: false,
      deleted,
      orphan_records_claimed: orphanRecordsClaimed,
      repaired: referenceResult.repaired,
      issues: referenceResult.issues,
      r2_truncated: listed.truncated,
      references_truncated: referencesTruncated,
    };
  } finally {
    await env.DB.prepare(
      "UPDATE asset_reconciliation_state SET lease_token = NULL, lease_until = NULL " +
      "WHERE singleton = 1 AND lease_token = ?",
    ).bind(leaseToken).run();
  }
}

async function claimOrphanedAssetRecords(db, limit, now) {
  const result = await db.prepare(
    `UPDATE managed_assets SET state = 'deleting', expires_at = NULL, write_lease_until = NULL, updated_at = ?
     WHERE sha256 IN (
       SELECT orphan.sha256 FROM managed_assets AS orphan
       WHERE (orphan.state = 'live' OR
           (orphan.state IN ('pending', 'staged') AND orphan.expires_at <= ?))
         AND (orphan.write_lease_until IS NULL OR orphan.write_lease_until <= ?)
         AND NOT EXISTS (SELECT 1 FROM playlist_assets WHERE sha256 = orphan.sha256)
         AND NOT EXISTS (SELECT 1 FROM capture_targets
           WHERE placeholder_sha256 = orphan.sha256 OR current_sha256 = orphan.sha256)
         AND NOT EXISTS (SELECT 1 FROM capture_history WHERE sha256 = orphan.sha256)
       ORDER BY orphan.updated_at, orphan.sha256 LIMIT ?
     )`,
  ).bind(now, now, now, limit).run();
  return result.meta?.changes ?? 0;
}

async function inspectObjectPage(env, objects, now) {
  const invalidKeys = [];
  const validObjects = [];
  for (const object of objects) {
    const match = typeof object.key === "string" ? object.key.match(ASSET_KEY_PATTERN) : null;
    if (match) validObjects.push({ ...object, sha256: match[1] });
    else if (typeof object.key === "string" && object.key.startsWith("assets/")) invalidKeys.push(object.key);
  }

  const snapshots = await readAssetSnapshots(env.DB, validObjects.map((object) => object.sha256));
  const statements = [];
  const statementActions = [];
  const candidateActions = [];
  for (const object of validObjects) {
    const snapshot = snapshots.get(object.sha256);
    if (hasReferences(snapshot)) {
      if (snapshot?.state !== "pending" || snapshot.write_lease_until <= now) {
        statements.push(markAssetLiveStatement(env.DB, object.sha256, snapshot?.referenceSize ?? object.size, now));
        statementActions.push({ type: "live", sha256: object.sha256 });
      }
      continue;
    }
    if (snapshot?.state === "deleting") {
      candidateActions.push({ type: "already_claimed", sha256: object.sha256, key: object.key });
      continue;
    }
    if (snapshot && snapshot.write_lease_until > now) {
      continue;
    }
    if (snapshot && snapshot.state !== "live" && snapshot.expires_at > now) {
      continue;
    }

    const uploadedAt = timestamp(object.uploaded);
    const orphanDeadline = uploadedAt === null ? now + LEGACY_ORPHAN_GRACE_MS : uploadedAt + LEGACY_ORPHAN_GRACE_MS;
    if (!snapshot?.state && orphanDeadline > now) {
      statements.push(env.DB.prepare(
        `INSERT OR IGNORE INTO managed_assets (sha256, size, state, expires_at, write_lease_until, updated_at)
         SELECT ?, ?, 'staged', ?, NULL, ?
         WHERE ${NOT_REFERENCED_SQL}`,
      ).bind(object.sha256, object.size, orphanDeadline, now,
        object.sha256, object.sha256, object.sha256, object.sha256));
      statementActions.push({ type: "stage", sha256: object.sha256 });
      continue;
    }
    if (snapshot?.state) {
      statements.push(claimAssetDeletionStatement(env.DB, object.sha256, now));
      statementActions.push({ type: "claim", sha256: object.sha256, key: object.key });
    } else {
      statements.push(env.DB.prepare(
        `INSERT OR IGNORE INTO managed_assets (sha256, size, state, expires_at, write_lease_until, updated_at)
         SELECT ?, ?, 'deleting', NULL, NULL, ?
         WHERE ${NOT_REFERENCED_SQL}`,
      ).bind(object.sha256, object.size, now, object.sha256, object.sha256, object.sha256, object.sha256));
      statementActions.push({ type: "claim", sha256: object.sha256, key: object.key });
    }
  }

  const results = statements.length ? await env.DB.batch(statements) : [];
  const claimed = candidateActions.filter((action) => action.type === "already_claimed");
  for (const [index, action] of statementActions.entries()) {
    if (action.type !== "claim") continue;
    if (results[index]?.meta?.changes === 1) {
      claimed.push(action);
    }
  }

  let deleted = 0;
  if (claimed.length) deleted += await deleteClaimedAssets(env, claimed.map((item) => item.sha256), now);
  if (invalidKeys.length) {
    try {
      await env.ASSETS.delete(invalidKeys);
      deleted += invalidKeys.length;
    } catch (error) {
      console.warn("asset_reconciliation_invalid_key_delete_failed", { count: invalidKeys.length, error: safeMessage(error) });
    }
  }
  return { deleted };
}

async function readAssetSnapshots(db, sha256s) {
  const snapshots = new Map();
  if (!sha256s.length) return snapshots;
  if (sha256s.length > ASSET_RECONCILIATION_PAGE_SIZE) {
    throw new Error(`Asset reference pages cannot exceed ${ASSET_RECONCILIATION_PAGE_SIZE} digests.`);
  }
  const values = sha256s.map(() => "(?)").join(", ");
  const result = await db.prepare(
    `WITH wanted(sha256) AS (VALUES ${values}),
     refs AS (
       SELECT pa.sha256, pa.size, 'playlist' AS kind FROM playlist_assets pa JOIN wanted w ON w.sha256 = pa.sha256
       UNION ALL SELECT t.placeholder_sha256, t.placeholder_size, 'placeholder' FROM capture_targets t JOIN wanted w ON w.sha256 = t.placeholder_sha256
       UNION ALL SELECT t.current_sha256, t.current_size, 'current' FROM capture_targets t JOIN wanted w ON w.sha256 = t.current_sha256
       UNION ALL SELECT h.sha256, h.size, 'history' FROM capture_history h JOIN wanted w ON w.sha256 = h.sha256
     )
     SELECT w.sha256, ma.state, ma.expires_at, ma.write_lease_until, r.kind, r.size
     FROM wanted w LEFT JOIN managed_assets ma ON ma.sha256 = w.sha256
     LEFT JOIN refs r ON r.sha256 = w.sha256 ORDER BY w.sha256`,
  ).bind(...sha256s).all();
  for (const row of result.results ?? []) {
    let snapshot = snapshots.get(row.sha256);
    if (!snapshot) {
      snapshot = {
        state: row.state,
        expires_at: row.expires_at,
        write_lease_until: row.write_lease_until,
        referenceSize: null,
        has_playlist: false,
        has_placeholder: false,
        has_current: false,
        has_history: false,
      };
      snapshots.set(row.sha256, snapshot);
    }
    if (row.kind) {
      snapshot[`has_${row.kind}`] = true;
      snapshot.referenceSize = Math.max(snapshot.referenceSize ?? 0, row.size ?? 0);
    }
  }
  return snapshots;
}

async function inspectReferencePage(env, references, now) {
  const checked = await mapWithConcurrency(references, 10, async (reference) => ({
    reference,
    object: await env.ASSETS.head(`assets/${reference.sha256}`),
  }));
  let repaired = 0;
  let issues = 0;
  const presentDigests = [];
  let missingCount = 0;
  let lastProcessedSha = null;
  let hasMore = false;
  for (const { reference, object } of checked) {
    if (!object && missingCount >= MAX_MISSING_REFERENCES_PER_PASS) {
      hasMore = true;
      break;
    }
    lastProcessedSha = reference.sha256;
    if (object) {
      presentDigests.push(reference.sha256);
      continue;
    }
    missingCount += 1;
    const result = await reconcileMissingReference(env, reference.sha256, reference.size, now);
    repaired += result.repaired;
    issues += result.issues;
  }
  if (presentDigests.length) {
    const placeholders = presentDigests.map(() => "?").join(", ");
    await env.DB.prepare(
      `UPDATE asset_integrity_issues SET resolved_at = ? WHERE resolved_at IS NULL AND sha256 IN (${placeholders})`,
    ).bind(now, ...presentDigests).run();
  }
  return { repaired, issues, hasMore, lastProcessedSha };
}

async function reconcileMissingReference(env, sha256, size, now) {
  const assetState = await env.DB.prepare(
    "SELECT write_lease_until FROM managed_assets WHERE sha256 = ?",
  ).bind(sha256).first();
  if (assetState?.write_lease_until > now) return { repaired: 0, issues: 0 };
  const refs = await env.DB.prepare(
    `SELECT
       EXISTS (SELECT 1 FROM playlist_assets WHERE sha256 = ?) AS has_playlist,
       EXISTS (SELECT 1 FROM capture_targets WHERE placeholder_sha256 = ?) AS has_placeholder,
       EXISTS (SELECT 1 FROM capture_targets WHERE current_sha256 = ?) AS has_current,
       EXISTS (SELECT 1 FROM capture_history WHERE sha256 = ?) AS has_history`,
  ).bind(sha256, sha256, sha256, sha256).first();
  if (!refs || !(refs.has_playlist || refs.has_placeholder || refs.has_current || refs.has_history)) {
    await env.DB.prepare(
      "DELETE FROM managed_assets WHERE sha256 = ? AND state IN ('live', 'staged') " +
      "AND (write_lease_until IS NULL OR write_lease_until <= ?) " +
      `AND ${NOT_REFERENCED_SQL}`,
    ).bind(sha256, now, sha256, sha256, sha256, sha256).run();
    return { repaired: 0, issues: 0 };
  }

  let repaired = 0;
  const captureCleanup = [];
  if (refs.has_current) {
    captureCleanup.push(env.DB.prepare(
      "UPDATE capture_targets SET current_sha256 = NULL, current_size = NULL WHERE current_sha256 = ? " +
      "AND NOT EXISTS (SELECT 1 FROM managed_assets WHERE sha256 = ? AND write_lease_until > ?)",
    ).bind(sha256, sha256, now));
  }
  if (refs.has_history) {
    captureCleanup.push(env.DB.prepare(
      "DELETE FROM capture_history WHERE sha256 = ? " +
      "AND NOT EXISTS (SELECT 1 FROM managed_assets WHERE sha256 = ? AND write_lease_until > ?)",
    ).bind(sha256, sha256, now));
  }
  const captureChanges = captureCleanup.length ? await env.DB.batch(captureCleanup) : [];
  const currentCleared = refs.has_current && captureChanges[0]?.meta?.changes > 0;
  const historyRemoved = refs.has_history && captureChanges[refs.has_current ? 1 : 0]?.meta?.changes > 0;
  if (refs.has_placeholder) {
    const restored = await restorePlaceholder(env, sha256, size, now);
    if (restored) {
      repaired += 1;
      await resolveIssue(env.DB, sha256, "missing_placeholder_asset", now);
    } else {
      await recordIssue(env.DB, sha256, "missing_placeholder_asset", now);
      console.warn("asset_integrity_issue", { issue_type: "missing_placeholder_asset", sha256 });
    }
  } else {
    await resolveIssue(env.DB, sha256, "missing_placeholder_asset", now);
  }
  if (refs.has_playlist) {
    await recordIssue(env.DB, sha256, "missing_playlist_asset", now);
    console.warn("asset_integrity_issue", { issue_type: "missing_playlist_asset", sha256 });
  } else {
    await resolveIssue(env.DB, sha256, "missing_playlist_asset", now);
  }
  if (currentCleared || historyRemoved) {
    console.warn("asset_reconciliation_removed_missing_capture_references", {
      sha256,
      current_cleared: currentCleared,
      history_removed: historyRemoved,
    });
  }
  if (!refs.has_playlist && !(refs.has_placeholder && !repaired)) {
    await env.DB.prepare(
      "DELETE FROM managed_assets WHERE sha256 = ? AND state IN ('live', 'staged') " +
      "AND (write_lease_until IS NULL OR write_lease_until <= ?) " +
      `AND ${NOT_REFERENCED_SQL}`,
    ).bind(sha256, now, sha256, sha256, sha256, sha256).run();
  }
  return { repaired, issues: Number(Boolean(refs.has_playlist)) + Number(Boolean(refs.has_placeholder && !repaired)) };
}

async function restorePlaceholder(env, expectedSha256, expectedSize, now) {
  const source = await env.ASSETS.get("admin/capture-pending.png");
  if (!source) return false;
  const bytes = new Uint8Array(await source.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const sha256 = [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
  if (sha256 !== expectedSha256 || bytes.byteLength !== expectedSize) return false;
  await storePngAsset(bytes, env.ASSETS, { db: env.DB, now });
  return true;
}

async function recordIssue(db, sha256, issueType, now) {
  await db.prepare(
    `INSERT INTO asset_integrity_issues (sha256, issue_type, first_seen_at, last_seen_at, resolved_at)
     VALUES (?, ?, ?, ?, NULL)
     ON CONFLICT(sha256, issue_type) DO UPDATE SET last_seen_at = excluded.last_seen_at, resolved_at = NULL`,
  ).bind(sha256, issueType, now, now).run();
}

async function resolveIssue(db, sha256, issueType, now) {
  await db.prepare(
    "UPDATE asset_integrity_issues SET resolved_at = ? WHERE sha256 = ? AND issue_type = ? AND resolved_at IS NULL",
  ).bind(now, sha256, issueType).run();
}

function hasReferences(snapshot) {
  return Boolean(snapshot?.has_playlist || snapshot?.has_placeholder || snapshot?.has_current || snapshot?.has_history);
}

async function retryClaimedDeletions(env, limit, now) {
  const rows = await env.DB.prepare(
    "SELECT sha256 FROM managed_assets WHERE state = 'deleting' ORDER BY updated_at, sha256 LIMIT ?",
  ).bind(limit).all();
  return deleteClaimedAssets(env, (rows.results ?? []).map((row) => row.sha256), now);
}

async function deleteClaimedAssets(env, sha256s, now) {
  if (!sha256s.length) return 0;
  const snapshots = await readAssetSnapshots(env.DB, sha256s);
  const referenced = sha256s.filter((sha256) => hasReferences(snapshots.get(sha256)));
  if (referenced.length) {
    await env.DB.batch(referenced.map((sha256) => env.DB.prepare(
      "UPDATE managed_assets SET state = 'live', expires_at = NULL, write_lease_until = NULL, updated_at = ? " +
      "WHERE sha256 = ? AND state = 'deleting'",
    ).bind(now, sha256)));
  }
  const deletable = sha256s.filter((sha256) => !referenced.includes(sha256));
  if (!deletable.length) return 0;
  try {
    await env.ASSETS.delete(deletable.map((sha256) => `assets/${sha256}`));
  } catch (error) {
    console.warn("asset_reconciliation_delete_failed", { count: deletable.length, error: safeMessage(error) });
    return 0;
  }
  await env.DB.batch(deletable.map((sha256) => env.DB.prepare(
    `DELETE FROM managed_assets WHERE sha256 = ? AND state = 'deleting'
     AND ${NOT_REFERENCED_SQL}`,
  ).bind(sha256, sha256, sha256, sha256, sha256)));
  return deletable.length;
}

function claimAssetDeletionStatement(db, sha256, now) {
  return db.prepare(
    `UPDATE managed_assets SET state = 'deleting', expires_at = NULL, write_lease_until = NULL, updated_at = ?
     WHERE sha256 = ? AND state != 'deleting'
       AND (write_lease_until IS NULL OR write_lease_until <= ?)
       AND (state = 'live' OR expires_at <= ?)
       AND ${NOT_REFERENCED_SQL}`,
  ).bind(now, sha256, now, now, sha256, sha256, sha256, sha256);
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function boundedPageSize(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return ASSET_RECONCILIATION_PAGE_SIZE;
  return Math.min(ASSET_RECONCILIATION_PAGE_SIZE, parsed);
}

function timestamp(value) {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function safeMessage(error) {
  return typeof error?.message === "string" ? error.message.slice(0, 120) : "unknown error";
}
