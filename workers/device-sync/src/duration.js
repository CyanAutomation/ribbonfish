const DURATION_COMPONENT = /([0-9]+)(?:\.([0-9]+))?(ns|us|µs|ms|s|m|h)/g;
const UNIT_NANOSECONDS = {
  ns: 1n,
  us: 1_000n,
  "µs": 1_000n,
  ms: 1_000_000n,
  s: 1_000_000_000n,
  m: 60_000_000_000n,
  h: 3_600_000_000_000n,
};
const MAX_DURATION_NANOSECONDS = (1n << 63n) - 1n;

// isValidPositiveDuration matches the positive range accepted by Go's
// time.ParseDuration and time.Duration, which the device agent uses.
export function isValidPositiveDuration(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) return false;

  let position = 0;
  let totalNanoseconds = 0n;
  for (const match of value.matchAll(DURATION_COMPONENT)) {
    if (match.index !== position) return false;
    const [, whole, fraction = "", unit] = match;
    const scale = 10n ** BigInt(fraction.length);
    const unitNanoseconds = UNIT_NANOSECONDS[unit];
    totalNanoseconds += BigInt(whole) * unitNanoseconds;
    if (fraction) totalNanoseconds += (BigInt(fraction) * unitNanoseconds) / scale;
    if (totalNanoseconds > MAX_DURATION_NANOSECONDS) return false;
    position += match[0].length;
  }

  return position === value.length && totalNanoseconds > 0n;
}
