import { sha256HexBytes } from "./crypto-primitives.ts";

const SIGNATURE_CLOCK_SKEW_MS = 5 * 60 * 1000;

export async function verifyDeviceSignature(request: Request, deviceID: string, publicKey: string, bodyBytes: Uint8Array): Promise<boolean> {
  const timestamp = request.headers.get("X-Ribbonfish-Timestamp") ?? "";
  if (!/^\d{13}$/.test(timestamp)) return false;
  const timestampValue = Number(timestamp);
  if (!Number.isSafeInteger(timestampValue) || Math.abs(Date.now() - timestampValue) > SIGNATURE_CLOCK_SKEW_MS) return false;

  const signatureText = request.headers.get("X-Ribbonfish-Signature") ?? "";
  if (!/^[A-Za-z0-9_-]{86}$/.test(signatureText)) return false;
  const signature = decodeBase64Url(signatureText);
  const publicKeyBytes = decodeBase64Url(publicKey);
  if (signature.byteLength !== 64 || publicKeyBytes.byteLength !== 32) return false;

  try {
    const key = await crypto.subtle.importKey("raw", new Uint8Array(publicKeyBytes).buffer, { name: "Ed25519" }, false, ["verify"]);
    const url = new URL(request.url);
    const target = url.pathname + url.search;
    const bodyHash = await sha256HexBytes(bodyBytes);
    const payload = [
      "ribbonfish-device-v1",
      request.method,
      target,
      deviceID,
      timestamp,
      request.headers.get("If-None-Match") ?? "",
      bodyHash,
    ].join("\n");
    return await crypto.subtle.verify("Ed25519", key, new Uint8Array(signature).buffer, new TextEncoder().encode(payload));
  } catch {
    return false;
  }
}

export function decodeBase64Url(value: string): Uint8Array {
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return new Uint8Array();
  }
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function constantTimeEqual(left: string, right: unknown): boolean {
  if (typeof right !== "string" || left.length !== right.length) return false;
  let result = 0;
  for (let i = 0; i < left.length; i++) result |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return result === 0;
}

