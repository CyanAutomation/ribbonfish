import { jsonResponse } from "./http-response.ts";
import { verifyDeviceSignature, decodeBase64Url, encodeBase64Url } from "./device-signature.ts";
import { readRequestBody, parseJSONBody } from "./request-body.ts";
import { randomToken, sha256Hex, sha256HexBytes } from "./crypto-primitives.ts";
import { HTTPError } from "./http-error.ts";
import { hasExactKeys, isString } from "./validation.ts";
import { DEVICE_ID_PATTERN } from "./device-id.ts";
import type { DeviceCredentialRow, EnrollmentRequestRow, EnrollmentRow, WorkerEnvironment } from "./worker-contracts.ts";

const MAX_ENROLLMENT_BYTES = 4 << 10;
const ENROLLMENT_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export async function enroll(request: Request, env: WorkerEnvironment) {
  const data = await readJSON(request, MAX_ENROLLMENT_BYTES);
  if (!hasExactKeys(data, ["device_id", "enrollment_code"]) ||
      !isString(data.device_id) || !DEVICE_ID_PATTERN.test(data.device_id) || !isString(data.enrollment_code) ||
      data.enrollment_code.length < 8 || data.enrollment_code.length > 512) {
    throw new HTTPError(400, "invalid enrollment request");
  }

  const now = Date.now();
  const codeHash = await sha256Hex(data.enrollment_code);
  const enrollment = await env.DB.prepare(
    "SELECT code_hash, expires_at, consumed_at FROM enrollments WHERE code_hash = ?",
  ).bind(codeHash).first<EnrollmentRow>();
  if (!enrollment || enrollment.consumed_at !== null || enrollment.expires_at <= now) {
    throw new HTTPError(401, "enrollment code is invalid or expired");
  }
  const existing = await env.DB.prepare(
    "SELECT device_id FROM devices WHERE device_id = ?",
  ).bind(data.device_id).first<{ device_id: string }>();
  if (existing) throw new HTTPError(409, "device is already enrolled");

  const token = randomToken();
  const claimID = randomToken();
  const tokenHash = await sha256Hex(token);
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE enrollments SET consumed_at = ?, claim_id = ?
       WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?
         AND NOT EXISTS (SELECT 1 FROM devices WHERE device_id = ?)`,
    ).bind(now, claimID, codeHash, now, data.device_id),
    env.DB.prepare(
      `INSERT INTO devices (device_id, token_hash, enabled, created_at)
       SELECT ?, ?, 1, ?
       WHERE EXISTS (
         SELECT 1 FROM enrollments WHERE code_hash = ? AND consumed_at = ? AND claim_id = ?
       ) AND NOT EXISTS (SELECT 1 FROM devices WHERE device_id = ?)`,
    ).bind(data.device_id, tokenHash, now, codeHash, now, claimID, data.device_id),
  ]);
  if (results[0]?.meta?.changes !== 1 || results[1]?.meta?.changes !== 1) {
    const existingAfterClaim = await env.DB.prepare(
      "SELECT device_id FROM devices WHERE device_id = ?",
    ).bind(data.device_id).first<{ device_id: string }>();
    if (existingAfterClaim) throw new HTTPError(409, "device is already enrolled");
    throw new HTTPError(401, "enrollment code is invalid or expired");
  }
  return jsonResponse({ device_token: token }, 201);
}

export async function requestDeviceEnrollment(request: Request, env: WorkerEnvironment) {
  const rateLimiter = env.ENROLLMENT_RATE_LIMITER;
  if (rateLimiter) {
    const ipAddress = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const { success } = await rateLimiter.limit({ key: ipAddress });
    if (!success) throw new HTTPError(429, "too many enrollment requests; retry later");
  }

  const { data, bodyBytes } = await readJSONBody(request, MAX_ENROLLMENT_BYTES);
  if (!hasExactKeys(data, ["device_id", "public_key"]) ||
      !isString(data.device_id) || !DEVICE_ID_PATTERN.test(data.device_id) ||
      !isString(data.public_key) || !PUBLIC_KEY_PATTERN.test(data.public_key)) {
    throw new HTTPError(400, "invalid enrollment request");
  }
  const publicKeyBytes = decodeBase64Url(data.public_key);
  if (publicKeyBytes.byteLength !== 32 || encodeBase64Url(publicKeyBytes) !== data.public_key) {
    throw new HTTPError(400, "invalid enrollment public key");
  }
  if (!await verifyDeviceSignature(request, data.device_id, data.public_key, bodyBytes)) {
    throw new HTTPError(401, "device enrollment proof failed");
  }

  const requestID = await sha256HexBytes(publicKeyBytes);
  const fingerprint = formatFingerprint(requestID);
  const now = Date.now();
  const existingDevice = await env.DB.prepare(
    "SELECT device_id, public_key, enabled FROM devices WHERE device_id = ?",
  ).bind(data.device_id).first<Pick<DeviceCredentialRow, "device_id" | "public_key" | "enabled">>();
  if (existingDevice?.public_key === data.public_key) {
    return jsonResponse({
      status: existingDevice.enabled === 1 ? "approved" : "disabled",
      fingerprint,
      request_id: requestID,
      expires_at: null,
      replaces_existing: false,
    });
  }

  await env.DB.prepare("DELETE FROM enrollment_requests WHERE expires_at <= ?").bind(now).run();
  const existingRequest = await env.DB.prepare(
    "SELECT request_id, device_id, public_key, fingerprint, created_at, last_seen_at, expires_at, status " +
    "FROM enrollment_requests WHERE request_id = ?",
  ).bind(requestID).first<EnrollmentRequestRow>();
  if (existingRequest && (existingRequest.device_id !== data.device_id || existingRequest.public_key !== data.public_key)) {
    throw new HTTPError(409, "enrollment request identity conflict");
  }

  await env.DB.prepare(
    `INSERT INTO enrollment_requests
       (request_id, device_id, public_key, fingerprint, created_at, last_seen_at, expires_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')
     ON CONFLICT(request_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
     WHERE enrollment_requests.status = 'pending'
       AND enrollment_requests.device_id = excluded.device_id
       AND enrollment_requests.public_key = excluded.public_key`,
  ).bind(requestID, data.device_id, data.public_key, fingerprint, now, now, now + ENROLLMENT_REQUEST_TTL_MS).run();

  const current = await env.DB.prepare(
    "SELECT request_id, device_id, public_key, fingerprint, created_at, last_seen_at, expires_at, status " +
    "FROM enrollment_requests WHERE request_id = ?",
  ).bind(requestID).first<EnrollmentRequestRow>();
  if (!current || current.device_id !== data.device_id || current.public_key !== data.public_key) {
    throw new HTTPError(409, "enrollment request is no longer active");
  }
  if (current.status === "approved") {
    throw new HTTPError(409, "enrollment request was superseded by another device credential");
  }
  return jsonResponse({
    status: current.status,
    fingerprint,
    request_id: requestID,
    expires_at: current.expires_at,
    replaces_existing: Boolean(existingDevice),
  });
}

async function readJSON(request: Request, maxBytes: number): Promise<unknown> {
  return (await readJSONBody(request, maxBytes)).data;
}

async function readJSONBody(request: Request, maxBytes: number): Promise<{ data: unknown; bodyBytes: Uint8Array }> {
  const bodyBytes = await readRequestBody(request, maxBytes);
  return { data: parseJSONBody(bodyBytes), bodyBytes };
}

function formatFingerprint(requestID: string) {
  return requestID.slice(0, 32).match(/.{4}/g)!.join("-");
}
