import { createHash, randomBytes } from "node:crypto";

const durationMinutes = Number(process.argv[2] ?? "30");
if (!Number.isSafeInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 1440) {
  throw new Error("usage: node scripts/make-enrollment-code.mjs [expiry-minutes: 1-1440]");
}

const code = randomBytes(24).toString("base64url");
const codeHash = createHash("sha256").update(code).digest("hex");
const expiresAt = Date.now() + durationMinutes * 60_000;

process.stdout.write(`One-time enrollment code (deliver privately): ${code}\n`);
process.stdout.write("Insert this hash into D1; the code itself is never stored:\n");
process.stdout.write(`INSERT INTO enrollments (code_hash, expires_at) VALUES ('${codeHash}', ${expiresAt});\n`);
