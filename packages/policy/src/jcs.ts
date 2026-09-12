import { createRequire } from "node:module";

/**
 * `canonicalize`'s own .d.ts (`export default function serialize(...)`) is
 * not resolvable as a default import under `module: NodeNext` +
 * `verbatimModuleSyntax` — TypeScript 5.6 resolves the import to the whole
 * CommonJS module-namespace type instead of the function, and the call site
 * fails with TS2349 ("not callable"). Loading it via `createRequire` and
 * typing it by hand sidesteps that interop bug without touching what
 * actually runs. Verified against `canonicalize@2.1.0`'s real export shape
 * (`module.exports = function serialize (object) {...}`) before writing
 * this type.
 */
export type CanonicalizeFn = (value: unknown) => string | undefined;

const require = createRequire(import.meta.url);

export const canonicalizeJson: CanonicalizeFn = require("canonicalize") as CanonicalizeFn;
