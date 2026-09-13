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
clearing the N=300 floor, which they do comfortably on their own.

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

## Entry 010 — 2026-09-13

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
