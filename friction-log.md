# Friction log

This is a scored submission artifact, assessed by Amazon's internal review
team at Stage One for up to a 10% bonus. It is not developer notes, and
entries are written live, in the session where the friction happened — never
batched at the end, never reconstructed from memory, never embellished. An
honest thin entry is worth more than a polished invented one.

Every entry uses exactly these six fields, in this order:

1. **Task attempted**
2. **Steps taken**
3. **Expected versus actual**
4. **Severity** (blocker / major / minor)
5. **Workaround**
6. **Actionable suggestion**

---

## Entry 001 — 2026-09-12

**Task attempted:** Confirm which published version of the MCP TypeScript SDK
declares support for protocol spec revision `2025-11-25`, the minimum version
required by the Alexa+ track rules, before writing any code against it.

**Steps taken:** Searched for the SDK's release history and changelog entries
mentioning `2025-11-25`. Checked the GitHub releases page for
`modelcontextprotocol/typescript-sdk`, the npm listings for
`@modelcontextprotocol/sdk`, `@modelcontextprotocol/server`, and
`@modelcontextprotocol/client`, and the SDK's own migration/FAQ docs.

**Expected versus actual:** Expected a single current package
(`@modelcontextprotocol/sdk`) with an unambiguous latest version supporting
`2025-11-25`. Actual: the SDK has been split. The legacy unified package,
`@modelcontextprotocol/sdk` (v1 line, latest found: `1.30.0`), negotiates
through the 2025-era `initialize` handshake and settles on the newest
revision both peers support — currently `2025-11-25` — so `1.30.0` is the
version that supports the required revision. Separately, a new v2 line has
shipped under two new package names, `@modelcontextprotocol/server` and
`@modelcontextprotocol/client` (server at a stable `2.0.0`, client still at
`2.0.0-alpha.2`), implementing a *later* revision, `2026-07-28`. The v2
packages retain the `2025-11-25` task-related wire types (`Task`,
`TaskStatus`, `CreateTaskResult`, etc.) for interoperability with peers still
on that revision, but they are not the same install target as the v1 line,
and the client half of v2 is alpha, not stable. I could not find a changelog
entry that names the exact v1 patch version where `2025-11-25` support first
landed — only that `1.30.0` (current latest) supports it, per the SDK's own
description of its negotiated-version behaviour.

**Severity:** major. Not a blocker — a working, spec-compliant install target
exists (`@modelcontextprotocol/sdk@1.30.0`) — but the package split happening
during the hackathon window means "install the MCP SDK" is no longer a
single, unambiguous instruction, and a v2-alpha client install would silently
target a spec revision later than the track's stated floor while being
neither the stable line nor guaranteed compatible with `2025-11-25`-only
peers.

**Workaround:** Pin `@modelcontextprotocol/sdk` at `1.30.0` explicitly
(not a caret range) for both the gateway (as MCP server) and the upstream
client pool (as MCP client to N upstreams), rather than installing whatever
`latest` dist-tag resolves to at any given moment during the build window.

**Actionable suggestion:** The SDK's own release notes and README should
carry a one-line compatibility table (package name → package version →
protocol revisions supported) at the top, not spread across a changelog, a
migration guide, and a FAQ. A hackathon builder on a fixed deadline should not
need three separate fetches to answer "which install target speaks the
revision my track requires."

---

## Entry 002 — 2026-09-12

**Task attempted:** Import `canonicalize` (the RFC 8785 JSON Canonicalization
Scheme library — `packages/policy`'s only permitted third-party runtime
dependency) as a default import in `packages/policy/src/canonical.ts`, under
this repo's `module: "NodeNext"` + `verbatimModuleSyntax: true` TypeScript
configuration.

**Steps taken:** Installed `canonicalize@2.1.0`, read its shipped
`lib/canonicalize.d.ts` (`export default function serialize(input: unknown):
string | undefined;`) and its `lib/canonicalize.js`
(`module.exports = function serialize (object) {...}`) directly out of
`node_modules` before writing any call against it, per this repo's own rule
to verify third-party surfaces rather than assume them. Wrote
`import canonicalize from "canonicalize";` and ran `pnpm --filter
@chaperone/policy build`.

**Expected versus actual:** Expected `esModuleInterop` to synthesize a
callable default from the package's CommonJS `module.exports`, since that is
exactly what `esModuleInterop` exists for. Actual: `tsc` failed with
`TS2349: This expression is not callable`, and the inferred type of the
import was the *entire module namespace* (`typeof import(".../canonicalize")`),
not the `serialize` function. The package has no `"type": "module"` and no
`exports` field in its `package.json`, so TypeScript's `NodeNext` resolution
treats the `.d.ts` as CommonJS-implied-format; a `.d.ts` written with ESM
`export default` syntax under a CommonJS implied format does not get the
synthetic-default treatment `esModuleInterop` normally provides — it appears
to hand back the module's own namespace type instead. Trying
`import { default as canonicalize } from "canonicalize";` produced the
identical error, ruling out import-syntax as the cause. `import canonicalize
= require("canonicalize")` was not usable either, since it is rejected by
`tsc` when the emitting file itself is ESM output (this package has
`"type": "module"`).

**Severity:** minor. Fully worked around with no loss of type safety or
correctness, but it cost real time to isolate against a fairly obscure
corner of Node16/NodeNext module-interop rules, on the one dependency this
package is contractually allowed to have.

**Workaround:** Load the package via `node:module`'s `createRequire` and
supply a hand-written type for its one export, verified line-by-line against
the installed package's actual `.js` and `.d.ts` (see
`packages/policy/src/jcs.ts`), rather than relying on the default-import
interop path.

**Actionable suggestion:** `canonicalize` should either ship a `"type"` field
(and matching ESM build) or express its default export with `export = ` in
its `.d.ts`, matching the CommonJS format its `package.json` already
declares — the current `.d.ts` claims an ES module shape its own
`package.json` doesn't back up, which is exactly the mismatch `NodeNext`
resolution is designed to catch and instead surfaces as a confusing "not
callable" error with no mention of the underlying interop cause.
