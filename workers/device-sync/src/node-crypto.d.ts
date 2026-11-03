// The Worker enables Node.js compatibility through its compatibility date.
// Declare the one Node API used here without adding Node globals to the Worker project.
declare module "node:crypto" {
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}
