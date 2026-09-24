# Product feedback

One section per tool or service this project used. Everything here is drawn
from [`friction-log.md`](../friction-log.md), which was written in the session
where each thing happened; entry numbers are given so each claim can be
checked against its full six-field entry. Nothing here is new material, and a
section that has no recorded friction says so instead of being filled out.

## The five asks, if you read nothing else

1. **Bedrock: name the cause of an account-level refusal.** An account whose
   access was refused got `ValidationException: Operation not allowed` on
   every model, with no cause and no remedy (Entries 037, 038).
2. **DynamoDB Local: say that TTL is not enforced and that it is a single
   writer.** A latency benchmark against it climbed with every run and nothing
   said why (Entry 035).
3. **MCP TypeScript SDK: do not answer a storage failure with `-32700`.** A
   throw from a user-supplied `EventStore` comes back as "Parse error"
   (Entry 034).
4. **MCP TypeScript SDK: make the transport types satisfy their own
   interface under `exactOptionalPropertyTypes`.** Every call site needed the
   same cast (Entries 007, 012).
5. **`@modelcontextprotocol/ext-apps`: publish the wire contract.** Its only
   working documentation, in practice, was its own minified bundle
   (Entries 009, 027).

---

## MCP TypeScript SDK (`@modelcontextprotocol/sdk` 1.30.0)

**Used for:** the gateway (an MCP server on Streamable HTTP with resumable
SSE), the upstream client pool, the demo upstream, the console's client, and
the conformance suite.

**Friction:**

- *Which package speaks the required revision.* The SDK split into a v1 line
  and a new v2 line under different package names during the build window;
  finding the version that negotiates `2025-11-25` took three separate
  fetches and no changelog entry names the version where it landed
  (Entry 001, major).
- *Transport classes do not satisfy the `Transport` interface under
  `exactOptionalPropertyTypes`.* Both `StreamableHTTPServerTransport` and
  `StreamableHTTPClientTransport` type `onclose`/`sessionId` as `T | undefined`,
  wider than the exact-optional property `Transport` declares. Every call site
  needs an `as Transport` cast (Entries 007, 012).
- *`McpServer` cannot front a passthrough.* `registerTool` accepts only a Zod
  schema, not the JSON Schema `tools/list` reports, so a byte-transparent
  proxy has to use the deprecated low-level `Server`. That decided the
  gateway's architecture (Entry 011, major).
- *The low-level `Server` does not validate `arguments` against a tool's
  declared `inputSchema`.* Only `McpServer.registerTool` does. The declared
  schema is descriptive metadata on the low-level class, and nothing in its
  types says so (Entry 023).
- *The single-transport usage example supports exactly one session, ever.* A
  second `initialize` gets `Server already initialized`. The doc comment
  does not point at the session-map pattern (Entry 008).
- *Successful POSTs come back as SSE frames even for one immediate result.*
  A raw-HTTP test that calls `res.json()` fails (Entry 015).
- *A storage failure surfaces as `-32700`.* The final catch in the POST path
  wraps every throw, including one from a user-supplied `EventStore`, as
  "Parse error" with the real cause in `data` (Entry 034, major).
- *A 60-second client default applies whatever the server allows.*
  `DEFAULT_REQUEST_TIMEOUT_MSEC` cut a 180-second stream at 60.4 s in the
  test client, and the same default on the gateway's own upstream client cut
  it again at 60.6 s, with a different failure shape. This was a product bug
  in the gateway, not just a test artifact (Entries 020, 021).
- *`Client.callTool` is not generic on its result schema*, so passing
  `CallToolResultSchema` still returns the legacy union (Entry 013).
- *`request()` overwrites a caller-set `progressToken`* when `onprogress` is
  set. Deliberate and reasonable, but invisible until the source is read
  (Entry 014, filed as thin).
- *The client opens its own `GET` SSE stream after `connect()` and aborts it
  on `terminateSession()`*, which a custom `fetch` cannot distinguish from a
  network failure (Entry 032).

**Asks:** a one-line compatibility table (package, version, revisions
supported) at the top of the README; type `onclose`/`onerror`/`onmessage` as
bare optional properties; return `-32603` for non-parse failures; document
that a custom `fetch` sees the automatic `GET` and its abort, or pass a
distinguishable abort reason; make `callTool` generic on `resultSchema`.

## MCP Apps (`@modelcontextprotocol/ext-apps` 1.7.5) and MCP Inspector 2.6.0

**Used for:** the consent card. Inspector was the host used to test it.

**Friction:**

- *The community convention and the working protocol are different.* A plain
  `ui://` resource with an informal `postMessage({type:"tool"})` bridge
  renders in Inspector's preview, but the iframe there is sandboxed with
  `sandbox=""`, so no script runs and the buttons can never work. The
  mechanism that does work needs a `_meta` linkage and a `ui/initialize`
  JSON-RPC handshake, documented nowhere except the extension's own bundle
  (Entry 009, major).
- *No changelog, no migration note.* The package's JSDoc labels the flat
  `_meta["ui/resourceUri"]` key deprecated in favour of a nested
  `_meta.ui.resourceUri`, which a decision record written a week earlier did
  not know about (Entry 027).
- *Inspector's Apps tab does not expand a templated resource URI.* A tool whose
  `_meta.ui.resourceUri` is `ui://chaperone/consent/{quarantineId}` is fetched
  as the literal string (Entry 028).

**Asks:** a changelog and a migration note from the informal convention; state
in the docs which of the two `_meta` forms is current; either expand RFC 6570
templates in the Apps tab or say it does not.

## DynamoDB and DynamoDB Local

**Used for:** the ledger, pins, quarantines, sessions, the resumable-SSE event
store and the advisory table. Locally, `amazon/dynamodb-local` in Docker.
Never yet run against real DynamoDB (see the README's latency section).

**Friction:**

- *A permissions problem presents as an indefinite hang.* On Docker Desktop
  the image's non-root user cannot write a fresh named volume. The container
  starts, the port answers, and every real request hangs with no error while
  the SQLite layer crash-loops (Entry 004, blocker until root-caused).
- *The JS SDK's default handler warns and never settles on a request timeout*
  unless `throwOnRequestTimeout` is set, which turned that diagnosable failure
  into silence (Entry 004).
- *Reserved words are not checked by any mock.* `ttl` and `status` used bare in
  expressions passed every `aws-sdk-client-mock` test and failed against real
  DynamoDB Local with `ValidationException`, once breaking every request
  (Entries 019, 024, both major).
- *DynamoDB Local does not implement TTL and is a single writer.* Rows that
  carry a TTL accumulate forever locally, and throughput is flat at roughly 60
  writes per second regardless of client concurrency (measured per-operation
  p50: 20.7 ms at concurrency 1, 54.7 ms at 4, 127.3 ms at 8). A benchmark
  drifted upward run over run at one commit until the cause was bisected
  (Entry 035, major).
- *The Windows JAR route did not work.* The standalone DynamoDB Local JAR
  crashed at startup on a Windows JDK 26 with `Unable to establish loopback
  connection`, before Docker was available (Entry 003).

**Asks:** log a startup warning when a table has a TTL attribute (the process
has already parsed the schema); state the single-writer characteristic on the
"Differences" page and that it makes the backend unsuitable for latency
measurement; make an unwritable data directory fail fast instead of hanging.

## Amazon Bedrock

**Used for:** nothing that shipped. The Converse API was chosen for the
provider seam (one request shape across model families) and
`@aws-sdk/client-bedrock-runtime` 3.1134.0's surface was read from its type
definitions; unit tests run at the SDK boundary. **No live Bedrock call has
ever succeeded from this project**, and no model provider is currently chosen
(`docs/LIMITATIONS.md`).

**Friction:**

- *The first attempt hit an account-wide verification hold* that named no
  model and no IAM action (`AccessDeniedException`, "Your account is currently
  being verified", Entry 037, blocker).
- *The second attempt returned `ValidationException: Operation not allowed`*
  on every model and provider tried, through both the SDK and the raw CLI.
  The status code says "your request was invalid" when nothing about the
  request was, and the message gives no cause and no remedy, unlike the first
  error, which at least gave an ETA and a contact. AWS Support later said the
  cause was the account's region, payment and usage history (not permanent,
  re-evaluated automatically), and that the Anthropic use-case form error
  shares it. Nothing in either error hinted at that, and there is no API distinct from
  `ListFoundationModels` that reports whether an account may invoke a model
  (Entry 038, blocker, with the 2026-09-24 update).

**Asks:** return a distinct, named error for an account-level refusal, with a
pointer to where it can be appealed; document the verification hold next to
the per-model use-case gate, since a builder who clears one can still be
surprised by the other; expose a model-access status API.

## AWS CDK

**Used for:** one stack, the advisory pipeline (DynamoDB Stream, EventBridge
Pipe, Step Functions, two Lambdas, a table), synthesised with `cdk synth` and
its IAM statements inspected in the output.

**Friction recorded:** none. **It has never been deployed**: no `cdk
bootstrap`, no `cdk deploy`, so there is no feedback here on the deploy path,
and none is claimed. See `docs/AWS-BUILDER.md` and `docs/LIMITATIONS.md`.
{{PENDING: CDK bootstrap and deploy feedback — after the AWS deployment (Phase 18)}}

## Docker and Docker Desktop for Windows

**Used for:** the local stack (DynamoDB Local, the demo upstream, the
gateway), the crawler's read-only, network-restricted boot harness, and the
no-egress demo overlay. Docker Desktop 4.90.0 on Windows 11.

**Friction:**

- *`--tmpfs /tmp` silently mounts `noexec`.* Every `npx`/`pip`/`uvx` install
  ran code from `/tmp` and failed with "Permission denied", which reads like a
  per-server bug and would have misclassified the whole crawl. Widely copied
  hardening examples care about writability, not executability (Entry 006,
  blocker, caught on the first smoke test).
- *New named volumes are owned by root.* An image with a non-root user cannot
  write to one (Entry 004).
- *The CLI on `PATH` says nothing about the daemon.* `docker compose up`
  failed with a named-pipe error, and a too-quick conclusion that Docker was
  not installed was wrong: it was installed and not running (Entry 017).
- *`enable_ip_masquerade: "false"` is accepted and does nothing on Docker
  Desktop.* All three external fetches still succeeded, and `docker network
  inspect` shows the option set either way. An `internal: true` network plus a
  forwarder container did what it says (Entry 039).
- *A fixed `container_name` conflicts across checkouts, and the message names
  a container id rather than the project that owns it* (Entry 041).
- *A named volume outlives the demo.* State left in one by manual testing made
  ten consecutive test iterations fail two calls after the actual cause
  (Entry 029).

**Asks:** say in the docs that the tmpfs option defaults to `noexec`; name the
owning compose project in a container-name conflict; document that the
masquerade option is a Linux-bridge feature Docker Desktop may not honour, and
offer a supported "no egress but publish ports" switch.

## Kiro

**Used for:** {{PENDING: what Kiro was used for in this project — the repo records no Kiro usage or friction; the author supplies this before 2026-10-22}}

No friction is recorded here because none was recorded in the friction log at
the time, and this file does not reconstruct feedback from memory.

## The MCP Registry and each directory API

**Used for:** assembling the 947-server candidate list for crawl 1
(`corpus/candidates-README.md`, section 1).

| Source | Result | Friction |
|---|---|---|
| **Official MCP registry** (`registry.modelcontextprotocol.io/v0/servers`) | 355 unique servers contributed | Matched its own `openapi.yaml` (cursor pagination through `metadata.nextCursor`). No sort parameter is exposed and pages come back in strict alphabetical order by publisher, so a cap truncates alphabetically, not by relevance. **45 of 161** repository URLs (28.0%) point at repos that no longer exist. (Entry 005; `candidates-README.md` sections 3 and 4.) |
| **Smithery** (`registry.smithery.ai/servers`) | 243 unique from 400 raw | Open, no key, which was the opposite of what was expected. Pagination is neither popularity-sorted (`useCount` is non-monotonic across pages) nor stable: about 157 of 400 entries were duplicates, consistent with page boundaries shifting under a live dataset. (Entry 005; `candidates-README.md` section 3.) |
| **PulseMCP** | 0 | `v0beta` returns `410 Gone` (`API_SUNSET`); its replacement `v0.1` needs an `X-API-Key`, confirmed with a live `401`. (Entry 005.) |
| **Glama** (`glama.ai/api/mcp/v1/servers`) | 0 | An API key on every call, confirmed with a live `401`; no public schema for the authenticated response, so the pagination code is an unverified guess kept as dead code. (Entry 005.) |
| **awesome-mcp-servers** (a README list, not an API) | 350 | Self-selected by whoever sent a pull request; order is the file's own. |

Two of the five sources, PulseMCP and Glama, now sit behind a key, and the
build prompt had treated both as free; the one flagged as possibly gated,
Smithery, turned out to be open. The registry's 404 rate is a data-quality finding about the registry in its
own right.

**Asks:** publish a sort order and a stable-pagination guarantee for the
listing endpoints (the registry has no sort parameter and no way to tell that
a `repository.url` is dead; Smithery's pages shift under a live dataset); say plainly in a sunset notice's
`410` body which endpoint replaces it *and that it needs a key*; offer a
read-only, keyless tier for research use.

## Other tools that cost time

Each of these is small; they are listed because they were real.

- **`canonicalize` 2.1.0** (the RFC 8785 library `packages/policy` depends
  on). Its `.d.ts` claims an ES module shape its `package.json` does not
  back up, so `NodeNext` reports "expression is not callable" with no mention
  of interop. Ask: ship a `"type"` field or express the default with `export =`
  (Entry 002).
- **pnpm 12.4.1.** `pnpm <script> -- <filter>` forwards the literal `--`, so
  vitest silently drops its file filter and runs everything (Entry 022).
  `pnpm add -w --filter <not-yet-existing-package>` silently installs at the
  workspace root instead of failing (Entry 031). Ask: fail on an unmatched
  `--filter` even with `-w`.
- **Vite 6.4.3.** `import.meta.env["FOO"]` is not statically replaced; only the
  dotted form is, with no warning, so code meant to be compiled out of a
  production build ships anyway. Ask: warn on a bracket access with a static
  literal key, and say in the docs that the dotted form is the only one
  replaced (Entry 033, major).
- **Node.js `child_process` on Windows.** Running a `.bin` shim requires
  `shell: true`, which prints `DEP0190`, whose text names no alternative; the
  obvious alternative (concatenating a string) is the actual injection risk.
  Ask: name "resolve the JS entry and spawn `process.execPath`" in the
  deprecation text (Entry 036).
- **Git for Windows.** A clone into a deep path fails with "Filename too long"
  and suggests a restore that would fail identically; `core.longpaths` is not
  mentioned (Entry 040).
- **`aws-sdk-client-mock`.** Not a defect: it fakes the SDK's response and
  never parses an expression, which is how Entries 019 and 024 passed unit
  tests and failed on first contact with a real database.
