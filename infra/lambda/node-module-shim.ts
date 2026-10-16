import canonicalizeModule from "canonicalize";
import { ConfigError } from "@chaperone/errors";

/**
 * Stand-in for `node:module`, aliased in for the advisory Lambda bundles only
 * (infra/lib/advisory-pipeline-stack.ts, `LAMBDA_BUNDLING`).
 *
 * `@chaperone/policy`'s jcs.ts loads `canonicalize` with
 * `createRequire(import.meta.url)("canonicalize")`. In a CommonJS Lambda
 * bundle `import.meta.url` is undefined, so `createRequire` threw at module
 * load and every execution of the pipeline failed (first real deploy,
 * 2026-10-16; friction log entry 050). esbuild also cannot see through a
 * locally bound `require`, so the package would not be in the bundle anyway.
 *
 * This returns the bundled `canonicalize` package itself: the same module
 * jcs.ts would have loaded, so the hashing implementation the gateway and the
 * crawler share is untouched (CLAUDE.md, non-negotiable 5). Any other id is a
 * bundling gap and fails loudly rather than resolving to something else.
 */
export function createRequire(_from: string | URL): (id: string) => unknown {
  return (id: string): unknown => {
    if (id === "canonicalize") return canonicalizeModule;
    throw new ConfigError(`node-module-shim: require("${id}") is not bundled into this Lambda`, { id });
  };
}
