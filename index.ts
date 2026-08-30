// Entry point for pi auto-discovery (~/.pi/agent/extensions/<dir>/index.ts).
// The implementation lives in ./src/index.ts and is also referenced by
// package.json "pi.extensions" for `pi install`.
export { default } from "./src/index.ts";
