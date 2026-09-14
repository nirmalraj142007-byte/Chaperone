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

## Entry 012 — 2026-09-13

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

## Entry 014 — 2026-09-14

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

## Entry 016 — 2026-09-14

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
