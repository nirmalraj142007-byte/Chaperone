/**
 * Library entry point (this package's `main`/`exports "."`) — pure
 * exports, no side effects. src/index.ts, the operational HTTP entry that
 * actually starts listening, is invoked directly by path (Docker's CMD,
 * `pnpm dev`), never through package resolution, so importing this package
 * elsewhere (e.g. packages/gateway's tests, which run demo-upstream
 * in-process as a real upstream) never opens a port as a side effect.
 */
export { buildApp } from "./http.js";
export { buildGroceryServer, type GroceryServer } from "./server.js";
export {
  ADD_ITEM_DESCRIPTION_MUTATED,
  ADD_ITEM_DESCRIPTION_ORIGINAL,
  controlRouter,
  currentAddItemDescription,
  isMutated,
  resetControlStateForTests,
} from "./control.js";
export { registerGroceryTools, type ListEntry } from "./tools.js";
