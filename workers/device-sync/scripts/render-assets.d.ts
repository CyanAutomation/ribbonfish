declare module "*.bin" {
  const value: ArrayBuffer;
  export default value;
}

declare module "*.wasm" {
  const value: WebAssembly.Module;
  export default value;
}
