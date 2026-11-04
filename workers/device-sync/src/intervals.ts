export const CAPTURE_INTERVALS = Object.freeze([
  Object.freeze({ value: 15 * 60, label: "15 minutes" }),
  Object.freeze({ value: 30 * 60, label: "30 minutes" }),
  Object.freeze({ value: 60 * 60, label: "1 hour" }),
  Object.freeze({ value: 3 * 60 * 60, label: "3 hours" }),
  Object.freeze({ value: 6 * 60 * 60, label: "6 hours" }),
  Object.freeze({ value: 12 * 60 * 60, label: "12 hours" }),
  Object.freeze({ value: 24 * 60 * 60, label: "24 hours" }),
]);
export const DEFAULT_CAPTURE_INTERVAL_SECONDS = 24 * 60 * 60;

export const ROTATION_INTERVALS = Object.freeze([
  Object.freeze({ value: "30s", label: "30 seconds" }),
  Object.freeze({ value: "60s", label: "60 seconds" }),
  Object.freeze({ value: "90s", label: "90 seconds" }),
  Object.freeze({ value: "120s", label: "120 seconds" }),
  Object.freeze({ value: "5m", label: "5 minutes" }),
]);
export const DEFAULT_ROTATION_INTERVAL = "90s";

export function isSupportedCaptureInterval(value: unknown): value is number {
  return Number.isSafeInteger(value) && CAPTURE_INTERVALS.some(({ value: allowed }) => allowed === value);
}

export function isSupportedRotationInterval(value: unknown) {
  return ROTATION_INTERVALS.some(({ value: allowed }) => allowed === value);
}

export function intervalCatalog() {
  return {
    capture: { unit: "seconds", default: DEFAULT_CAPTURE_INTERVAL_SECONDS, options: CAPTURE_INTERVALS },
    rotation: { unit: "duration", default: DEFAULT_ROTATION_INTERVAL, options: ROTATION_INTERVALS },
  };
}
