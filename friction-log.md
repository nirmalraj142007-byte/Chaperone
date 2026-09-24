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

**Audit, 2026-09-24 (Phase 21).** 41 entries, 001 to 041 (040 and 041 were
added by this audit's own quickstart run). A script checked that every entry
contains all six fields above, in that order: 41 of 41 do.
Four entries carry "(thin)" in their heading because the friction was small,
a repeat of an earlier entry, or the suggestion is not aimed at the tool
they are filed against, and they have been left as written rather than
padded: **010** (a startup warning that never became a failure), **012** (the
second instance of 007's cast, same root cause), **014** (deliberate SDK
behaviour; the suggestion is "none for the SDK"), **016** (a bug in this
repo's own error handler, not friction with a third-party tool). Entries
003, 017, 018 and 022 carry an extra labelled paragraph after the six fields
(an update, or a false alarm the entry caused); the six fields are still
present and in order. Entry 006 had one stray duplicated line at its end
(a fragment of Entry 005), which was removed; no other wording was changed.

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

---

## Entry 005 — 2026-09-12

**Task attempted:** Implement `packages/crawler`'s five metadata sources
(registry, PulseMCP, Glama, Smithery, awesome-mcp-servers) against their
real, live APIs, per this phase's prompt — which specified assumed shapes
and auth behavior for each and asked that any discrepancy be recorded here
rather than silently coded around.

**Steps taken:** Before writing any source module, hit each real endpoint
directly with `curl` and inspected the actual response (status, headers,
body), per this repo's own rule to verify third-party surfaces rather than
assume them. `registry.modelcontextprotocol.io/v0/servers` matched the
prompt's assumption closely (cursor pagination via `metadata.nextCursor`,
confirmed against the service's own published `openapi.yaml`). The other
three did not:
- **PulseMCP:** the prompt assumed a paginated public API. The `v0beta`
  endpoint this would naturally target returns `410 Gone` with an
  `API_SUNSET` error body stating it is "Fully sunset (100%)" as of
  September 2026. Its replacement, `v0.1` (documented at
  `https://www.pulsemcp.com/api/docs/v0.1`), requires an `X-API-Key` —
  confirmed with a live `401 {"error":"Invalid or missing API key",...}` —
  which this project does not hold.
- **Glama:** `glama.ai/api/mcp/v1/servers` requires an API key on every
  call, confirmed with a live `401` whose body points to
  `glama.ai/settings/api-keys`. No public schema for the authenticated
  response was found, unlike PulseMCP.
- **Smithery:** the prompt anticipated needing 401-detection and graceful
  degradation for this one specifically. The opposite is true —
  `registry.smithery.ai/servers` is fully open, confirmed with a live `200`
  and a real payload (14,502 total servers, page-based `pagination` object,
  no key required at all).

**Expected versus actual:** Expected PulseMCP and Smithery to behave as the
prompt described (both roughly open, paginated); expected Glama's
"cursor-paginated" characterization to be checkable against a real
response. Actual: two of the three community directories the prompt
treated as free now gate their list endpoint behind a key (PulseMCP as of
this same month; Glama's error message gives no indication it was ever
free), and the one directory flagged as possibly gated is the one that
turned out to be fully open.

**Severity:** minor. Each source degrades to contributing 0 with a clear
log line rather than failing the run (`pulsemcp.ts`, `glama.ts`), so the
overall corpus-assembly command still succeeds — verified end to end: a
real run on 2026-09-12 produced 610 deduplicated servers (registry 131,
smithery 129, awesome 350 unique contributions; pulsemcp and glama both 0)
against the required floor of 300, with 419 carrying a `repoUrl`.

**Workaround:** `pulsemcp.ts` reuses `registry.ts`'s `parseRegistryServer`
(PulseMCP's own docs confirm the v0.1 response is the identical
`server.json` schema), gated behind an optional `PULSEMCP_API_KEY` /
`PULSEMCP_TENANT_ID` — implemented correctly per their documentation but
never exercised end-to-end since no key is configured. `glama.ts` similarly
supports an optional `GLAMA_API_KEY`, but its pagination shape
(`first`/`after`/`pageInfo`) is a documented-nowhere best-effort guess and
is explicitly commented as unverified dead code unless a key is supplied.
`smithery.ts` keeps a 401/403 degrade path anyway as defensive-only code,
since the current open policy could change.

**Actionable suggestion:** Don't budget on PulseMCP or Glama contributing
to the corpus unless a household is willing to pay for API keys on both
before crawl 2 (2026-10-20) — if that's worth doing, it should happen well
before crawl 2 so the source is exercised for real at least once first.
Otherwise, the corpus's community-directory coverage is Smithery-only, and
the registry + awesome-mcp-servers sources are carrying the real weight of
clearing the N=300 floor, which they do comfortably on their own.

## Entry 006 — 2026-09-13

**Task attempted:** Build the Phase 5 boot harness (`packages/crawler/src/boot.ts`)
— boot each corpus candidate in a `--read-only`, network-restricted Docker
container and call `tools/list` over stdio. First real end-to-end smoke test
was `npx -y @1mcp/agent` against the built runtime image.

**Steps taken:** The container built and the network/proxy allowlist worked
exactly as designed (verified separately: `registry.npmjs.org`/`pypi.org`
reachable, `example.com` blocked with `403 Filtered`, and no route out at all
without the proxy env vars set). npx itself installed `@1mcp/agent`
successfully — real network I/O, real npm resolution, ~30–35s wall time. The
boot then failed with `sh: 1: 1mcp: Permission denied` (exit 126). Ran the
same install manually inside an identical container to isolate it: the
installed file had correct permissions (`-rwxr-xr-x`, confirmed via `stat`),
and invoking it directly via `node <path>/build/index.js --help` worked fine
— so the binary itself was never the problem. `mount` inside the container
showed the actual cause: `tmpfs on /tmp type tmpfs (rw,nosuid,nodev,noexec,relatime)`.

**Expected versus actual:** Expected `--tmpfs /tmp` (needed alongside
`--read-only` so npm/pip/uv have anywhere writable at all) to behave like an
ordinary writable directory. Actual: Docker's bare `--tmpfs /tmp` silently
defaults to mounting with `noexec`, which has nothing to do with file
permission bits — every install method this harness uses (`npx`, `pip`,
`uvx`) downloads code and then *executes it from /tmp*, so this wasn't a
one-off failure on one candidate, it would have silently misclassified every
single successful install as `FAILED_INSTALL`/`FAILED_START` corpus-wide,
with a stderr line ("Permission denied") that reads exactly like a real
per-server bug rather than a harness-wide misconfiguration.

**Severity:** blocker (would have been, if not caught before the real crawl —
this surfaced on the very first smoke test, before any acceptance run).

**Workaround:** pass tmpfs mount options explicitly:
`--tmpfs /tmp:rw,exec,nosuid,size=1g` (also raising size past Docker's 64m
default, since some npx dependency trees exceed it). Fixed in `boot.ts`'s
`buildDockerArgs` before any timed acceptance run.

**Actionable suggestion:** Anyone reproducing this harness outside this repo
should not trust `--read-only --tmpfs /tmp` as a pattern from memory or from
most Docker security write-ups (which usually only care about *writability*,
not *executability*, since their threat model is a service writing exploit
payloads to disk — ours is the opposite: /tmp is *supposed* to run code).
Test one real install end-to-end before trusting the harness's failure
categories on a genuinely broken server; a clean-looking `FAILED_INSTALL`
distribution can be 100% environmental.

---

## Entry 007 — 2026-09-13

**Task attempted:** Connect `McpServer.connect(transport)` on a
`StreamableHTTPServerTransport` in `packages/mcp-app/src/spike-server.ts`,
under this repo's `exactOptionalPropertyTypes: true` (`tsconfig.base.json`).

**Steps taken:** Wrote the connection exactly as the SDK's own JSDoc usage
example on `StreamableHTTPServerTransport` shows it, then ran `pnpm
typecheck`. Read `node_modules/@modelcontextprotocol/sdk@1.30.0`'s
`dist/esm/shared/transport.d.ts` and `dist/esm/server/streamableHttp.d.ts`
directly (this repo's "verify rather than remember" rule) to confirm the
class really does `implements Transport` in the SDK's own source before
concluding this wasn't a typo on my part.

**Expected versus actual:** Expected a clean compile, since the class
literally declares `implements Transport`. Actual:
`TS2379: Argument of type 'StreamableHTTPServerTransport' is not assignable
to parameter of type 'Transport' with 'exactOptionalPropertyTypes: true'`,
specifically on `onclose`. `Transport.onclose` is declared `onclose?: () =>
void` (an optional property, exact under this flag: absent, or exactly
`() => void`), but `StreamableHTTPServerTransport`'s own getter/setter pair
types it `(() => void) | undefined` — a wider type that satisfies a *plain*
optional property but not an *exact* one. The SDK's own build presumably
doesn't set `exactOptionalPropertyTypes`, so its `implements Transport`
clause never sees this mismatch; it only appears in a consumer repo that
turns the flag on, which this one deliberately does repo-wide.

**Severity:** minor. Fully worked around, one call site, no runtime
behavior change — but it cost real time to confirm this was a genuine
cross-package strictness mismatch and not a misuse of the API, since the
error message alone doesn't say which property or why.

**Workaround:** A single explicit `as Transport` cast at the one call site
(`connectTransport` in `spike-server.ts`), with a code comment naming the
exact incompatible property and the two `.d.ts` files it was verified
against, rather than relaxing `exactOptionalPropertyTypes` for this package
or the repo.

**Actionable suggestion:** If the MCP TypeScript SDK wants to be usable
from a consumer repo with `exactOptionalPropertyTypes: true` — an
increasingly common strictness default, and one this project's own
CLAUDE.md mandates — its own transport classes should type
`onclose`/`onerror`/`onmessage` as bare optional properties (`() => void`,
no `| undefined`) to match the `Transport` interface they implement, or the
interface should widen to `(() => void) | undefined` to match what every
concrete transport actually offers. Right now the two disagree, and only a
consumer with the strict flag on ever finds out.

---

## Entry 008 — 2026-09-13

**Task attempted:** Verify the spike server built for this phase
(`packages/mcp-app/src/spike-server.ts`) against a second, independent
client connection after already exercising it once with `npx
@modelcontextprotocol/inspector --cli ... --method tools/list`.

**Steps taken:** Ran a second `inspector --cli` invocation (a fresh OS
process, so a fresh `initialize`) against the same running server without
restarting it.

**Expected versus actual:** Expected either a second independent session or
at worst a clear "already connected" style error naming the constraint.
Actual: `Invalid Request: Server already initialized` — because the first
cut of `main()` created exactly one `StreamableHTTPServerTransport` for the
whole process lifetime and connected one `McpServer` to it, per the
simplest form of the SDK's own single-transport usage example. That example
is correct for what it shows, but it silently only supports one MCP session
ever, for the life of the process — a second `initialize`, from any client,
at any later time, is rejected, not queued or replaced.

**Severity:** minor for this spike (single-client testing), but would be a
real defect if carried into `packages/gateway`, where serving exactly one
household session ever, then refusing every session after, is silent
data-loss-adjacent behavior with no error surfaced to the resident.

**Workaround:** Rewrote `main()` to the SDK's session-map pattern instead:
one `StreamableHTTPServerTransport` per session, keyed by the
`mcp-session-id` header, created only on a real `initialize` request
(checked via the SDK's own `isInitializeRequest`) and removed from the map
in `transport.onclose`. Verified by running `resources/list`,
`resources/read`, and `tools/call` as four separate CLI invocations against
one running server with no restart, each getting its own session.

**Actionable suggestion:** The SDK's single-transport JSDoc example
(`server/streamableHttp.d.ts`) should say explicitly, in the example itself,
that it supports exactly one session for the transport's lifetime — the
multi-session map pattern is documented elsewhere in the ecosystem's
examples, but not cross-referenced from the class's own doc comment, so the
simpler (wrong-for-more-than-one-client) form reads as the canonical one.

---

## Entry 009 — 2026-09-13

**Task attempted:** Verify, per this phase's explicit instruction, which
mechanism the installed MCP SDK (`@modelcontextprotocol/sdk@1.30.0`) and
protocol revision `2025-11-25` actually provide for UI resources — the
`ui://` scheme, `@mcp-ui/server` conventions, or something else — before
writing `render.ts`'s HTML output or `spike-server.ts`'s registration code.

**Steps taken:** Read the SDK's own `types.d.ts` and `server/mcp.d.ts` —
found `LATEST_PROTOCOL_VERSION = "2025-11-25"` and a generic
`registerResource`, but no `ui://`-specific type or helper anywhere in the
SDK itself. Fetched the official spec changelog
(`modelcontextprotocol.io/specification/2025-11-25/changelog`) — no
UI-resource or "MCP Apps" item in it at all; core-spec 2025-11-25 does not
define this. Fetched `mcpui.dev`'s own docs, which state MCP-UI "pioneered"
the concept and that current `@mcp-ui/*` packages "now implement the
standardized MCP Apps specification rather than defining it independently"
— i.e. MCP Apps is a separate, still-emerging extension, not core spec.
Installed `@modelcontextprotocol/inspector@2.6.0` (`npx
@modelcontextprotocol/inspector`) to test rendering, and found it ships its
own official implementation of that extension,
`@modelcontextprotocol/ext-apps@1.7.5` ("MCP Apps SDK", `github.com/
modelcontextprotocol/ext-apps`), used internally by Inspector's `--app-info`
CLI flag and by its web UI's "Apps" tab. Read `ext-apps`'s bundled
`dist/src/app-bridge.js` directly (minified, no way to consult a changelog
for an extension this new) to find the exact contract: a tool opts into
having an associated UI resource via `_meta["ui/resourceUri"]` (or
`_meta.ui.resourceUri`), the resource's canonical mimeType is
`text/html;profile=mcp-app`, and the UI, once loaded, must perform a
`ui/initialize` JSON-RPC request/response handshake over `postMessage`
before it is allowed to call `tools/call` (as a further real JSON-RPC
request, not an ad-hoc message) — full details and the exact experiment run
against both surfaces are in `docs/DECISIONS.md`, "MCP App mechanism".

**Expected versus actual:** Expected the answer to be "yes, `ui://` +
`text/html`, straightforwardly." Actual: the mechanism this phase's own
prompt asked me to build against (a plain `ui://` resource, `text/html`
mimetype, informal `postMessage({type:'tool',...})` bridge — the `@mcp-ui/
server`-flavored convention named in the prompt) renders in MCP Inspector's
plain resource preview, but that preview sandboxes the iframe with
`sandbox=""` (all script execution disabled, confirmed by reading the live
DOM's `iframe` element) — so the card's own buttons can never work there,
independent of what their `postMessage` payload contains. The mechanism
that *does* allow scripts and a working round trip is the formally
different `@modelcontextprotocol/ext-apps` bridge, which requires the
`_meta` linkage and the `ui/initialize` handshake this phase's prompt did
not ask for and I would not have known to build without reading the
extension's source directly — there is no changelog or migration note
anywhere that says "the informal `postMessage` convention your prompt
describes is superseded by this JSON-RPC handshake."

**Severity:** major, for anyone budgeting the resident-facing consent
surface as "cheap, mostly done" based on the community convention alone —
the gap between "renders" and "buttons actually work" is not a polish item,
it is a different, undocumented wire protocol.

**Workaround:** None needed for this phase — the spike's job was to find
this out before, not during, the twelve hours of downstream P0 work. Recorded
precisely, with the exact `_meta` key, mimetype, and handshake sequence
needed, in `docs/DECISIONS.md`, so the follow-on work has a known target
instead of a rediscovery cost.

**Actionable suggestion:** `@modelcontextprotocol/ext-apps` is a brand-new
(2026) extension with no changelog, no migration guide from the informal
`@mcp-ui/server` convention it supersedes, and its only working
documentation, in practice, is its own minified bundle. Anyone building an
MCP App today should budget real time to read that bundle directly rather
than trust `mcpui.dev`'s docs or a general web search to describe the
current wire protocol — both were accurate about the concept and stale
about the exact mechanism.

---

## Entry 010 — 2026-09-13 (thin: see audit note at top)

**Task attempted:** Register the tool this phase's prompt specified,
`chaperone/approve_change`, verbatim, on the spike `McpServer`.

**Steps taken:** Ran `server.registerTool("chaperone/approve_change", ...)`
and started the server.

**Expected versus actual:** Expected silent success — the name is exactly
what the prompt asked for. Actual: the SDK printed a startup-time warning to
stderr: `Tool name contains invalid characters: "/"` / `Allowed characters
are: A-Z, a-z, 0-9, underscore (_), dash (-), and dot (.)`, citing
`modelcontextprotocol/modelcontextprotocol#986` ("Specify Format for Tool
Names"). Registration proceeded anyway (the SDK only warns, it doesn't
reject), and every test against it — `tools/list`, `tools/call`, MCP
Inspector's CLI and web UI, the `--app-info` probe — worked without issue.

**Severity:** minor today, forward-looking risk otherwise. Nothing observed
in this phase's testing actually enforces the naming SEP yet, but the
warning exists because some future SDK version, or some other host, may.

**Workaround:** None applied — kept the literal name this phase's prompt
specified, since changing it would break the resident-facing wire contract
(`chaperone/approve_change` embedded in every consent card) for a
naming-convention warning with no enforced failure today.

**Actionable suggestion:** Before this tool name ships past a spike, decide
deliberately whether to keep the `/`-namespaced style (readable, matches
this project's `{upstreamId}__{toolName}` gateway convention's *spirit* if
not its exact separator) or switch to the SEP-986-conformant
`chaperone_approve_change`/`chaperone-approve-change`, rather than carrying
a startup warning into the real gateway by inertia.

---

## Entry 011 — 2026-09-13

**Task attempted:** Build packages/gateway's upstream passthrough (Phase
7): a real MCP client connects to a real upstream server, and the gateway
re-exposes that upstream's tools byte-identically except for the
`{upstreamId}__` name prefix — the one deliberately non-transparent piece
of this proxy.

**Steps taken:** First cut used `McpServer.registerTool(name, {
description, inputSchema }, handler)`, passing the upstream's own raw
`inputSchema` (a JSON-Schema object, exactly what `tools/list` returns)
straight through. Typechecking failed. Read
`server/zod-compat.d.ts`: `AnySchema = z3.ZodTypeAny | z4.$ZodType` —
`registerTool`'s `inputSchema` must be an actual Zod schema instance (v3 or
v4), not a plain JSON-Schema object. There is no documented adapter from a
raw JSON-Schema `Tool.inputSchema` to `AnySchema`.

**Expected versus actual:** Expected `McpServer.registerTool` to accept the
same JSON-Schema shape `tools/list` reports, since that is the wire format
every MCP tool definition is actually expressed in. Actual: it only accepts
Zod, so a byte-transparent proxy cannot use `McpServer` for the tools it
re-exposes — it would have to either lossy-convert an arbitrary upstream's
JSON-Schema into Zod at runtime, or hand-author a Zod schema per tool,
neither of which is transparent.

**Severity:** major — this determined the gateway's core architecture, not
a workaround at the margins. Anyone assuming `McpServer` is the right level
for a passthrough/proxy server (a reasonable assumption — it's the
"quick start" API and every SDK example server uses it) will hit this on
the first upstream whose tool schema isn't hand-authored Zod.

**Workaround:** Used the low-level `Server` class instead (`@deprecated ...
Only use Server for advanced use cases` — a proxy re-exposing arbitrary
upstream schemas unmodified is exactly that case). `Server.setRequestHandler`
against `ListToolsRequestSchema`/`CallToolRequestSchema` works directly with
plain JSON-RPC request/response shapes — the upstream's tool objects pass
through with only `name` rewritten, and `tools/call` forwards the raw
`arguments` object to the upstream client's own `callTool`. See
packages/gateway/src/upstreamProxy.ts.

**Actionable suggestion:** Phase 8's upstream pool (packages/upstream)
inherits this same constraint — budget for `Server`, not `McpServer`, from
the start rather than rediscovering this mid-phase. Worth a short note in
`docs/DECISIONS.md` alongside the MCP App go/no-go entry, since both are
"the high-level API doesn't cover this project's actual use case" findings
about the same SDK.

---

## Entry 012 — 2026-09-13 (thin: see audit note at top)

**Task attempted:** Connect the gateway's upstream client
(`StreamableHTTPClientTransport` + `Client.connect`) inside
packages/gateway/src/upstreamProxy.ts.

**Steps taken:** `pnpm typecheck` after wiring the connection.

**Expected versus actual:** Expected this to typecheck cleanly — the
client-side transport looked like ordinary SDK usage. Actual: the same
`exactOptionalPropertyTypes` mismatch packages/mcp-app/src/spike-server.ts
already found on the *server*-side `StreamableHTTPServerTransport`
(TS2379, `sessionId`) also applies to the *client*-side
`StreamableHTTPClientTransport` — its `sessionId` is a getter typed
`string | undefined`, wider than the exact-optional `sessionId?: string`
the shared `Transport` interface requires. Both sides of the same
transport pair share the same root cause; this had not been confirmed for
the client side until this phase.

**Severity:** minor — same fix as before (`as Transport` with a comment
citing the exact field and SDK version), just a second instance of it.

**Workaround:** `await upstreamClient.connect(clientTransport as Transport)`,
documented inline in upstreamProxy.ts.

**Actionable suggestion:** Phase 8's upstream pool will construct many of
these client transports (one per pooled upstream connection) — worth
pulling the cast into a tiny shared helper at that point instead of
copy-pasting the same comment a third and fourth time.

---

## Entry 013 — 2026-09-14

**Task attempted:** Build `packages/upstream`'s `UpstreamPool.callTool`
(Phase 8) with the declared return type `Promise<CallToolResult>`, calling
the pooled `Client.callTool(params, CallToolResultSchema, options)`
underneath, per this phase's own prompt — which explicitly says to pass
`CallToolResultSchema`, not `CompatibilityCallToolResultSchema`.

**Steps taken:** `pnpm --filter @chaperone/upstream build`. Read
`client/index.d.ts`'s `callTool` declaration directly (this repo's own
"verify rather than remember" rule) to confirm the return type before
assuming a cast was the only fix.

**Expected versus actual:** Expected `tsc` to narrow the return type to
`CallToolResult` because `CallToolResultSchema` (not the compat one) was
passed as the second argument. Actual: `TS2322` — `callTool`'s declared
signature is `callTool(params, resultSchema?: typeof CallToolResultSchema |
typeof CompatibilityCallToolResultSchema, options?): Promise<{...}>` where
the return type is a **fixed, non-generic** union of
`CallToolResult | { toolResult: unknown; ... }` (the 2024-10-07 legacy
shape), regardless of which schema value is actually passed at the call
site. The method isn't overloaded per-argument, so TypeScript has no way to
narrow it even though the runtime behavior is fully determined by which
schema you pass.

**Severity:** minor. Purely a typing gap — passing `CallToolResultSchema`
explicitly does guarantee the legacy branch can never be produced at
runtime — but it cost time to confirm this wasn't a real ambiguity before
reaching for a cast.

**Workaround:** `(await handle.client.callTool(params, CallToolResultSchema,
options)) as CallToolResult`, with a comment in `packages/upstream/src/pool.ts`
citing the exact `.d.ts` shape and SDK version, so a future reader doesn't
mistake this for an unverified "trust me" cast.

**Actionable suggestion:** `Client.callTool`'s TypeScript signature should
be generic/overloaded on the `resultSchema` parameter (return
`CallToolResult` when `CallToolResultSchema` is passed, the compat union
only when `CompatibilityCallToolResultSchema` is passed) — the runtime
already branches on this value; the types should too.

---

## Entry 014 — 2026-09-14 (thin: see audit note at top)

**Task attempted:** Forward a downstream `tools/call`'s `progressToken`
upstream from `packages/upstream/src/pool.ts`, so a resident-side progress
subscription actually reaches the real upstream tool call, per this
phase's own `CallContext.progressToken` field.

**Steps taken:** Read `shared/protocol.js`'s `request()` implementation
directly before writing the forwarding logic, since the prompt's own
friction-log convention here is to verify SDK internals rather than assume
them.

**Expected versus actual:** Expected `options.onprogress` combined with a
`_meta.progressToken` I set myself in the outgoing request `params` to
carry my chosen token value upstream. Actual: when `options?.onprogress` is
set, `request()` unconditionally **overwrites** `params._meta.progressToken`
with its own internally generated `messageId` (`jsonrpcRequest.params =
{...request.params, _meta: {...(request.params?._meta || {}),
progressToken: messageId}}`) — any token value the caller pre-set in
`params._meta` is discarded. The callback that eventually fires is also
invoked with the token already stripped back out
(`const { progressToken, ...params } = notification.params; handler(params)`),
so the SDK's own progress-correlation plumbing is entirely internal and
opaque to the caller by design.

**Severity:** minor — this determined a real design choice (see the
`callTool` comment in `pool.ts`) rather than blocking anything, but it's
exactly the kind of "the two hops don't literally share a token value"
detail that's invisible until you read the source.

**Workaround:** Stopped trying to make the literal upstream-bound
`progressToken` match the downstream's own token. Instead: only request
progress from upstream at all when the downstream supplied a token
(`ctx.progressToken !== undefined`), and re-attach the **downstream's own**
token when relaying each received progress notification back down. The
upstream-bound token is connection-scoped SDK plumbing private to that hop;
what must survive the hop is the subscription itself and the caller's own
token on the way back, not a shared literal value.

**Actionable suggestion:** None for the SDK — this is a deliberate,
reasonable internal design (progress tokens are request-scoped
correlation ids, not meant to be caller-supplied). Worth flagging for
anyone building a multi-hop proxy from scratch: don't assume a
`progressToken` is a value you can pass through byte-identical across
hops the way `arguments` or `content` are.

---

## Entry 015 — 2026-09-14

**Task attempted:** Assert `tools/call`/`initialize` response shapes in
`spec/conformance.spec.test.ts` using raw `fetch()` + `res.json()` against
both the gateway and `demo-upstream` directly — deliberately avoiding the
SDK `Client` for these specific assertions so the test could also inspect
raw headers (`MCP-Protocol-Version`, `Mcp-Session-Id`) alongside the body.

**Steps taken:** Ran `pnpm spec`. When `res.json()` failed, read
`server/webStandardStreamableHttp.js`'s `writeSSEEvent` directly rather
than guessing at a workaround.

**Expected versus actual:** Expected every successful (2xx) POST response
to be a flat `application/json` body, since the request declared
`Accept: application/json, text/event-stream` (both required — see Origin
and Accept-header assertions elsewhere in this suite) and the request
itself was a single, non-streaming call. Actual: `SyntaxError: Unexpected
token 'e', "event: mes"... is not valid JSON` — `StreamableHTTPServerTransport`
answers with `Content-Type: text/event-stream` and wraps the JSON-RPC
response in an SSE frame (`event: message\ndata: {...}\n\n`) even for a
single, immediately-resolvable request; only *error* responses that are
rejected before reaching the transport at all (bad Origin, unknown session,
malformed JSON) are guaranteed flat JSON, because those are written by this
repo's own Express middleware, not by the SDK transport.

**Severity:** minor. Every assertion using raw `fetch` against a
successful response needed the same fix, so it cost more time than a
single occurrence would have, but the fix is small and now shared.

**Workaround:** Added `readJsonRpcBody(res)` to `spec/conformance.spec.test.ts`:
checks `Content-Type`, and for `text/event-stream` extracts the JSON from
the first `data:` line rather than assuming a flat body. Every raw-fetch
helper in that file (`rawInitialize`, `rawSessionRequest`) now goes through
it instead of `res.json()`.

**Actionable suggestion:** Anyone writing raw-HTTP conformance tests
against a Streamable HTTP server (rather than using the SDK `Client`,
which already handles this) should not assume a 2xx JSON-RPC response is
flat JSON just because the request wasn't obviously "streaming" — the
transport's own choice of response format isn't something the caller
controls or can predict from the request shape alone.

---

## Entry 016 — 2026-09-14 (thin: see audit note at top)

**Task attempted:** Assert `pnpm spec`'s "malformed JSON returns -32700"
conformance behaviour — required by this phase's own prompt — against the
gateway built in Phase 7/8 (`packages/gateway/src/app.ts`).

**Steps taken:** Wrote the assertion first (POST a body that fails
`JSON.parse`, expect JSON-RPC code `-32700`), ran `pnpm spec`, and traced
the actual response before assuming the test was wrong.

**Expected versus actual:** Expected the existing catch-all Express error
handler to already produce this, since some JSON-RPC error was clearly
being returned. Actual: the handler unconditionally mapped every caught
error to the generic `-32603` Internal Server Error — including the one
case JSON-RPC has its own reserved code for. `express.json()` throws a
genuine `SyntaxError` (verified against the installed `body-parser@2.3.0`'s
`lib/read.js`, which wraps the parse failure via `createError(400, err,
{type: err.type || 'entity.parse.failed'})`, preserving the original
`SyntaxError` instance rather than replacing it) but nothing downstream was
distinguishing "the body wasn't valid JSON" from any other unhandled
failure.

**Severity:** minor — a genuine, if narrow, correctness gap the phase's
own written-first conformance suite caught before it shipped, which is
the point of writing the suite before declaring the proxy done.

**Workaround:** `app.ts`'s error-handling middleware now checks
`error instanceof SyntaxError && (error as {type?: string}).type ===
"entity.parse.failed"` before falling through to the generic 500/-32603
path, and responds `400` with JSON-RPC code `-32700` instead.

**Actionable suggestion:** None for the SDK or body-parser — this is a
gap in this repo's own error-handling middleware, now closed. Worth a
general note for future phases: a "catch-all maps to one generic code"
error handler is exactly the kind of thing a written-in-advance spec
assertion (rather than only informal manual testing) is good at
surfacing, since nobody manually tests malformed JSON on the happy path.

---

## Entry 017 — 2026-09-14

**Task attempted:** Run this phase's literal Docker-based VERIFY step —
`docker compose up -d`, then `docker compose stop demo-upstream` mid-suite
and `curl` the gateway directly to confirm `tools/list` degrades to an
empty array within 3 seconds — in this development sandbox.

**Steps taken:** Confirmed `docker --version` and `docker compose version`
both report real versions on `PATH` (v29.7.2 / v5.5.1). Ran
`docker compose up -d --build`. Checked for a running Docker daemon
(`Get-Process` for anything named `*docker*`) and for a Docker Desktop
install at its standard path
(`C:\Program Files\Docker\Docker\Docker Desktop.exe`) and via
`Get-ChildItem 'C:\Program Files'`/`Get-Service` for anything Docker-named.

**Expected versus actual:** Expected a working daemon, since the CLI
binaries are present and this repo's own `docker-compose.yml` assumes
Docker is available (per friction-log Entry 003, which hit and resolved
this exact class of problem in an earlier session). Actual:
`docker compose up` failed immediately with `failed to connect to the
docker API at npipe:////./pipe/dockerDesktopLinuxEngine ... The system
cannot find the file specified`, and no Docker Desktop installation or
running daemon process exists on this machine at all — a different, more
total, gap than Entry 003's (that session had Docker Desktop installed but
hit a JDK/DynamoDB Local–specific failure; this sandbox has the `docker`
CLI on `PATH` with nothing backing it).

**Severity:** major, for verification only — not a defect in the delivered
code. The identical behaviour this manual step checks is exercised
end-to-end by `pnpm spec`'s own "fails closed to an empty tools/list within
the per-upstream budget when the upstream goes down" assertion (25/25
passing), which kills a real (in-process, not Docker) upstream HTTP server
mid-test and asserts against the same `packages/upstream`/`packages/gateway`
production code path. What could not be run here specifically is the
containerized deployment path and the literal `curl` against a
`docker compose`-managed gateway.

**Workaround:** None available in this sandbox. The automated spec
assertion is a reasonable substitute for the underlying claim (fail-closed,
bounded-time degradation), but it is not a substitute for actually
verifying the Docker images build and run correctly together — that
remains unverified this session and should be re-run on a machine with a
working Docker daemon before treating the Docker deployment path itself as
confirmed.

**Actionable suggestion:** Before the next phase that depends on the
Docker Compose stack (or before recording it in `docs/RUNBOOK.md` as
verified), run this phase's literal VERIFY block on a machine with Docker
Desktop actually installed and running, not just the CLI present on
`PATH`.

**Update, later session (2026-09-14):** Docker Desktop was actually
installed on this machine the whole time — the daemon simply wasn't
running when the checks above were done, which is a narrower, more
mundane problem than what this entry originally concluded
("no Docker Desktop installation ... exists on this machine at all"). That
conclusion was wrong: `Get-Process`/`Get-Service`/`Get-ChildItem` checks
that should have found a stopped-but-installed Docker Desktop apparently
didn't surface it, and I reported "not installed" rather than "installed,
not running" without a more targeted check (e.g. the Docker Desktop
service name specifically, or attempting to launch it) to tell the two
apart. Once the daemon was started (outside this session), `docker version`
reported a real, running `Server: Docker Desktop 4.90.0` backend and the
literal VERIFY block ran clean end to end:

- `docker compose up -d --build` — both images build and all three
  containers (`ddb`, `demo-upstream`, `gateway`) start and stay up.
- A real `initialize` against the running gateway issues a session id and
  a real `tools/list` on it returns all four `grocery__*` tools.
- `docker compose stop demo-upstream`, then `tools/list` on that same
  session: `{"result":{"tools":[]}}`, HTTP 200, ~3.1s wall time (matching
  `LIST_TOOLS_TIMEOUT_MS`) — no hang, no 500. Gateway's own log:
  `"tools/list failed for upstream; excluding from fan-out"` at warn level,
  naming the upstream, not a silent failure.
- `docker compose start demo-upstream`, then `tools/list` again on the
  *same* session: this actually caught a real bug the earlier
  spec-suite-only verification hadn't (see Entry 018) — fixed, then
  re-verified clean: all four tools return again, in ~60–200ms, with the
  gateway's log showing a fresh `"connected to upstream"` line rather than
  the failed upstream staying silently excluded forever.

The containerized deployment path is now genuinely confirmed, not just
substituted for. The corrected general lesson: "the CLI reports a version"
is not evidence a daemon is reachable, and "I didn't find an install" from
a few targeted filesystem/process checks is weaker evidence than it reads
as — the honest conclusion at the time should have been "daemon
unreachable, cause undetermined" rather than asserting no installation
existed.

---

## Entry 018 — 2026-09-14

**Task attempted:** Completed the Entry 017 update above — restarting
`demo-upstream` mid-VERIFY and confirming the gateway recovers, not just
degrades gracefully while the upstream is down.

**Steps taken:** After `docker compose start demo-upstream`, called
`tools/list` again on the session that had been live since before the
outage. Read the gateway's own structured logs for each step rather than
trusting the HTTP status alone.

**Expected versus actual:** Expected the pool to notice the upstream was
back and transparently reconnect. Actual, on the first re-run: `tools/list`
kept returning `{"tools":[]}` in ~90ms — fast, not the 3s timeout, but
still empty — and stayed that way; the pool had gotten permanently stuck
excluding "grocery" from every future `tools/list`, not just the one call
during the outage. Root-caused to two compounding bugs in
`packages/upstream/src/pool.ts`, both only reachable by a connection that
was genuinely `ready` and then died mid-life (not merely never connected,
which is all `pnpm spec`'s in-process suite had exercised):
1. `listToolsForUpstream` never caught a `listTools()`-level failure and
   called `markFailed` the way `callTool` already did — so a handle that
   went bad after `ensureConnected` reported it `ready` just stayed
   `"ready"` forever, and every subsequent call kept reusing the same
   dead session instead of ever attempting a fresh connect.
2. Once fixed to call `markFailed`, the *next* connect attempt threw
   "Already connected to a transport. Call close() before connecting to a
   new transport..." (`Protocol.connect`, shared/protocol.js) — the
   client's internal `_transport` was still set to the old, silently-dead
   transport, because nothing had ever called `client.close()` on it. That
   guard only auto-clears on a failure *during* `Client.connect()` itself
   (verified in Entry 013's investigation); a connection that died later,
   outside of `connect()`, leaves it set.

**Severity:** major — a real, user-visible defect this phase's own written
report had not actually verified, because the in-process spec suite's
"upstream down" fixture was always dead from the start and never
transitioned live → dead → live-again-as-a-different-process on the same
handle. A resident's household assistant would have silently and
permanently lost a tool the moment its upstream server restarted once,
recoverable only by restarting the gateway itself.

**Severity of the earlier report being wrong:** the phase's prior summary
claimed 25/25 spec assertions plus an in-process substitute "confirms the
same production code path" as the Docker VERIFY step. That claim was true
for the *going-down* half of the behaviour and silently false for the
*coming-back-up* half, because no assertion (automated or manual) had
actually exercised recovery until this session's real Docker run forced
it.

**Workaround:** Fixed both root causes in `packages/upstream/src/pool.ts`:
`listToolsForUpstream` now catches its own `listTools()` failure and calls
`markFailed(handle)`, symmetric with `callTool`; `attemptConnect` now
calls `await handle.client.close()` unconditionally before building the
fresh transport and reconnecting (a safe no-op on a never-connected
client, since `Protocol.close()` is `this._transport?.close()`). Added a
regression test,
`packages/upstream/test/pool.test.ts` → "recovers after an already-ready
upstream restarts with a fresh session, rather than staying permanently
stuck", which kills and restarts a real HTTP server on the same port
mid-test and asserts the pool excludes it once, then recovers. Re-ran the
full local suite (`pnpm test`: 235/235, `pnpm spec`: 25/25,
`pnpm typecheck`/`lint`/`depcruise`: clean) and the full literal Docker
VERIFY sequence end to end again after the fix — see Entry 017's update.

**Actionable suggestion:** For any future connection-pooling code in this
repo (or anywhere): a fixture that is "always dead" is not a substitute
for one that is "alive, then dies, then a fresh peer comes back on the
same address" — the two exercise genuinely different code paths (initial
connect failure vs. recovering a handle the pool itself believes is
healthy), and only the second one catches a stuck-forever bug like this.
Prefer testing recovery, not just degradation, for anything that pools or
caches a connection.

## Entry 019 — 2026-09-14

**Task attempted:** Phase 9, resumable SSE. Wired `packages/gateway/src/event-store.ts`
(a `@modelcontextprotocol/sdk` `EventStore` over the `sse-event` DynamoDB
table) into `session.ts`, backed by a new `nextSseSeq` atomic counter in
`packages/ledger/src/repos/sseEvent.ts`, then ran the mandated real
`docker compose up -d` stack (not the in-process, ledger-mocked `pnpm spec`
suite) to execute the actual VERIFY commands.

**Steps taken:** `pnpm --filter @chaperone/ledger test` (a unit test using
`aws-sdk-client-mock`) passed. `pnpm typecheck`/`lint`/`depcruise` were all
clean. Then `docker compose up -d --build` and a plain `curl -X POST
.../mcp` `initialize` against the real gateway and real DynamoDB Local.

**Expected versus actual:** Expected the same `initialize` response the
in-process suite already gets. Actual: every request that touched
`nextSseSeq` — meaning every request, since `writePrimingEvent` calls
`storeEvent` on the very first SSE response — came back
`-32700 Parse error: ValidationException: Invalid UpdateExpression:
Attribute name is a reserved keyword; reserved keyword: ttl`. `ttl` is a
DynamoDB reserved word; the `UpdateExpression` (`"ADD nextSeq :incr SET
ttl = if_not_exists(ttl, :ttl)"`) used the bare attribute name instead of
an `ExpressionAttributeNames` alias. `aws-sdk-client-mock` doesn't validate
expression syntax against DynamoDB's reserved-word list at all, so the
mocked unit test for this exact function passed cleanly while the
real-DynamoDB path was 100% broken — every single request, not an edge
case.

**Severity:** major, but narrowly averted: this repo already has the fix
pattern one file away (`packages/ledger/src/repos/session.ts`'s
`touchSession` aliases `ttl` as `#ttl` for exactly this reason), and
CLAUDE.md's own working-style rule ("run the acceptance commands yourself
... paste the real output") is what caught it — a session that stopped at
the green mocked unit test and the clean `pnpm typecheck` would have
shipped a gateway that 400s on every single request against real
DynamoDB.

**Workaround:** Changed the `UpdateExpression` to `"ADD nextSeq :incr SET
#ttl = if_not_exists(#ttl, :ttl)"` with `ExpressionAttributeNames: {"#ttl":
"ttl"}`, matching `touchSession`'s existing pattern. Updated the unit
test's expectation to match, rebuilt the `gateway` and `demo-upstream`
Docker images, and re-ran `initialize` — confirmed a clean priming event
plus real result, then ran the full 10-iteration `pnpm test:resume` loop
and the literal `aws dynamodb query` from CLAUDE.md's VERIFY block against
the live table (see this phase's completion summary).

**Actionable suggestion:** `aws-sdk-client-mock` cannot catch a reserved
DynamoDB keyword used bare in an `UpdateExpression`/`ConditionExpression`,
a missing `ExpressionAttributeNames` alias, or any other AWS-API-level
validation error — it only proves the function calls the SDK with roughly
the right shape, not that DynamoDB itself would accept it. Any new
`UpdateExpression`/`ConditionExpression` string in `packages/ledger`
should be smoke-tested against a real DynamoDB Local at least once before
being declared done, the same way this phase's own CLAUDE.md instructions
already require for the ledger package generally — a purely mocked green
suite is not sufficient evidence for this class of bug.

## Entry 020 — 2026-09-14

**Task attempted:** Same Phase 9 session as Entry 019. Wrote
`spec/long-stream.test.ts` — a ~180s held-open SSE stream against the real
gateway, driven through `@modelcontextprotocol/sdk`'s own `Client` (not the
raw HTTP client in `spec/lib/rawMcpClient.ts` that the resumption test
uses), asserting no disconnect across 36 progress checkpoints 5s apart.

**Steps taken:** Ran it against the real `docker compose up -d` gateway
(the same stack Entry 019 fixed) via `pnpm test -- spec/long-stream.test.ts`.

**Expected versus actual:** Expected the call to complete after ~180s with
36 progress notifications observed. Actual: it failed at exactly 60.4s with
`MCP error -32001: Request timed out`, thrown client-side from
`shared/protocol.ts`'s `Timeout.timeoutHandler` — nothing to do with the
gateway, the ALB-idle-timeout risk this test exists to guard against, or
`track_delivery` itself, all of which were still running fine server-side.
Root cause: `@modelcontextprotocol/sdk`'s `Client`/`Protocol.request()` has
its own client-side per-request timeout,
`DEFAULT_REQUEST_TIMEOUT_MSEC = 60000` (60s), applied regardless of how
long the *server* is willing to keep the stream open — verified against
`shared/protocol.d.ts`'s `RequestOptions`. `spec/conformance.spec.test.ts`'s
existing progress test never surfaces this because `track_delivery`'s
default duration (4 checkpoints × 150ms ≈ 0.6s) is nowhere near 60s.

**Severity:** major for this specific test (it could never pass as
written, at any real duration past a minute, regardless of transport or
ALB behaviour) but zero product impact — this is a client-side ceiling in
the test's own SDK client, not the gateway.

**Workaround:** Passed `timeout: TOTAL_DURATION_MS + 30_000` and
`resetTimeoutOnProgress: true` in the `callTool` `RequestOptions` — the
latter means each of the 36 real progress notifications re-arms the
client's timeout, so a stalled *connection* still times out promptly while
a call that is making real, periodic progress does not, which is the
actually-correct behaviour for this test to assert against (it should fail
fast on a genuine hang, not only after the full nominal duration). Re-ran:
passed in ~180s with all 36 progress values observed in order.

**Actionable suggestion:** Any test (or production code) driving the MCP
SDK's `Client` through a call expected to run longer than 60 real seconds
must set `timeout` (and almost always `resetTimeoutOnProgress: true` for a
call that reports progress) explicitly — the 60s default is a client-side
request-level ceiling completely independent of transport keep-alive,
server processing time, or any infrastructure timeout being tested. Easy
to miss because nothing about the failure mode (`MCP error -32001: Request
timed out`) points at the client's own default rather than the thing the
test was actually trying to exercise.

## Entry 021 — 2026-09-14

**Task attempted:** Same Phase 9 session as Entries 019–020. Re-ran
`spec/long-stream.test.ts` after Entry 020's fix (raising the *test's own*
client timeout).

**Steps taken:** `pnpm test -- spec/long-stream.test.ts` against the real
`docker compose up -d` stack.

**Expected versus actual:** Expected the call to now run the full ~180s.
Actual: still failed at ~60.6s — but this time as a clean `isError: true`
tool result (the frozen `REFUSAL_UPSTREAM_UNAVAILABLE` text from
`upstreamProxy.ts`'s `catch` block), not a client-side `McpError -32001`.
Different failure shape, same 60s number, which is what made this a second
bug rather than the first one incompletely fixed: the *test's* client
(test → gateway) now had a raised timeout, so this had to be a *second*,
independent 60s ceiling on the *gateway's own* client (gateway →
demo-upstream). Found it in `packages/upstream/src/pool.ts`'s `callTool`:
`const options: RequestOptions = { signal: ctx.signal }` — no `timeout`
override, so this internal hop also fell back to the SDK's
`DEFAULT_REQUEST_TIMEOUT_MSEC` (60s), independent of the downstream-facing
resumability work this whole phase is about. This is not a test artifact —
it means *any* real upstream tool call genuinely taking longer than 60s
would have failed inside the gateway in production, resumable SSE or not,
regardless of how the demo/test client behaved.

**Severity:** major — a real product-code bug (not test-only, unlike Entry
020), and one Phase 9's own headline feature (resumable SSE surviving a
long-running call) would have silently defeated itself on any call slower
than a minute.

**Workaround:** Added `CALL_TOOL_TIMEOUT_MS` (10 minutes) and
`resetTimeoutOnProgress: true` to `pool.ts`'s `callTool` `RequestOptions`,
mirroring the same reasoning as Entry 020 — the proxy has no agent loop and
no SLA of its own to enforce (CLAUDE.md), so the real cancellation
authority stays `ctx.signal` (a genuine downstream cancel or transport
close) rather than an arbitrary client-side ceiling copied from the SDK's
default. Rebuilt the `gateway` Docker image and re-ran: passed at ~180s
with all 36 progress values observed in order.

**Actionable suggestion:** A timeout-related bug at a fixed hop (here, the
SDK client's `DEFAULT_REQUEST_TIMEOUT_MSEC`) tends to recur at *every* hop
that uses the same client library, not just the one first noticed — this
proxy has (at least) two independent SDK `Client` instances in the request
path (test → gateway, gateway → upstream), each with its own default
timeout, and fixing one told us nothing about the other. Any future
multi-hop MCP proxy work in this repo should audit every `Client.request`/
`callTool`/etc. call on the request path for its own `timeout` /
`resetTimeoutOnProgress`, not assume fixing the outermost hop covers the
inner ones.

## Entry 022 — 2026-09-14

**Task attempted:** Same Phase 9 session. Ran this phase's own literal
VERIFY command, `pnpm test -- spec/long-stream.test.ts`, expecting it to
run only that one ~180s file (per the comment next to it: `# expect: pass,
~180s`).

**Steps taken:** Ran it against the live `docker compose up -d` stack.
Also independently isolated the mechanism with `pnpm run echoargs -- foo
--bar baz` against a one-line diagnostic script (`console.log(JSON.stringify(
process.argv.slice(2)))`) and with `pnpm exec vitest list -- spec/long-stream.test.ts`.

**Expected versus actual:** Expected only `spec/long-stream.test.ts` to
run. Actual: the entire suite ran — all `packages/*/test` files plus both
`spec/resumption.test.ts` and `spec/long-stream.test.ts`, ~230s total, not
~180s. Root cause, confirmed by the diagnostic script: this repo's pinned
`pnpm@12.4.1` does **not** strip the `--` separator before forwarding args
to a script — `pnpm run echoargs -- foo --bar baz` prints
`["--","foo","--bar","baz"]`, the literal `--` included. vitest's CLI
(`cac`) then receives that stray `"--"` as one of its own positional
arguments alongside the real filter and — confirmed independently of pnpm
via `pnpm exec vitest list -- spec/long-stream.test.ts`, which shows the
same "lists everything" behaviour — stops applying the file-path filter
entirely rather than erroring or ignoring the empty token. `pnpm test
spec/long-stream.test.ts` (no `--` at all) forwards and filters correctly;
pnpm auto-forwards trailing positional args to the script without needing
a separator, unlike npm.

**Severity:** minor — the command still ran to a real, honest pass (the
whole suite is not incompatible with itself; nothing else in
`packages/*/test` touches the live Docker `demo-upstream`, so no cross-
contamination occurred in this single, otherwise-uncontaminated
invocation), so nothing shipped broken. But it silently does ~30% more
work than its own comment promises, and burned real debugging time this
session tracing what looked at first like a resumption-suite regression
(see the false alarm below) before the diagnostic script isolated it to
`pnpm`+`vitest` argument handling.

**False alarm this caused:** an *earlier*, genuinely contaminated run
looked like a real regression — `spec/resumption.test.ts` failed
"iteration 1: expected exactly one place_order invocation... expected 2 to
be 1" — but that was this session running `pnpm test -- spec/long-stream.test.ts`
in the background (which, per the above, silently also runs
`spec/resumption.test.ts`) at the same wall-clock time as a separate,
manually-launched `pnpm test:resume` in the foreground — two independent
processes racing real HTTP calls against the one shared `demo-upstream`
Docker container's place-order invocation counter. Re-running cleanly,
without a second concurrent invocation touching the same container,
reproduced neither failure. The resumption/exactly-once logic itself was
never at fault; recorded here so a future session doesn't have to
rediscover this red herring from scratch.

**Workaround:** None applied to the repo's scripts — `pnpm test:resume`
(package.json) already avoids the problem by not using `--` at all. This
phase's own VERIFY text is the task-giver's, not this repo's, so it isn't
this session's place to rewrite it; documented here instead so a future
session (or a person running it) understands why the command legitimately
takes longer than advertised and isn't a regression, and to warn against
ever running two `pnpm test*` invocations against the shared Docker stack
concurrently — that part *is* a real hazard, independent of the `--` bug.

**Actionable suggestion:** Never invoke this repo's vitest-backed scripts
via `pnpm <script> -- <filter>` — the `--` is unnecessary (pnpm forwards
trailing positional args to the script on its own) and, on this pinned
pnpm version, actively breaks vitest's file filtering. Use `pnpm <script>
<filter>` instead. If a task's own instructions specify the `--` form
verbatim, expect it to run the full suite rather than just the named file
— slower and noisier, but not incorrect, as long as no second
Docker-touching test process is started concurrently.

---

## Entry 023 — 2026-09-14

**Task attempted:** Phase 10 — register `chaperone/approve_change` and
`chaperone/pending_changes` as first-party tools on the gateway's own
`Server` instance (the same low-level class `packages/gateway/src/
upstreamProxy.ts` already uses for the pooled-upstream passthrough,
per Entry 011), and have the approval flow rely on the declared
`inputSchema` to keep bad calls from ever reaching `approveChange`.

**Steps taken:** Read `Server.setRequestHandler` in `@modelcontextprotocol/
sdk@1.30.0`'s `server/index.d.ts` (the exact version pinned in this repo,
same one Entry 011/012/018 already verified against) and compared it
against `McpServer.registerTool` in `server/mcp.d.ts`, which is what
`packages/demo-upstream` uses for its own three tools.

**Expected versus actual:** Expected `tools/call` argument validation
against a tool's declared `inputSchema` to be a property of the MCP
*server* concept generally, independent of which SDK class exposes it —
i.e., that registering `chaperone/approve_change` with a JSON-Schema
`inputSchema` naming `quarantineId`/`approvalToken`/`decision` as
`required` would be enough to keep a malformed call from ever reaching the
handler. Actual: only `McpServer.registerTool` does this (it builds a Zod
schema from the tool's shape and parses `request.params.arguments` against
it before invoking the handler — visible in `mcp.d.ts`'s `RegisteredTool`
callback signature, which receives already-validated, typed args). The
low-level `Server` class's `setRequestHandler(CallToolRequestSchema,
handler)` validates only the JSON-RPC envelope shape (that `arguments` is
present as *some* object, per `CallToolRequestSchema`) and hands the
handler `request.params.arguments: Record<string, unknown> | undefined`
completely unvalidated against the tool's own `inputSchema` — the schema
declared in `tools/list` is purely descriptive metadata on this class, not
an enforced contract.

**Severity:** minor. Not a blocker — the fix is a few lines of manual
`typeof` checks (`packages/gateway/src/firstPartyTools.ts`'s
`parseApproveChangeArgs`) — but it is exactly the kind of assumption that
would have shipped a genuine input-validation gap (CLAUDE.md's "validate
at every boundary") if this repo hadn't already deliberately committed to
the low-level `Server` class for the upstream passthrough, and only
noticed the gap by cross-reading `mcp.d.ts` for comparison rather than by
being warned anywhere in `Server`'s own types or docs.

**Workaround:** `firstPartyTools.ts` hand-validates
`chaperone/approve_change`'s three arguments before calling into
`approveChange`, returning `isError: true` with a plain descriptive
message (not a thrown, taxonomy error — there is no failure *state* here,
just a malformed *request*) rather than trusting the declared
`inputSchema` to have done anything.

**Actionable suggestion:** Any future first-party tool registered on this
gateway's `Server` instance needs the same explicit manual validation —
there is no shortcut via a shared Zod-to-low-level-Server adapter in the
SDK as installed. If a later phase adds a third or fourth first-party
tool, factor the "parse `unknown` args against a declared shape, return a
typed ok/err result" pattern out of `parseApproveChangeArgs` rather than
re-deriving it per tool.

---

## Entry 024 — 2026-09-15

**Task attempted:** Ran this phase's own literal VERIFY sequence end to
end against a freshly rebuilt `docker compose` stack (real DynamoDB, real
demo-upstream, real gateway) rather than declaring done on the mocked test
suite alone: `pnpm pin:bootstrap`, `POST /control/mutate`, `tools/list`
over real curl, `tools/call` on the excluded tool, an `aws dynamodb scan`/
`query` against the real tables, `pnpm verify-ledger`, approve with the
token, replay it.

**Steps taken:** `docker compose down -v && docker compose build --no-cache
gateway demo-upstream && docker compose up -d`, then `pnpm ddb:migrate`
and `pnpm pin:bootstrap` against the exposed ports from the host. The
mocked suite (`packages/gateway/test/gate.test.ts`,
`packages/gateway/test/gateway.test.ts`, `packages/ledger/test/
quarantine.test.ts`) had already passed, all using either a hand-rolled
in-memory `@chaperone/ledger` mock or `aws-sdk-client-mock`'s fake
DynamoDB responses.

**Expected versus actual:** Expected the first `tools/call` against the
mutated tool to return the frozen refusal *and* the consent card (the
quarantine having just been created moments earlier, in the preceding
`tools/list`). Actual: the refusal came back with only the frozen text —
no second content block. The gateway's own logs showed why:
`listQuarantineByStatus` (`packages/ledger/src/repos/quarantine.ts`,
written in an earlier phase, before anything ever called it) builds its
`KeyConditionExpression` as the literal string `"status = :status"` with
no `ExpressionAttributeNames` alias. `status` is a DynamoDB reserved
keyword — real DynamoDB (and DynamoDB Local, which enforces the same
reserved-word table) rejects this with `ValidationException: Attribute
name is a reserved keyword`. `resolveQuarantine`, three functions below it
in the same file, already gets this right (`#status` in its
`UpdateExpression`) — the two functions had simply never been exercised
side by side before this phase made `listQuarantineByStatus` the first
real caller. `aws-sdk-client-mock` never caught this because it fakes the
SDK's response and never parses the expression string at all — a `Query`-
by-status test with `ddbMock.on(QueryCommand).resolves(...)` "passes"
against a request DynamoDB itself would reject outright.

**Severity:** major, and the specific reason this phase's instructions
insist on the live docker VERIFY rather than stopping at the mocked
suite. Every gate.ts call that hit a genuine mismatch was silently losing
its quarantine row and its one-time approval token — the tool still
stayed correctly withheld (the `allow()` verdict itself never depended on
this call), but the resident-facing consent card, and the
`chaperone/pending_changes` review queue, would have been permanently
empty in production. A demo relying on the approve flow would have had no
way to ever un-quarantine a tool.

**Workaround:** Fixed `listQuarantineByStatus` to alias `status` via
`ExpressionAttributeNames: { "#status": "status" }` and
`KeyConditionExpression: "#status = :status"`, matching `resolveQuarantine`'s
existing pattern. Updated `packages/ledger/test/quarantine.test.ts`'s
assertion to match the corrected (and now DynamoDB-valid) expression.
Rebuilt the gateway image and re-ran the full VERIFY sequence clean: tool
excluded, verbatim refusal plus a real consent card with the token,
`MISMATCH_DETECTED`/`TOOL_QUARANTINED`/`CONSENT_SHOWN` in the real ledger,
`pnpm verify-ledger` green, approve restores the tool with its new
description, and replaying the same token fails with
`QuarantineAlreadyResolvedError`'s message rather than a silent second
approval.

**Actionable suggestion:** `aws-sdk-client-mock`-based repo tests are not
sufficient proof that a `KeyConditionExpression`/`UpdateExpression`
string is valid DynamoDB syntax — they should be paired with, not
substituted for, a real DynamoDB Local run of any *new* query pattern
before it's trusted, and this phase's insistence on running the literal
docker VERIFY sequence (not just `pnpm test`) is why this was caught
before a demo take rather than during one. Any future repo function that
queries or updates by an attribute named after a common English word
(`status`, `type`, `name`, `size`, ...) should be grepped against
DynamoDB's reserved-word list before it ships, not discovered by a
`ValidationException` in a live container.

---

## Entry 025 — 2026-09-15

**Task attempted:** After crawl 1 ran for real (947 candidates, 152
booted), report the boot-rate finding sentence back to the user and, as a
same-session follow-up, promote that number into a standalone
`data/boot-rate.json` for Phase 16's bench package to read.

**Steps taken:** Copied `packages/crawler/scripts/crawl.ts`'s own printed
sentence verbatim into the first summary rather than re-deriving the
percentage from the underlying counts. When asked to write the same
number into `data/boot-rate.json` in a shape a future script could rely
on, recomputed the failure percentage independently from `booted` (152)
and `attempted` (291) as a sanity check before trusting the script's own
output a second time.

**Expected versus actual:** Expected `152/291 = 52.2%` to be consistent
with "52.2% did not start," since that was the number already printed and
already handed to the user as the finding sentence. Actual: `152/291 =
52.2%` is the **success** rate — 152 of 291 attempted servers booted
successfully. The **failure** rate ("did not start") is `100 - 52.2% =
47.8%` (139 of 291). `report.bootSuccessRate` (`packages/crawler/src/crawl.ts`)
is correctly named and correctly computed as `booted/attempted`; the bug
was entirely in `packages/crawler/scripts/crawl.ts`'s console output,
which printed that success-rate number next to failure-framed language
("did not start") without inverting it. The wrong sentence had already
been reported to the user as this project's headline finding one turn
earlier.

**Severity:** major — this is, in the user's own words, "one of the
strongest things in this project," and the number as first reported was
backwards by roughly 4.5 percentage points in the wrong direction (52.2%
instead of 47.8%), silently changing a success framing into a failure
framing with the same digits. It survived one full report to the user
uncaught, because the check was "does this sentence match what the script
printed," not "does this sentence match the arithmetic."

**Workaround:** Fixed `packages/crawler/scripts/crawl.ts` to compute
`didNotStartRate = 100 - report.bootSuccessRate` and print that, not
`report.bootSuccessRate` itself, next to the "did not start" wording.
Also relabelled that same script's `attempted:` distribution row, which
was printing `report.candidatesConsidered` (947, every candidate
considered including no-install-path ones) rather than `report.attempted`
(291, only those with a resolved install path) — a second, adjacent
mislabeling in the same block, caught while already in the file for the
rate bug. `packages/crawler/scripts/boot-rate.ts` (new) derives
`data/boot-rate.json` from a crawl report using the same corrected
formula, so the artifact and the console output can never diverge again.

**Actionable suggestion:** Never copy a script's printed sentence into a
report verbatim on the strength of "the script said so" — recompute the
headline number independently from the raw counts it claims to
summarize, every time, especially for a number explicitly flagged as
load-bearing. A percentage paired with English-language framing
("did/did not") is exactly the shape of bug that a `.toFixed(1)` call and
a plausible-sounding surrounding sentence will not catch on read-through;
only recomputing catches it.

---

## Entry 026 — 2026-09-15

**Task attempted:** Fix `.github/workflows/ci.yml`, which had been red
since Phase 9 because `spec/resumption.test.ts` and
`spec/long-stream.test.ts` need a live `docker compose` stack that CI
never started. Part of that fix is confirming every `spec/` test either
runs in CI or has a stated, honest reason it doesn't (rather than being
silently left out) — which meant actually running `pnpm spec`
(`spec/conformance.spec.test.ts`, the in-process MCP conformance suite)
for the first time since Phase 10 wired `gate.ts` into the request path.

**Steps taken:** Ran `pnpm spec` to confirm it was a safe, cheap
in-process addition to CI (no Docker needed) before wiring it in.

**Expected versus actual:** Expected 25/25 passing, since nothing in this
CI-fix task touches gateway request-handling logic. Actual: 10 of 25
failing. Root cause: `spec/conformance.spec.test.ts`'s `vi.mock("@chaperone/ledger",
...)` predates Phase 10 and never gained `getPin`/`putPin`/`createQuarantine`/
`getQuarantine`/`listQuarantineByStatus`/`resolveQuarantine`/`appendEvent` —
exactly the gap `packages/gateway/test/gateway.test.ts` was fixed for
during Phase 10 itself. Calling `ledger.getPin(...)` where `getPin` is
`undefined` throws, `gate.ts`'s own try/catch turns that into a silent
fail-closed deny, and every tool in the suite came back UNPINNED or
REFUSAL_TOOL_CHANGED instead of a real result. A second, independent
break, once the mock was fixed: the two new first-party tools
(`chaperone/approve_change`, `chaperone/pending_changes`) are
unnamespaced and always present, which broke three assertions written
before they existed — "every gateway tool starts with `{upstreamId}__`",
"stripping the prefix reconstructs the upstream's exact tool set", and
"tools/list goes empty when the upstream is down" all needed to filter
first-party tools out first, since those three properties were always
about upstream-sourced tools specifically, not the gateway's own surface.

**Severity:** major. This suite is Phase 8's 25+-assertion MCP
conformance suite — CLAUDE.md calls its output filmed footage for the
demo — and it had been silently broken for the entire span of Phase 10
and both crawl-1 sessions, because `pnpm spec` is not part of `pnpm test`
and nothing in that window ever ran it. The exact failure mode this
whole CI task exists to eliminate (a real problem invisible because the
check that would catch it never runs) was already present a second time,
in a different suite, for a different reason.

**Workaround:** Added the seven missing mock functions to
`spec/conformance.spec.test.ts` (same in-memory-map pattern as
`packages/gateway/test/gateway.test.ts`), added a `bootstrapPins()` helper
mirroring `pnpm pin:bootstrap`, passed the gateway's now-required
`householdId` argument, and updated the three tools/list assertions to
filter on `isFirstPartyTool` before checking upstream-namespace
properties. Added one new test asserting the first-party tools are
present, so their existence is asserted somewhere rather than only
implicitly relied upon. All 26 tests pass. `pnpm spec` is now wired into
CI (it's in-process, no Docker, effectively free to include).

**Actionable suggestion:** Any change to `packages/gateway/src/*` that
touches the request path — not just `packages/gateway/test/*` — needs
`pnpm spec` run before it's considered done, not only `pnpm test`. The
two suites mock `@chaperone/ledger` independently and can drift out of
sync with each other exactly like this. Consider a shared test helper
(a `buildMockLedger()` used by both files) so a future gate.ts change
only needs the mock updated once instead of twice, with the second site
silently rotting until someone happens to run it.

## Entry 027 — 2026-09-15

**Task attempted:** Phase 11 — promote the Phase 6 MCP App spike into the
gateway's real consent surface, per docs/DECISIONS.md's "Fix scoped: two
changes needed" (the `_meta["ui/resourceUri"]` tool linkage, and the real
`ui/initialize` → `ui/notifications/initialized` handshake in place of the
informal `@mcp-ui/server` `postMessage` convention). Before writing either,
pulled the actual `@modelcontextprotocol/ext-apps@1.7.5` tarball
(`npm pack`) rather than trusting docs/DECISIONS.md's own description of it
at face value, since that entry itself flags the exact SEP number and full
wire contract as unverified.

**Steps taken:** Extracted the tarball and read `dist/src/app.d.ts` and
`dist/src/spec.types.d.ts` directly (the package ships no changelog).
Confirmed `RESOURCE_URI_META_KEY = "ui/resourceUri"` and
`RESOURCE_MIME_TYPE = "text/html;profile=mcp-app"` match docs/DECISIONS.md
exactly. Then read `INITIALIZE_METHOD`/`INITIALIZED_METHOD`'s backing
interfaces for the exact request/notification param shapes, and
`server/index.d.ts` for `getUiCapability`/`EXTENSION_ID` — none of which
docs/DECISIONS.md had recorded, since the Phase 6 spike's time-box ended
before implementing the handshake at all.

**Expected versus actual:** Expected `_meta[RESOURCE_URI_META_KEY]` on the
tool definition to be this package's one, current way to link a tool to its
UI resource, per how the phase prompt and docs/DECISIONS.md both describe
it. Actual: the package's own JSDoc on `RESOURCE_URI_META_KEY` labels that
flat key **"Deprecated: for backwards compatibility"** and directs server
authors to a nested `_meta.ui.resourceUri` shape instead — a form that
does not appear anywhere in docs/DECISIONS.md's Phase 6 findings, because
the spike never got far enough to read this file. A host is documented to
check both forms, so nothing about the Phase 6 spike's diagnosis was wrong
— it just wasn't the complete current picture of the surface.

**Severity:** minor. Both forms round-trip through the same field on the
same object; this cost one extra read of the vendored `.d.ts`, not a design
change. Flagged because "verify rather than remember" (CLAUDE.md) applies
just as much to a prior *phase's own* verification as to memory of the SDK
in general — a decision record is evidence of what was true when it was
written, not a standing guarantee that nothing downstream of it moved.

**Workaround:** `packages/gateway/src/firstPartyTools.ts`'s
`APPROVE_CHANGE_TOOL._meta` sets both keys (`MCP_APP_RESOURCE_URI_META_KEY`
flat, and a nested `ui: { resourceUri }`) pointing at the same
`CONSENT_RESOURCE_URI_TEMPLATE`, so a host checking either form finds it.

**Actionable suggestion:** When a decision record cites an external
package's behavior as the basis for a scoped follow-up task (here: "budget
2-3 hours for two named changes"), the follow-up session should re-verify
against the actual installed/pinned version before implementing, not treat
the decision record's own description as sufficient — exactly the same
discipline CLAUDE.md already asks for the MCP SDK and Bedrock model IDs,
just not yet written down as applying to this repo's *own* prior
decisions too.

## Entry 028 — 2026-09-15

**Task attempted:** Live acceptance of the Phase 11 consent card against a
real, running stack (`docker compose up`, DynamoDB Local migrated and
seeded, demo-upstream mutated) and a real MCP Inspector 2.6.0 — both its
`--cli` mode and its `--web` UI's dedicated Apps tab, per the phase's
acceptance instruction to run the full mutate → refuse → card → approve →
restore loop and capture it.

**Steps taken:** In the web UI, opened the Apps tab, selected
`chaperone/approve_change` (confirmed listed under "MCP Apps (1)" — the
`_meta` linkage works), staged a real `quarantineId`/`approvalToken` in its
input form, and clicked "Open App."

**Expected versus actual:** Expected the staged `quarantineId` to be
substituted into the tool's `_meta.ui.resourceUri` template
(`ui://chaperone/consent/{quarantineId}`) before Inspector fetched it, so
the interactive card would render in the sandboxed app iframe. Actual: the
browser console showed `[mcp-app] failed to load UI resource into sandbox:
... "no quarantine \"{quarantineId}\" for this household"` — Inspector's
generic Apps-tab "Open App" affordance treats a tool's static
`_meta.ui.resourceUri` as a literal URI and requests it as-is; it does not
perform RFC 6570 template expansion using the staged input values. The
underlying `tools/call` to `chaperone/approve_change` *did* still fire
correctly with the staged arguments (confirmed via
`notifications/tools/list_changed` and a follow-up `tools/list` showing
`grocery__add_item` restored) — only the app iframe's own resource fetch
failed, not the tool invocation.

**Severity:** minor. This is a real gap in what one specific host affordance
(a generic "preview this app-linked tool" panel) can do with a
*parameterized* resource template, not a defect in this repo's server:
`resources/read` against the same URI with the real id already substituted
(exercised separately via `--cli --method resources/read --uri
ui://chaperone/consent/<realId>`, and via the refusal's own embedded
`resource` content block, both confirmed working and byte-identical to
`renderConsentCardHtml`'s output) renders correctly. The product's actual
delivery path for the interactive card — embedding the already-resolved
HTML directly in the *triggering* tool's refusal result — never depends on
a host resolving the template itself, which this finding retroactively
validates as the right design rather than a redundant belt-and-suspenders
choice.

**Workaround:** None needed for the shipped design; noted here so a later
session doesn't spend time trying to make Inspector's Apps-tab "Open App"
preview work against the literal `{quarantineId}` template — that specific
one-tool-one-static-resource affordance is not the mechanism this product
relies on.

**Actionable suggestion:** If a future MCP App on this gateway ever needs
the Apps-tab preview-and-open-from-tool-metadata flow to work standalone
(independent of being embedded in another tool's result), it would need a
tool whose `_meta.ui.resourceUri` is a concrete URI, not a template — e.g.
a tool that itself returns `{quarantineId}` and only becomes
"openable" after being called once. Not needed for this product's own
consent-card flow, which is deliberately triggered by a *different* tool's
refusal.

## Entry 029 — 2026-09-15

**Task attempted:** Run `pnpm test:stack` (the 10-iteration resumption
suite plus the long-stream suite) as the final acceptance check after the
live MCP Inspector session above, to confirm Phase 11's changes to
`app.ts`/`upstreamProxy.ts` (new resource capability, new `buildApp`
parameter) didn't regress the resumable-SSE flagship claim.

**Steps taken:** `docker compose up -d --build` (same containers used for
the manual Inspector session, reusing the already-migrated,
already-`pin:bootstrap`-ed `chaperone_ddb-data` named volume rather than a
fresh one), then `pnpm test:stack`.

**Expected versus actual:** Expected 10/10 resumption iterations green, per
CLAUDE.md's own acceptance bar. Actual: all 10 failed with `"Order not
placed: the shopping list is empty"` instead of a placed-order confirmation
— `long-stream.test.ts` passed. Root cause, confirmed by hand (raw
`tools/list` against the running gateway): `grocery__add_item` was
excluded from `tools/list` — quarantined — because the DynamoDB volume
still held the pin my own manual Inspector session had left approved
against the *mutated* description, while `docker compose up --build`
restarts `demo-upstream` with its in-memory mutation state reset to
*original* on every container start. Pin says mutated, live tool says
original: a real, correctly-detected hash mismatch, not a bug. The
resumption test's own `callToolAndAwaitResult(session, 2,
"grocery__add_item", ...)` doesn't assert `isError`, so it silently
proceeded to `place_order` against a list that had never actually
received an item, and the confusing failure surfaced two calls later
instead of at its true source.

**Severity:** minor — self-inflicted by manual testing sharing a
long-lived Docker volume with the automated suite, not a defect in
gate.ts, session.ts, or the resumption suite's normal operating
assumptions (a fresh `docker compose up` + `ddb:migrate` +
`pin:bootstrap` sequence, which nothing in this session's manual poking
ever violates on its own). Confirmed by `docker compose down -v` (wiping
the volume) + fresh `ddb:migrate` + `pin:bootstrap`: 10/10 resumption
iterations and the long-stream suite all pass.

**Workaround:** None needed in code. Operationally: after any manual
Inspector/curl session against the compose stack that approves or refuses
a quarantine, either `docker compose down -v` before the next
`pnpm test:stack` run, or re-run `pnpm pin:bootstrap` to re-pin every tool
to whatever the upstream is currently serving.

**Actionable suggestion:** `callToolAndAwaitResult` in
spec/resumption.test.ts (and any other spec/ helper with the same name or
shape) should assert `!result.isError` right after the `add_item` seed
call, with a message that names the actual refusal text — turning a
"list is empty two calls later" red herring into an immediate, correctly
located failure the next time stale pin state (or any other cause) quietly
turns the seed call into a refusal instead of a mutation.

## Entry 030 — 2026-09-15

**Task attempted:** Diagnose a `spec/long-stream.test.ts` CI failure — 35 of
36 `notifications/progress` received, always the last one, never a middle
one — and determine whether it's a test-side race (resolve on the result
before draining the last notification) or a real proxy ordering defect,
per MCP-03's requirement that progress stays ordered relative to the
result, before touching anything.

**Steps taken:** Read `demo-upstream`'s `track_delivery` handler first:
it `await`s `extra.sendNotification` for every checkpoint, including the
last, before returning its result — so the *upstream* hop always sends
checkpoint N before its own result, by construction. Then read
`upstreamProxy.ts`'s relay: each `onProgress` callback chains onto a local
`relayChain` promise via `extra.sendNotification(notification)`, but the
handler's `return await callRegistry.runOnce(...)` never awaits
`relayChain` — it only awaits `pool.callTool(...)`. Read the installed
`@modelcontextprotocol/sdk@1.30.0`'s `shared/protocol.js` directly (per
CLAUDE.md's "verify rather than remember") to check whether the SDK itself
serializes notification-sends against the result-send on the same
transport: it does not — `_onrequest`'s response path is
`.then(() => handler(...)).then(async (result) => { ...; await
transport.send(response); })`, a completely separate promise chain from
our own `relayChain`, and `event-store.ts`'s `storeEvent` (called inside
every `transport.send`) does two real DynamoDB calls before the SSE frame
is written — real async I/O with room for either chain to finish first.
This explains "always the last, never a middle one" exactly: checkpoints
1..(N-1) each have a full tick interval (5s in this suite) as slack for
their write to land before anything else happens; only the last one races
the result's own write with zero slack.

To turn that code-reading into evidence rather than a plausible story,
reproduced it *deterministically* rather than chasing the real (rare,
network-timing-dependent) CI race: extended `spec/conformance.spec.test.ts`'s
existing (fully synchronous) `ledger` mock so `putSseEvent` adds an
artificial 300ms delay to exactly the final checkpoint's write and none
other, then ran the existing `track_delivery` progress test against the
unfixed proxy. It failed every time — `[1, 2, 3]` instead of `[1, 2, 3,
4]` — with no dependence on real timing luck, which is what makes this
proof rather than a hypothesis: a fully deterministic mock produced the
same failure shape the flaky real-network CI run did, so the defect is in
the code path both exercise, not in that one CI run's luck. This is also
why the pre-existing "relays every notifications/progress ... in order,
before the final result" test in the same file never caught it: its
`ledger` mock resolves synchronously, so there was never a real gap for
the untested race to fall into.

**Expected versus actual:** Expected either a client-side draining bug in
the test or nothing (a false alarm from CI flakiness). Actual: a real
gateway defect — `upstreamProxy.ts`'s `tools/call` handler can return the
tool result before its own relayed final progress notification has
finished being written to the downstream transport, because nothing
awaits the relay chain before returning.

**Severity:** major. This is the flagship resumable-SSE code path
(CLAUDE.md: "Resumable SSE is the flagship technical claim and gets 20
seconds of the demo video"), and a progress bar that silently never
reaches 100% is exactly the kind of defect that's invisible in a
30-second demo take and then visible the one time a judge watches the
full run — plus a direct violation of MCP-03 (progress ordering relative
to the result), not just a cosmetic gap.

**Workaround:** Fixed at the source, not worked around:
`upstreamProxy.ts`'s `tools/call` handler now captures `pool.callTool(...)`'s
result, `await`s `relayChain` (empty/no-op when there was no
`progressToken`, or already resolved for every checkpoint but a slow last
one), and only then returns the result — guaranteeing the last relayed
notification's write completes, and therefore reaches the client, before
the result's write begins. Verified: the new deterministic regression
test passes; the full `spec/conformance.spec.test.ts` suite (27/27) and
`pnpm test` (334/334) still pass; `pnpm test:stack` (11/11, including all
10 resumption iterations and one full real 180s/36-checkpoint long-stream
run each time) passed three consecutive times against a real
`docker compose` stack.

**Actionable suggestion:** Any gateway code that relays notifications via
a fire-and-forget promise chain alongside a separately-resolved main
result needs the same audit: grep for `relayChain`-shaped patterns
(a local promise reassigned inside a callback, never awaited by the
enclosing `return`) elsewhere in `packages/gateway/src` and
`packages/upstream/src`. More generally: a suite whose only mock for a
dependency is fully synchronous can structurally never catch an ordering
bug that only exists because the real dependency is async — worth a
standing note next to any `vi.mock("@chaperone/ledger", ...)` block that
the mock's speed is itself a test-coverage gap for exactly this class of
defect, not just a convenience.

## Entry 031 — 2026-09-18

**Task attempted:** Scaffold `packages/advisory` (Phase 12) by adding
`@aws-sdk/client-bedrock-runtime` as that new package's dependency before
its `package.json` existed yet, via `pnpm add -w @aws-sdk/client-bedrock-runtime
--filter @chaperone/advisory`.

**Steps taken:** Ran the command expecting either a clear "no such
workspace package" error or, if pnpm resolves `--filter` before scaffolding
matters, a helpful failure. Checked `git status` immediately after as a
habit, not because anything looked wrong yet.

**Expected versus actual:** Expected the install to fail loudly (no
package named `@chaperone/advisory` exists in the workspace yet — nothing
in `pnpm-workspace.yaml` could match that filter). Actual: pnpm printed a
plain, unflagged "Done in 5s" and silently added the dependency to the
**root** `package.json`'s `devDependencies` instead, because `-w` + a
non-matching `--filter` degrades to "install at the workspace root" rather
than erroring — with `-w` present, an unmatched filter is treated as
"nothing selected, fall back to the root," not "selector produced zero
packages." `git status --short` was the only thing that caught it (`M
package.json`, `M pnpm-lock.yaml`) — nothing about pnpm's own output
flagged the fallback.

**Severity:** minor. Caught before anything was committed, via the same
`git status` habit this repo's own CLAUDE.md already asks for before any
state-changing operation. Would have been a real problem if the resulting
root `devDependency` had been committed: it would have put a Bedrock
runtime client in scope for `pnpm depcruise`'s `no-llm-in-policy` check's
*import graph* reachability from every package including `packages/policy`
in principle, even though nothing would actually import it — a false
sense that the boundary was still clean while the dependency itself had
quietly leaked to a scope wider than intended.

**Workaround:** `git checkout -- package.json pnpm-lock.yaml` to discard
the accidental root-level change, then scaffolded `packages/advisory`'s
own `package.json` with the dependency declared there directly, and ran a
plain `pnpm install` (no `--filter`) to link it — which is the actually-
correct order for adding a new workspace package's first dependency:
create the package.json first, install second, never the reverse with
`--filter` racing the scaffold.

**Actionable suggestion:** When creating a brand-new workspace package,
never use `pnpm add --filter <not-yet-existing-package>` to seed its first
dependency — write the `package.json` by hand (or via `pnpm init` inside
the new package directory) first, then run a filter-less `pnpm install` to
link it. If a `--filter` selector is ever needed against a package that
might not exist yet, drop `-w`/`--workspace-root` from the same command so
an unmatched filter fails closed instead of silently retargeting the
workspace root.

## Entry 032 — 2026-09-19

**Task attempted:** Log every HTTP hop of the console's
`chaperone/approve_change` call to an on-screen request log by passing a
custom `fetch` to `@modelcontextprotocol/sdk` 1.30.0's
`StreamableHTTPClientTransport` (`packages/console/src/mcp.ts`), then
ending the session with `transport.terminateSession()`.

**Steps taken:** Wrapped `fetch` to record method, JSON-RPC method, status,
latency and `X-Request-Id`, and ran a real approve attempt against the
docker-compose gateway from the browser.

**Expected versus actual:** Expected one entry per request, all resolved.
Actually, after `connect()` the SDK opens its own standalone `GET /mcp` SSE
stream without being asked. When `terminateSession()` runs, that stream's
fetch rejects with an `AbortError` inside the custom `fetch`. The wrapper
has no way to tell the SDK aborting on purpose apart from a real network
failure, so the log showed a red "network error" on every successful
approval. `client/streamableHttp.d.ts` doesn't mention either the automatic
GET or its abort on termination.

**Severity:** minor. It only mislabels a log line. No request actually
failed.

**Workaround:** Treat a `DOMException` named `AbortError` in the wrapper as
"closed" and render it neutral rather than as an error.

**Actionable suggestion:** Document on `StreamableHTTPClientTransportOptions.fetch`
that the transport issues its own standalone GET after initialization and
aborts it on `terminateSession()`/`close()`. Better still, pass a
distinguishable abort `reason` (for example `"session terminated"`) so a
custom `fetch` can separate an intentional close from a failure without
guessing from the error name.

## Entry 033 — 2026-09-20

**Task attempted:** Keep the console's rehearsal control — the button that
fires demo-upstream's scripted `add_item` mutation — out of any build that
does not set `VITE_DEMO_CONTROLS=true`, in Vite 6.4.3
(`packages/console/src/screens/Upstreams.tsx`).

**Steps taken:** Gated the component on
`import.meta.env["VITE_DEMO_CONTROLS"] === "true"`, using bracket notation
because the rest of this repo reads env that way under
`noUncheckedIndexedAccess`. Built without the variable and grepped the
emitted bundle for a string only that component renders.

**Expected versus actual:** Expected the branch to fold to `false` and the
component to be dropped. Actually the string was in the default bundle.
Vite's define-style replacement only matches the **dotted** member
expression `import.meta.env.VITE_DEMO_CONTROLS`; with bracket notation the
expression survives as a runtime property lookup on the env object, the
branch is never constant-folded, and Rollup cannot treeshake the component.
There is no warning, no build error and no type error — the two spellings
are interchangeable to TypeScript and produce identical behaviour at run
time in dev, so `pnpm dev` and the test suite both pass either way. The env
docs show only the dotted form and do not say the distinction is load
bearing.

**Severity:** major. Not because a button leaked — it is one demo control —
but because the failure is silent in exactly the situation where silence is
worst. The idiom is the standard one for compiling something out of a
production build, which is how people gate admin panels, debug surfaces and
internal tooling. A developer who writes the bracket form gets a build that
behaves correctly in every test they run and ships the code anyway, and
nothing anywhere tells them.

**Workaround:** Use dot access, and verify by grepping the built bundle for
a string only the gated component emits, rather than trusting that the
branch folded. That grep is now part of this phase's acceptance run.

**Actionable suggestion:** Make `import.meta.env["FOO"]` either work or
warn. Warning is enough and is cheap: when Vite sees a bracket access on
`import.meta.env` with a **static string literal** key that matches a
defined variable, emit a build warning saying the value will not be
statically replaced and naming the dotted form. Failing that, say it
explicitly in the "Env Variables and Modes" docs next to the production
example — the page currently demonstrates the dotted form without ever
stating that it is the only form that is replaced, so a reader has no way
to learn this except by disassembling their own bundle.

---

## Entry 034 — 2026-09-20

**Task attempted:** Verify the fail-closed property from the outside, as a
judge would: stop DynamoDB (`docker compose stop ddb`), then make a real
`tools/call` against the gateway and confirm it refuses rather than allows
(@modelcontextprotocol/sdk 1.30.0, Streamable HTTP).

**Steps taken:** Stopped the `ddb` container, confirmed `/healthz` returned
503, then drove a full MCP session against `/mcp` over plain `fetch` —
`initialize`, `notifications/initialized`, `tools/call` — and read the
response body.

**Expected versus actual:** Expected either a frozen refusal result or a
JSON-RPC error whose code and message named a storage or internal failure.
Actually `initialize` came back `400` with
`{"code":-32700,"message":"Parse error","data":"TimeoutError: ... did not
establish a connection with the server within the configured timeout of
3000 ms."}`. The request body was valid JSON and valid JSON-RPC; nothing was
parsed incorrectly. The cause is the catch-all at the end of
`handlePostRequest` in `dist/esm/server/webStandardStreamableHttp.js`, which
wraps every throw from the POST path — including one from a user-supplied
`EventStore.storeEvent`, which is where a storage outage surfaces — as
`-32700 Parse error` with the stringified error in `data`.

**Severity:** major. The security property itself holds, and that is the
part that matters: nothing was allowed, no tool ran, and a session could not
even be established. But `-32700` is the one JSON-RPC code reserved for
malformed input, so the wire response actively misattributes a backend
outage to the client's request. An operator debugging this reads "Parse
error", checks their payload, finds it valid, and has to get to the `data`
string before learning the truth. For this project it is also the exact
conflation CLAUDE.md's fourth non-negotiable exists to prevent — "this
server is down" and "your request was malformed" must not be the same
answer.

**Workaround:** None available at the gateway layer, because the throw is
caught inside the SDK above any code this repo controls; the `EventStore`
contract gives no way to signal "storage failed" distinctly, and swallowing
the error there would be worse — the transport would believe the event was
persisted and resumability would silently break. The acceptance check in
`packages/gateway/test/health.test.ts` therefore asserts the property that
is actually guaranteed, that the call does not succeed, and a second test
drives the gate's own path by failing only the pin read, to assert the
frozen refusal text.

**Actionable suggestion:** Do not reuse `-32700` for non-parse failures. In
`handlePostRequest`'s final catch, return `-32603` (Internal error) for any
throw that did not come from JSON parsing or JSON-RPC message validation —
those two sites already have their own `-32700` returns a few hundred lines
above and are correctly labelled. An `EventStore` failure in particular is a
server-side internal error by definition. Alternatively, document that a
throw from a user-supplied `EventStore` is surfaced this way, so implementers
know the wire code will not describe their failure.

---

## Entry 035 — 2026-09-20

**Task attempted:** Produce a reproducible added-latency number for
`pnpm bench` against the local stack — the same MCP `tools/call` through the
gateway and direct to the upstream, 1000 samples per mode, reported as the
difference (DynamoDB Local via `amazon/dynamodb-local:latest`, docker
compose).

**Steps taken:** Ran the harness repeatedly at the same commit with no code
change between runs, then bisected the cost: timed `getPin`, `nextSseSeq`
and `putSseEvent` individually, then ran a concurrency sweep against
`putSseEvent` alone, then counted rows in each table.

**Expected versus actual:** Expected repeated runs at one commit to agree
within noise. Actually they drifted monotonically upward — added p50 of
64ms, then 174ms, then higher, at the same commit. Two compounding causes,
neither documented where a reader would look. First, DynamoDB Local does not
implement TTL at all: the `sse-event` rows that back resumable SSE carry a
TTL and are evicted in production, but locally they accumulate forever —
about 750 rows per bench run, 11,924 by the time I measured. Second, its
SQLite backend is a single writer whose throughput is flat at roughly 60
writes per second regardless of client concurrency (measured: per-operation
p50 of 20.7ms at concurrency 1, 54.7ms at 4, 127.3ms at 8, while throughput
stayed between 42 and 70 ops/s), and it slows further as the table grows.
Since each gated `tools/call` costs four DynamoDB writes, the benchmark was
measuring the container's accumulated state rather than the gateway.

**Severity:** major. Not a correctness bug — it is a dev dependency — but a
benchmark whose result depends on how many times it has been run before is
not a measurement, and nothing surfaces this. The TTL gap is a one-line
mention in the DynamoDB Local docs' feature-differences section and says
nothing about unbounded growth; the single-writer throughput ceiling is not
stated anywhere I could find. A team that graphs local latency over a sprint
and watches it climb has no way to learn the cause is their test fixture.

**Workaround:** `packages/ledger/scripts/reset-sse.ts`, run by `pnpm bench`
before measuring, so every run starts from a defined storage state. It
deletes only `sse-event`, never `ledger-event`, and refuses to run unless
`DDB_ENDPOINT` is set so it can never be pointed at real DynamoDB. After it,
consecutive runs agreed within about 15% (added p50 of 144ms then 123ms)
instead of drifting, which was enough to detect a deliberately injected 50ms
delay as a 53 to 76ms shift.

**Actionable suggestion:** Two things, both cheap. Log a warning from
DynamoDB Local on startup when a table has a TTL attribute defined, saying
TTL is not enforced and rows will accumulate — the process already parses the
schema, and that is the moment the user's mental model diverges from reality.
And state the write-throughput characteristic in the "Differences"
documentation page: that the backend is a single writer, that concurrency
raises per-operation latency without raising throughput, and that it is
therefore unsuitable for latency or load measurement. The page currently
frames the differences as feature gaps, which leads readers to assume
performance is merely slower rather than differently shaped.

---

## Entry 036 — 2026-09-20

**Task attempted:** Run the repo's own `verify-ledger` entry point as a
subprocess from `packages/bench/scripts/bench.ts`, so the consolidated bench
block reports exactly what `pnpm verify-ledger` reports (Node 24.14.1,
Windows, pnpm 12.4.1).

**Steps taken:** Spawned the `node_modules/.bin/tsx` shim with
`spawnSync(tsx, [script], { shell: process.platform === "win32" })` — the
shim is a `.cmd` on Windows, which `CreateProcess` cannot execute directly,
so a shell is required.

**Expected versus actual:** Expected a clean run. Actually every invocation
printed `[DEP0190] DeprecationWarning: Passing args to a child process with
shell option true can lead to security vulnerabilities, as the arguments are
not escaped, only concatenated.` The warning is correct and the concern is
real, but the combination it deprecates — an args array plus `shell: true` —
is precisely what running any `.bin` shim on Windows requires, and the
warning text offers no replacement. It lands on stderr in the middle of
output intended to be filmed.

**Severity:** minor. Cosmetic, with a clean fix once you know it, but the
warning points at no alternative and the obvious workaround — concatenating
the command into a single string — is strictly worse, since it is the actual
injection risk the deprecation is warning about.

**Workaround:** Skip the shim.
`createRequire(import.meta.url).resolve("tsx/cli")` gives the real JS entry
point, which `spawnSync(process.execPath, [cli, script])` runs with no shell
and no concatenation, identically on every platform.

**Actionable suggestion:** Name the alternative in the deprecation message
and in the `child_process` documentation: resolve the package's JS entry and
spawn it with `process.execPath`, rather than spawning the platform shim
through a shell. The warning currently tells developers that a common and
necessary pattern is dangerous without telling them what to do instead,
which pushes some fraction of them toward string concatenation — the more
dangerous of the two options.

---

## Entry 037 — 2026-09-23

**Task attempted:** Step 0(c) of the Phase 12/13 completion brief — invoke
both `us.amazon.nova-lite-v1:0` and `us.amazon.nova-pro-v1:0` once via the
Bedrock Converse API from IAM user `chaperone-dev` (account `856820205068`,
`us-east-1`), the call that both confirms the model IDs resolve and (per the
brief) auto-enables Bedrock's serverless models on first invocation.

**Steps taken:** `aws sts get-caller-identity` first confirmed the identity
(IAM user, not root) and `aws configure get region` confirmed `us-east-1`,
per Step 0(a)/(b). Wrote a short script using
`@aws-sdk/client-bedrock-runtime`'s `ConverseCommand` (already a dependency
of `packages/advisory`, per `BedrockModelProvider` — see
`docs/AWS-BUILDER.md`'s "Verifying the SDK surface") and ran it with `pnpm
--filter @chaperone/advisory exec tsx`, sending a trivial one-word prompt to
each model ID in turn.

**Expected versus actual:** Expected either a real completion (confirming
the inference-profile ID and auto-enablement both work as the brief
describes) or an `AccessDeniedException` naming a missing IAM action on
`chaperone-dev`'s policy — the failure mode Step 0(d) is written to handle.
Actual: both calls returned `AccessDeniedException`, but with a body that
names neither model nor any IAM action: "Your account is currently being
verified. Verification normally takes less than 2 hours. Until your account
is verified, you may not have access to this operation." This is an
account-level KYC/fraud-verification hold Bedrock applies automatically to
an account's first attempted invocation, separate from and prior to the
per-model "use-case verification" gate the brief already knew about for
Anthropic's models on Bedrock — Amazon's own Nova models hit a different,
account-wide hold instead of the model-specific one.

**Severity:** blocker, until AWS's own side clears — this is not an IAM
permissions gap (no policy attached to `chaperone-dev` can fix it; nothing
about the request was malformed) and not something creating or modifying an
IAM entity would address, so per this repo's own CLAUDE.md and the phase
brief's explicit instruction not to create IAM users/roles/policies, no
workaround was attempted. Phases 12 and 13 cannot make the one real model
call either phase is scoped around until this clears.

**Workaround:** None applied. AWS's own message gives an ETA ("normally
less than 2 hours") and an escalation path (`aws-verification@amazon.com`)
if it doesn't clear in that window — both stated here rather than acted on,
since retrying inside this session on a fixed schedule would not make the
verification finish any faster.

**Actionable suggestion:** Budget real calendar time for this specific hold
when a hackathon account first turns on Bedrock — it is distinct from (and
apparently not documented alongside) the per-Anthropic-model use-case-review
gate this project already budgeted for in an earlier phase, so a builder
who has already cleared that first gate can still be surprised by a second,
account-wide one on a completely different model family. Re-run the exact
Converse calls above once the account clears, before assuming Phase 12/13
are unblocked on the IAM side alone.

---

## Entry 038 — 2026-09-23

**Task attempted:** Re-ran Entry 037's exact preflight (`ConverseCommand`
against `us.amazon.nova-lite-v1:0` and `us.amazon.nova-pro-v1:0`, IAM user
`chaperone-dev`) later in the same session, to check whether the account
verification hold had cleared.

**Steps taken:** Re-ran the same script, then, once the error changed,
cross-checked with the AWS CLI directly (`aws bedrock-runtime converse`) for
a fuller error, confirmed both model IDs are real and `ACTIVE` (`aws bedrock
list-foundation-models`/`list-inference-profiles`), tried the plain
on-demand model ID in place of the `us.`-prefixed inference-profile ID in
case that mattered, and tried a third, unrelated model
(`meta.llama3-8b-instruct-v1:0`) to check whether the failure was
Nova-specific or account-wide. Also tried `iam:ListAttachedUserPolicies` /
`ListUserPolicies` / `ListGroupsForUser` on `chaperone-dev` to see its own
attached policy, which itself returned `AccessDenied` (the user has no
IAM-introspection permission — expected for a least-privilege dev user, not
itself a finding).

**Expected versus actual:** Expected either a real completion (verification
cleared, Bedrock enabled on first call as the phase brief describes) or the
same `AccessDeniedException` as before. Actual: the error changed —
`AccessDeniedException` ("account is currently being verified") is gone,
replaced by `ValidationException: Operation not allowed` on every single
model tried, model ID format tried, and provider tried (Amazon Nova and
Meta Llama alike), both via the SDK and the raw AWS CLI. This rules out an
IAM permissions gap (would be `AccessDeniedException`, naming an action) and
rules out anything Nova-specific or inference-profile-ID-specific (the
identical error on `meta.llama3-8b-instruct-v1:0` and on the plain
on-demand `amazon.nova-lite-v1:0` id). The account-level verification hold
from Entry 037 appears to have cleared, but something else — most likely
Bedrock's own account-level model-invocation enablement still propagating,
though this could equally be an unstated account/region/SCP restriction —
is still blocking every `Converse` call uniformly.

**Severity:** blocker, same as Entry 037 — Phase 12/13 still cannot make
the one real model call either phase is scoped around. Distinct root cause
from Entry 037 though: that one had a stated ETA and escalation path from
AWS directly; this one's error message gives neither.

**Workaround:** None applied — no IAM entity was created or modified (per
this repo's CLAUDE.md and the phase brief's explicit instruction), and
`ValidationException` on every model/provider combination gives nothing
project-side to fix. Reported to the user rather than guessed at further.

**Actionable suggestion:** If this repeats after a longer wait, check the
Bedrock console's own "Model access" page for this account/region directly
(this session cannot — `chaperone-dev` was denied even read-only IAM
introspection, and there is no Bedrock model-access-status API distinct
from `ListFoundationModels`, which only lists what an account *could*
request, not whether it already has invocation rights). Worth asking
whether this AWS account sits under an AWS Organization with a Service
Control Policy scoping `bedrock:*` — `ValidationException` rather than
`AccessDeniedException` is an unusual shape for an SCP denial but not
impossible depending on how Bedrock's own API maps that case.

**Update, 2026-09-24 (AWS Support's reply, paraphrased from the author's
report):** Support replied that the request for Bedrock model access in
us-east-1 had been reviewed and could not be approved. Access depends on
region, payment history and overall account usage; this account does not
currently meet the criteria; the decision is not permanent and is
re-evaluated automatically as usage and billing history build up. The same
reply confirmed that the Anthropic use-case form error and the `Operation not
allowed` error above share this root cause. So the cause was the account's
history, not a propagation delay, an IAM gap or an organisation policy (this
entry's guesses). The finding stands: an account-level refusal surfaced as a
generic `ValidationException` naming no cause and no remedy, on every model
tried, and the use-case-form error gave no hint that it was the same problem.
Consequence for this project: no model provider is chosen, and nothing in the
repo states one as chosen (`docs/LIMITATIONS.md`).


## Entry 039 — 2026-09-23

**Task attempted:** Show that the offline demo's containers cannot reach the
internet ("block outbound in docker"), on Docker Desktop for Windows, without
touching host firewall or adapter settings.

**Steps taken:** First tried the obvious single-network answer: an overlay
that recreates the compose default network with
`com.docker.network.bridge.enable_ip_masquerade: "false"`, which on plain
Linux Docker leaves containers reachable through published ports but strips
their outbound NAT. Recreated the stack on it and, from inside the gateway and
demo-upstream containers, fetched `https://example.com`, `https://1.1.1.1`
and `https://registry.npmjs.org`. Then tried the second-most-obvious answer,
an `internal: true` network, and worked around its one side effect (published
ports do not cross an internal network) with a socat forwarder container
(`edge`) attached to both the internal network and an ordinary one.

**Expected versus actual:** Expected the masquerade option to make every
public fetch fail. Actual: all three succeeded (HTTP 200); the option is
accepted without complaint and does nothing observable on this Docker Desktop
setup. The `internal: true` network did what it says: the same fetches fail
with `ENETUNREACH` (by address) and `EAI_AGAIN` (by name) from both app
containers, while in-stack names and the host's published ports keep working
through `edge`.

**Severity:** minor. One wrong turn, caught only because the overlay was
tested from inside a container rather than trusted on the strength of its
own comment.

**Workaround:** `docker/compose.offline.yml`: app containers on an
`internal: true` network, plus one `edge` socat container that carries ports
3000, 4000 and 8000 to the host. `edge` is the only container with a route
out, and it is only told to connect to the three in-stack targets.

**Actionable suggestion:** Docker's documentation for
`com.docker.network.bridge.enable_ip_masquerade` should say it is a
Linux-bridge option that Docker Desktop's VM networking may not honour, and
`docker network inspect` shows the option as set either way, so nothing
signals that it is inert. A supported "no egress, but publish ports" switch
(the thing people actually want for demos and hermetic tests) would remove
the need for a forwarder container.

## Entry 040 — 2026-09-24

**Task attempted:** Clone this repository into a fresh folder on Windows 11,
as a judge would, to time the README quickstart from a clean checkout (Git
for Windows, the Bash tool).

**Steps taken:** `git clone https://github.com/nirmalraj142007-byte/Chaperone.git
chaperone-fresh` inside a scratch directory whose path was 139 characters
long. Repeated it once to confirm it was not a transient failure. Then listed
the longest tracked paths with `git ls-files`, and cloned again into a short
path (`C:\Users\Nirmalraj\chaperone-fresh`).

**Expected versus actual:** Expected a clean checkout. Actual, both times in
the long path: `error: unable to create file
data/raw/crawl-1/daedalusdevelopmentgroup__ddg-agent-payable-services__daedalusdevelopmentgroup-ddg-age.json:
Filename too long`, then `fatal: unable to checkout working tree` and
`warning: Clone succeeded, but checkout failed`, leaving a repository with a
partial working tree. The longest tracked path in the repo is 108
characters, so any clone location whose own path is longer than about 150
characters fails on Windows' legacy 260-character limit, and the paths
`pnpm install` creates under `node_modules/.pnpm` are longer than any tracked
file. The hint Git prints is `git restore --source=HEAD :/`, which would fail
the same way; nothing in the message mentions `core.longpaths` or the
260-character limit. In the short path the clone worked in 3 seconds.

**Severity:** minor. It fails loudly and at the first command, and a normal
clone location (`C:\Users\<name>\Chaperone`, about 30 characters) is nowhere
near the limit. It would still cost a judge on a deeply nested Documents or
OneDrive path a confusing first minute.

**Workaround:** Clone into a short path. `git config --global
core.longpaths true` is Git's own documented remedy; it was not tried here,
so it is not verified for this repo. The README quickstart says to use a
short path.

**Actionable suggestion:** For Git for Windows: when checkout fails with
"Filename too long", say so in the closing hint and name `core.longpaths`
and the 260-character limit, instead of suggesting a restore that would fail
identically. For this repo: the raw crawl archive names are 100-character
truncations of server ids; shorter archive filenames would remove most of
the exposure.

## Entry 041 — 2026-09-24

**Task attempted:** Bring up the stack from a second checkout of the repo,
on the same machine as the first, to time the README quickstart
(`docker compose up -d --build`, Docker Desktop 4.90.0 on Windows).

**Steps taken:** Ran `docker compose up -d --build` in the fresh clone while
the original checkout's three containers existed in the `Exited (255)` state
(why they had exited was not investigated). The images built first, then
container creation failed.

**Expected versus actual:** Expected the second project to start, or to be
told why it could not. Actual: `Error response from daemon: Conflict. The
container name "/chaperone-demo-upstream" is already in use by container
"d669ce33faa6...". You have to remove (or rename) that container to be able
to reuse that name.` The cause is this repo's own choice: `docker-compose.yml`
gives every service a fixed `container_name`, so two checkouts (or two
compose project names) cannot coexist on one machine, running or stopped.
The message names a container id and not the compose project that owns it,
so a reader has to run `docker ps -a` and read the project label to learn
that it is the other checkout's leftover.

**Severity:** minor. It happens after the build, so the wasted time is the
build, and a judge with one checkout and a clean Docker never sees it.

**Workaround:** `docker compose down` in the other checkout (without `-v`,
so its data volume is kept), then `docker compose up -d --build` again. The
second run took 8 seconds because the images were already built.

**Actionable suggestion:** For Docker Compose: a container-name conflict
message should say which compose project (`com.docker.compose.project`
label, which the conflicting container carries) owns the name, since that is
what tells the user which directory to run `down` in. For this repo: the
fixed names exist so logs and docs can say `chaperone-gateway`; dropping
them would let two checkouts coexist at the cost of longer generated names.
Not changed here, because the docs and the demo scripts refer to the fixed
names.
