/// <reference types="vite/client" />

/**
 * The committed evidence files, inlined at build time by the
 * `chaperone-evidence` plugin in vite.config.ts. Declared here because the
 * module has no file on disk — it is generated from data/*.json and
 * benchmarks/*.json so that /corpus and /bench render with no network.
 */
declare module "virtual:chaperone-evidence" {
  import type { Evidence } from "../evidence.load";
  const evidence: Evidence;
  export default evidence;
}
