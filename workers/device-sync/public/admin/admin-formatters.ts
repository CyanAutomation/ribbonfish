export function formatTimestamp(value: string | number | null | undefined, locale?: string) {
  if (value === null || value === undefined || value === "") return "Never seen";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  const formatted = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "UTC",
  }).format(date);
  return `${formatted} UTC`;
}

type AgeUnits = { unknown: string; second: string; minute: string; hour: string; day: string };

const compactAgeUnits: AgeUnits = { unknown: "unknown", second: "s", minute: "m", hour: "h", day: "d" };
const detailedAgeUnits: AgeUnits = { unknown: "unknown age", second: " sec", minute: " min", hour: " hr", day: " days" };

function formatAgeWithUnits(seconds: number, units: AgeUnits) {
  if (!Number.isFinite(seconds) || seconds < 0) return units.unknown;
  if (seconds < 60) return `${Math.floor(seconds)}${units.second}`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}${units.minute}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}${units.hour} ${minutes % 60}${units.minute}`;
  const days = Math.floor(hours / 24);
  return `${days}${units.day} ${hours % 24}${units.hour}`;
}

export function formatAge(seconds: number) {
  return formatAgeWithUnits(seconds, compactAgeUnits);
}

export function formatDetailedAge(seconds: number) {
  return formatAgeWithUnits(seconds, detailedAgeUnits);
}

export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = bytes;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${amount.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
