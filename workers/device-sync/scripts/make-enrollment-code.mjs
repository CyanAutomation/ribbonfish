import { createHash, randomBytes } from "node:crypto";

const durationMinutes = Number(process.argv[2] ?? "30");
if (!Number.isSafeInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 1440) {
  throw new Error("usage: node scripts/make-enrollment-code.mjs [expiry-minutes: 1-1440]");
}

const code = randomBytes(24).toString("base64url");
const codeHash = createHash("sha256").update(code).digest("hex");
const expiresAt = Date.now() + durationMinutes * 60_000;
if (!/^[a-f0-9]{64}$/.test(codeHash) || !Number.isSafeInteger(expiresAt)) {
  throw new Error("generated enrollment SQL values are invalid");
}

// The generated hash is validated hex and the timestamp is a safe integer.
// Keep text SQL literals escaped if this generator is extended with more values.
const sqlString = (value) => `'${value.replaceAll("'", "''")}'`;

process.stdout.write(`One-time enrollment code (deliver privately): ${code}\n`);
process.stdout.write("Insert this hash into D1; the code itself is never stored:\n");
process.stdout.write(`INSERT INTO enrollments (code_hash, expires_at) VALUES (${sqlString(codeHash)}, ${expiresAt});\n`);
