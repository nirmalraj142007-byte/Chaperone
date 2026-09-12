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

---

## Entry 003 — 2026-09-12

**Task attempted:** Bring up DynamoDB Local per this phase's own acceptance
test (`docker compose up -d ddb && pnpm ddb:migrate && pnpm ddb:seed`) in the
development sandbox this session runs in, so `packages/ledger` could be
verified against a real local DynamoDB endpoint rather than only against
mocked SDK calls, before declaring the phase done.

**Steps taken:** Checked for `docker` on `PATH` and in the standard Windows
install locations (`Program Files\Docker`, `ProgramData\DockerDesktop`) —
absent; Docker Desktop is not installed on this machine. Fell back to the
non-Docker path: downloaded the standalone `amazon/dynamodb-local` JAR
distribution directly from
`https://s3.us-west-2.amazonaws.com/dynamodb-local/dynamodb_local_latest.tar.gz`
and ran it with the installed JDK (`java -jar DynamoDBLocal.jar -sharedDb
-inMemory -port 8000`), confirming via `Get-NetTCPConnection` that the
process bound port 8000. Tried both the default invocation and a retry with
`-Djava.net.preferIPv4Stack=true`.

**Expected versus actual:** Expected a listening DynamoDB Local instance
reachable at `http://localhost:8000`. Actual: the process crashed on
startup both times with `java.io.IOException: Unable to establish loopback
connection`, thrown out of `sun.nio.ch.WEPollSelectorImpl`'s constructor
while Jetty (DynamoDB Local's embedded HTTP server) opens its connector
selector — a JDK-internal NIO `Pipe`/`Selector` implementation on Windows
that itself depends on a loopback Unix Domain Socket connecting
successfully, which failed with `SocketException: Invalid argument:
connect`. This reproduced identically on both attempts and is a JVM/OS-level
failure in the installed `java version "26.0.2"` runtime, not anything in
this project's code — no other JDK version was available on this machine to
cross-check whether an older JDK avoids it, and WSL is also not installed,
closing off that alternate path too.

**Severity:** major, for verification only — not a defect in the delivered
code. `packages/ledger` is fully implemented and its business logic
(hash-chain construction in `appendEvent`, tamper detection and break
reporting in `verifyChain`, the `attribute_not_exists(sk)` race-retry, the
`actor !== "model"` guard, `ResourceNotFoundException`/throttling error
wrapping) is exercised by 18 unit tests against a mocked
`DynamoDBDocumentClient`, all passing, plus a clean `tsc -b`, `pnpm lint`,
and `pnpm depcruise`. What could not be run in this sandbox was the literal
acceptance sequence this phase's own prompt specifies: `docker compose up -d
ddb`, `pnpm ddb:migrate`, `pnpm ddb:seed`, `pnpm verify-ledger` against a
real DynamoDB Local process, and the AWS-CLI tamper-and-re-verify check.

**Workaround:** None available inside this sandbox — this is a genuine gap
between "logic verified" and "verified against the real dependency," and it
should be closed by running the exact `VERIFY` block from this phase's
prompt on a machine with Docker installed before treating this phase as
fully accepted, not by trusting the mocked-client test suite alone.

**Actionable suggestion:** Either provision this kind of development sandbox
with Docker available (the project's own `docker-compose.yml` already
assumes it), or, if a Docker-less fallback is ever needed again, pin a
specific older JDK for local tooling rather than relying on whatever `java`
resolves to on `PATH` — this failure is specific to the Windows NIO
selector implementation shipped in this JDK build and would not necessarily
reproduce on Linux/macOS or an earlier JDK line.

**Update, later session (2026-09-12):** Docker was installed on the machine
between sessions. `docker compose up -d ddb` worked immediately — but
bringing the ledger's live acceptance flow fully green still took another
round of real debugging, not a clean pass. See Entry 004.

---

## Entry 004 — 2026-09-12

**Task attempted:** Run this phase's actual acceptance flow (`docker
compose up -d ddb && pnpm ddb:migrate && pnpm ddb:seed && pnpm
verify-ledger`) now that Docker is installed, to close the gap Entry 003
left open — verifying `packages/ledger` against a real DynamoDB Local
instance rather than only the mocked-client test suite.

**Steps taken:** `docker compose up -d ddb` started cleanly and
`docker compose logs ddb` showed a normal-looking startup banner. But
`pnpm ddb:migrate` then hung indefinitely with zero output, past a 60s
timeout — not an error, a true hang. Isolated it step by step rather than
guessing: `curl` and Node's built-in `fetch` both reached
`http://127.0.0.1:8000/` in under 100ms (got the expected `400 Bad
Request`/`MissingAuthenticationToken` for an unsigned request), which ruled
out basic container/port/network problems. A raw `node:http` request with
an unsigned body also completed in 11ms. That narrowed it specifically to
`@aws-sdk/client-dynamodb`'s own request path, so I probed the SDK
directly with `maxAttempts: 1` and an explicit
`requestHandler: { requestTimeout: 5000, throwOnRequestTimeout: true }` —
without `throwOnRequestTimeout`, `@smithy/node-http-handler` only logs a
`[WARN]` after the timeout and the promise never settles, which is exactly
why `migrate.ts` (using SDK defaults) hung with *no output at all* instead
of failing loudly. With the explicit timeout it threw cleanly, confirming a
real, signed request to DynamoDB Local genuinely never got a response.
`docker compose logs ddb` at that point showed the real cause, repeating
every 3 seconds: `com.almworks.sqlite4java.SQLiteException: [14] unable to
open database file` / `SQLiteQueue[shared-local-instance.db]: stopped
abnormally, reincarnating in 3000ms`. `docker exec chaperone-ddb sh -c "id;
ls -la /home/dynamodblocal"` showed why: the image runs as
`dynamodblocal` (uid 1000), but Docker creates a fresh named volume's mount
point owned `root:root` with mode `755` — writable by root, read+execute
only for everyone else. `-dbPath ./data` (added in `docker-compose.yml` so
data survives a restart) pointed DynamoDB Local's SQLite backend at exactly
that unwritable directory, so every table-creating/data-touching request
(anything past a bare unauthenticated ping) hung forever waiting on a
storage layer stuck in an infinite crash-reconnect loop.

**Expected versus actual:** Expected `docker compose up -d ddb` plus this
package's own scripts to just work, since the compose file and the ledger
code were both already written and type-checked. Actual: the compose file
itself had a real bug — the named-volume mount point's default ownership
under Docker Desktop doesn't match the image's non-root user, and DynamoDB
Local's Jetty layer accepts and holds the TCP connection open while the
storage layer is failing behind it, so the client-visible symptom is an
indefinite hang with no error, not a fast, diagnosable failure.

**Severity:** blocker, until root-caused — a hang with no error message is
the worst failure mode for anyone hitting this next, since every natural
first instinct (check the container is up, curl the port, check the SDK
version) comes back clean.

**Workaround:** Added `user: root` to the `ddb` service in
`docker-compose.yml`, so the container has full access to the volume Docker
created for it — there's no privilege-drop step in the image's own
entrypoint being bypassed, it runs `java` directly either way. Torn down
and recreated the corrupted volume (`docker compose down -v`) before
retrying, since the crash-looped instance had never successfully written
anything worth keeping. After that fix, the full flow ran clean: 9 tables
created, 2 tools pinned, `pnpm verify-ledger` reported `chain OK — 6 events
verified` with exit 0, `aws dynamodb list-tables`/`describe-table` matched
spec exactly, and the tamper test (mutating the payload of a mid-chain
event directly via `aws dynamodb update-item`, leaving `payloadHash`
untouched) made `verify-ledger` correctly report `chain BROKEN at index 3`
with exit 1, before restoring the original payload and re-seeding back to
a verified-green chain of 12 events.

**Actionable suggestion:** Two separate ones. First, for this repo: anyone
else standing this up fresh on Docker Desktop will hit the same volume
permission mismatch — `user: root` is now committed in
`docker-compose.yml` so this shouldn't recur, but it's worth knowing this
was a real bug in what Phase 3 originally shipped, not an environment
fluke like Entry 003. Second, more general: `@aws-sdk/client-dynamodb`'s
default `NodeHttpHandler` behavior — warn-and-never-settle on a request
timeout unless `throwOnRequestTimeout` is explicitly set — turned a
diagnosable timeout into a silent, indefinite hang. Any script or service
built on this SDK in this repo should set `requestTimeout` and
`throwOnRequestTimeout: true` explicitly rather than trusting the default,
so a real storage-layer failure surfaces as a fast, loud error instead of a
hang indistinguishable from "still working."
