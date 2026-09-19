# Decisions

Durable, dated decision records for Chaperone. Each entry is written once,
at the time the decision was made, and not silently rewritten later —
if a decision changes, a new dated entry supersedes the old one and says so.

---

## MCP App go/no-go — Phase 6 spike (2026-09-13)

**Verdict: PARTIAL, and PARTIAL is a GO for planning purposes.**

A real MCP host renders the consent card's HTML *and* runs its inline
script, but the card's Approve/Keep-blocked buttons do not round-trip to a
real tool call, because the card was built against the informal
`@mcp-ui/server`-style `postMessage` convention named in this phase's
prompt, and the host being tested — MCP Inspector 2.6.0 — implements a
different, more recent, formally JSON-RPC-based bridge instead. The gap is
fully diagnosed (exact `_meta` key, exact mimetype, exact handshake — see
below), not an open question, so this is a scoped two-part fix, not a
rediscovery cost, for whoever picks up the next twelve hours of P0 work.

**For Phase 11 scheduling: proceed.** The twelve hours of Phase 11 work
should go ahead as planned. This PARTIAL is not "we don't know if the host
can do this" — it is "we know exactly which package, which `_meta` key,
and which handshake, and the remaining work is implementing a named
protocol against a pinned version (`@modelcontextprotocol/ext-apps@1.7.5`),
not researching whether one exists." That is a bounded 2–3 hour
engineering task, not an open risk that should hold up the schedule. See
"Recommendation for the twelve hours of downstream P0 work" below for the
budget, and "Fallback" for what happens to the demo if that estimate is
wrong.

### MCP App mechanism

Verified against `@modelcontextprotocol/sdk@1.30.0` (the version already
resolved in this repo's lockfile; confirmed via
`node_modules/@modelcontextprotocol/sdk/package.json` and cross-checked
against `packages/crawler/src/boot.ts`'s own prior verification comment)
and spec revision `2025-11-25` (`LATEST_PROTOCOL_VERSION` exported from the
SDK's `dist/esm/types.d.ts`).

**The SDK itself has no `ui://`-specific type or helper.** Read
`dist/esm/server/mcp.d.ts` in full: `McpServer.registerResource(name,
uriOrTemplate, config: ResourceMetadata, readCallback)` is fully generic —
`uriOrTemplate` is a bare `string`, `config.mimeType` is a bare optional
`string`. Nothing in the SDK recognizes or special-cases a `ui://` scheme.

**Core spec 2025-11-25 does not define UI resources either.** Fetched
[the official changelog](https://modelcontextprotocol.io/specification/2025-11-25/changelog)
directly — its "Major changes" and "Minor changes" lists (icons, OAuth
discovery, elicitation enums, URL-mode elicitation, sampling tool-calling,
experimental tasks, etc.) contain no UI-resource or "MCP Apps" item at all.

**"MCP Apps" is a separate, still-emerging extension**, not core protocol.
[mcpui.dev](https://mcpui.dev/guide/introduction)'s own docs say MCP-UI
"pioneered the concept... before MCP Apps existed as a standard" and that
current `@mcp-ui/*` packages "now implement the standardized MCP Apps
specification rather than defining it independently" — i.e. there are two
generations here: an informal community convention (`@mcp-ui/server`,
still widely referenced, including in this phase's own prompt), and a
newer, formal extension that supersedes it.

**The formal extension, as it exists today:**
[`@modelcontextprotocol/ext-apps`](https://github.com/modelcontextprotocol/ext-apps),
version `1.7.5` as installed by `npx @modelcontextprotocol/inspector`
(Inspector `2.6.0`), package description "MCP Apps SDK — Enable MCP
servers to display interactive user interfaces in conversational clients."
It has no changelog and no migration guide from the informal convention;
the only complete, current description of its wire contract is its own
shipped bundle (`dist/src/app-bridge.js`, minified — read directly, no
alternative). What it specifies:

- A tool opts a UI resource in via `_meta["ui/resourceUri"]` (the exported
  constant `RESOURCE_URI_META_KEY = "ui/resourceUri"`; a nested
  `_meta.ui.resourceUri` shape is also accepted) — the exported function
  `getToolUiResourceUri(tool)` reads exactly this, and is what MCP
  Inspector's own `--app-info` CLI flag and web "Apps" tab both call to
  decide a tool `hasApp`.
- The resource's canonical mimeType is the exported constant
  `RESOURCE_MIME_TYPE = "text/html;profile=mcp-app"` — not the plain
  `text/html` this phase's prompt specified (kept as `text/html` for the
  literal spike deliverable per the prompt; see Findings below for what
  changes if this ships for real).
- The UI, once loaded into its own frame, must perform a `ui/initialize`
  **JSON-RPC** request/response handshake over `postMessage` (`App.connect()`
  in `app-bridge.js`, method literal `"ui/initialize"`) before it is
  permitted to call anything — `App.callServerTool()` then sends a further
  real JSON-RPC request, `{jsonrpc:"2.0", id, method:"tools/call",
  params:{...}}`, over the same channel. A message that isn't a valid
  `JSONRPCMessage` (checked via `JSONRPCMessageSchema.safeParse` inside the
  bridge's own `postMessage` listener) is logged at `console.debug` and
  silently dropped — no error surfaces to the page that sent it.

If the exact SEP number for this extension exists, it was not findable
from the package itself or its GitHub org's issue search within this
phase's time-box; this is recorded plainly rather than guessed at.

### What was built

- `packages/mcp-app/src/render.ts` — `renderConsentCardText` and
  `renderConsentCardHtml`, both pure functions over the same
  `ConsentCardModel`, covered by snapshot tests. This is the part that
  survives regardless of the verdict below, and does: capability badges,
  before/after description text with `DiffSpan`-driven highlighting
  (`[[...]]` brackets in the text renderer, `<mark>` in the HTML renderer),
  an optional advisory line explicitly labelled "(model-generated)", and
  two buttons — Approve, Keep blocked — with an embedded `quarantineId` /
  `approvalToken`. No bulk-approve control, per the standing product rule.
- `packages/mcp-app/src/spike-server.ts` — the smallest Streamable HTTP
  MCP server (Express 5 + `StreamableHTTPServerTransport`) that exposes
  the literal surface this phase's prompt specified: resource
  `ui://chaperone/consent/demo` (`text/html`), tool
  `chaperone/approve_change`. One transport per session (see
  friction-log.md, Entry 008 — the first cut supported exactly one session
  for the process's whole lifetime, which broke on the second CLI
  connection during testing).

### What was tested, and what happened

**Host: MCP Inspector 2.6.0** (`npx @modelcontextprotocol/inspector`,
both `--cli` and `--web` modes), connected over Streamable HTTP at
`http://localhost:3300/mcp`.

1. `tools/list`, `resources/list`, `resources/read`, `tools/call` all
   succeeded via `inspector --cli` — the server is spec-conformant on the
   surface this phase asked for.
2. In the web UI's **Resources** tab, reading `ui://chaperone/consent/demo`
   renders the card exactly as `renderConsentCardHtml` produced it —
   capability badge, before/after text, the added clause highlighted in
   green, the advisory line — confirmed both visually and via "View
   Source" (byte-identical to the function's output). **This alone answers
   the spike's core question: yes, a real host renders this HTML.**
3. Clicking **Approve** in that view does nothing observable: no new
   message in Inspector's own protocol log, no `window.parent` message
   received by the top-level page (confirmed by injecting a `message`
   listener via dev tools before clicking). Reading the live DOM found why:
   that preview's `<iframe>` carries `sandbox=""` — every restriction
   token, i.e. **all script execution disabled**. The card's own `<script>`
   never runs there at all, independent of what it would have sent.
4. A second, throwaway probe server (not committed; identical card, plus
   `_meta: {"ui/resourceUri": "ui://chaperone/consent/demo"}` on the tool,
   and the `text/html;profile=mcp-app` mimetype) made Inspector's web UI
   grow a dedicated **Apps** tab, listing "Approve or block a changed
   tool." Opening it renders the same card inside a *different* iframe —
   served cross-origin from Inspector's own MCP-Apps sandbox process on a
   separate port, **no `sandbox` attribute at all**, scripts fully
   enabled. Confirmed via `tools/call` appearing in the protocol log the
   moment the app opened (Inspector calls the tool itself to obtain a
   result before rendering). But clicking **Approve** inside *this* surface
   still produced no new protocol-log entry — consistent with the
   root cause above: the card's `postMessage({type:"tool",...})` is not a
   `JSONRPCMessage`, so the bridge's own listener drops it silently.

**A second host was not available in this sandboxed environment.** No
Claude Desktop, ChatGPT Apps SDK client, or other MCP-Apps-capable host was
installed or reachable here. Both MCP Inspector's CLI and web UI were
exercised as thoroughly as a single host allows, but the "at least one
other host" half of this phase's instruction could not be completed
honestly — reported as a gap rather than padded with a fabricated result.

### Why PARTIAL, not GO or NO-GO

- Not **NO-GO**: rendering unambiguously works, on a real, current MCP
  host, both as a plain resource and — once wired correctly — as a formal
  MCP App. The static-render half of the twelve hours of downstream work
  is de-risked.
- Not **GO**: the interactive half — the actual reason a consent card
  needs buttons at all — does not work yet, and the reason is fully
  understood rather than mysterious.
- **PARTIAL, with the fix scoped:** two changes are needed before the real
  gateway's consent surface ships:
  1. Whatever tool surfaces "there is a pending change to review" must
     carry `_meta: {"ui/resourceUri": "<the card's ui:// uri>"}`, and the
     resource itself should serve `text/html;profile=mcp-app` rather than
     plain `text/html` — cheap, mechanical, already proven to work (Apps
     tab appears, sandbox restriction lifts).
  2. `render.ts`'s inline script must speak the real bridge protocol — a
     `ui/initialize` JSON-RPC request before anything else, then
     `tools/call` as a real JSON-RPC request over the same channel — not
     the informal `{type:"tool", payload:{...}}` shape. This is a bounded
     amount of hand-rollable vanilla JS (no bundler, no CDN, budget stays
     under the 12KB self-contained constraint), now that the exact message
     shapes are known; it was deliberately not attempted inside this
     six-hour spike's box, per the instruction to answer the render
     question first rather than build the full fix.

### Recommendation for the twelve hours of downstream P0 work

Do not reallocate away from the MCP App consent surface — the render half
works today, on a real host, and the interactive half has a named, bounded
fix rather than an open risk. Budget roughly 2–3 of the twelve hours for
the two changes above (tool `_meta` linkage + real handshake in
`render.ts`'s script) before the next integration checkpoint, and re-run
this same manual Inspector sequence (Apps tab → Open App → Approve) as the
acceptance check — a new `TOOLS/CALL chaperone/approve_change` entry in
Inspector's protocol log, fired by the button rather than by "Open App"
itself, is the signal that the fix landed.

### Fallback if the handshake costs more than projected

The 2–3 hour estimate above is a projection, not a guarantee — the
`ui/initialize` handshake has not actually been implemented yet, only
scoped. If it turns out to cost meaningfully more (a wire-format detail
the minified bundle didn't make obvious, a version skew between
`ext-apps@1.7.5` and whatever host the real demo runs against, etc.),
**the fallback is UX-04's structured-text path, and it already works
today.** `renderConsentCardText` (`packages/mcp-app/src/render.ts`) carries
the identical information as `renderConsentCardHtml` — tool name,
capability badge, approval date, both description texts with the changed
clause bracketed, the model-generated advisory line, and both actions —
as plain structured text, with no `postMessage` bridge, no `_meta` wiring,
and no host-rendering dependency at all. It was built and snapshot-tested
in this same phase specifically so the card would be an upgrade over a
working baseline, not a dependency on one.

**The demo is not blocked either way.** If the HTML round-trip fix lands
in the Phase 11 budget, the demo shows the interactive card. If it
doesn't, the demo shows the text card — same underlying model, same
content, no gap in what the resident sees or what the assistant can act
on. Nothing about the twelve-hour schedule, or the demo script, depends on
which of the two renderers ends up on screen.

### Evidence

See [`docs/spike/README.md`](spike/README.md) for why this entry has no
screen recording, and for the full reproducible transcript (raw CLI JSON,
exact DOM queries, exact click sequence) backing every claim above.

---

## MCP App fix landed — Phase 11 (2026-09-15)

**Verdict: GO. The interactive card works, in the real gateway, against a
real MCP Inspector 2.6.0, over both the resource-embedding path and the
tool `_meta` linkage.**

This supersedes the PARTIAL verdict above for the two named gaps only —
everything else in the Phase 6 entry (the render functions, the mechanism
survey, the fallback argument) stands unchanged.

Both fixes the Phase 6 spike scoped were implemented against the actual
`@modelcontextprotocol/ext-apps@1.7.5` package (pulled via `npm pack` and
read directly — see friction-log.md Entry 027 for what that surfaced that
this file's own Phase 6 findings hadn't):

1. `packages/gateway/src/firstPartyTools.ts`'s `APPROVE_CHANGE_TOOL._meta`
   now carries the resource link in both documented forms — the flat
   `MCP_APP_RESOURCE_URI_META_KEY` key this file originally named, and the
   nested `_meta.ui.resourceUri` form the package's own JSDoc marks
   preferred.
2. `packages/mcp-app/src/render.ts`'s inline script now performs the real
   `ui/initialize` → `ui/notifications/initialized` handshake over
   `postMessage`, then a real `tools/call` JSON-RPC request for
   Approve/Keep-blocked — copied from the package's own
   `message-transport.d.ts`/`spec.types.d.ts`, not the informal
   `@mcp-ui/server` convention.

The gateway registers `ui://chaperone/consent/{quarantineId}` as a real
resource template (`ListResourceTemplatesRequestSchema`,
`ReadResourceRequestSchema` on the low-level `Server` — the SDK still has
no `ui://`-specific helper, unchanged from the Phase 6 finding), and
`packages/gateway/src/consentCard.ts` is the one place that turns a
quarantine row into one of the seven card states (loading, pending,
advisory-unavailable, batch, approved, refused, expired), shared by the
refusal path and the resource-read path so they can't disagree.

**Live acceptance, against `docker compose up` (DynamoDB Local + real
demo-upstream + real gateway) and a real MCP Inspector 2.6.0:**

- `--cli --method tools/call --tool-name chaperone/approve_change
  --app-info` → `{"hasApp":true, "resourceUri":"ui://chaperone/consent/{quarantineId}"}`.
- The web UI's Apps tab lists `chaperone/approve_change` under "MCP Apps
  (1)" and opens it in the cross-origin MCP-Apps sandbox
  (`http://127.0.0.1:6275/sandbox`, confirmed via a real network request)
  — no `sandbox=""` restriction this time, unlike the Phase 6 finding.
- A live `resources/read` on a concrete (non-template) `ui://` URI returns
  `renderConsentCardHtml`'s output byte-for-byte, `text/html;profile=mcp-app`.
- The full mutate → refuse → card → approve → restore loop ran twice
  end-to-end against the live stack: once via `chaperone/pending_changes` +
  a direct `chaperone/approve_change` call (`grocery__add_item` excluded
  from `tools/list`, then restored after approval, `notifications/tools/list_changed`
  observed both in the CLI transcript and the web UI's protocol log), and
  once with `MCP_APP_ENABLED=false` on a second gateway instance, confirming
  the refusal drops to exactly two content blocks (frozen text + text card,
  no embedded resource) with everything else identical.
- One real gap found and left as a documented limitation, not worked
  around: Inspector's Apps-tab "Open App" staging flow does not perform
  RFC 6570 template expansion on a tool's static `_meta.ui.resourceUri` —
  it requested the literal string `ui://chaperone/consent/{quarantineId}`
  and got (correctly) a "no quarantine" error from the gateway. The
  underlying `tools/call` still fired and succeeded from the same form.
  See friction-log.md Entry 028. This does not affect the product's actual
  delivery path: the resolved card is embedded directly in the refusal
  result of the *tool that triggered the quarantine*, which never depends
  on a host resolving the template itself.

### Evidence

`pnpm test` (334), `pnpm spec` (26), and `pnpm test:stack` (11, including
all 10 resumption iterations against a freshly migrated stack — see
friction-log.md Entry 029 for a false alarm caused by a stale Docker volume
from manual testing, not a code defect) all pass. `packages/mcp-app/test/render.test.ts`
covers all seven card states plus XSS/RTL-override containment for both
renderers. `packages/gateway/test/consentCard.test.ts` covers state
selection (loading/advisory-unavailable timing, batch grouping, expiry,
approved/refused) against a mocked ledger. `packages/gateway/test/gateway.test.ts`
covers the `_meta` linkage, the resource template, the embedded resource
block, the `MCP_APP_ENABLED=false` fallback, and a 404 on an unknown
quarantine id, all against a real in-process gateway + demo-upstream.

## Console read path and approve path — Phase 14 (2026-09-19)

**Decision.** The console reads through five GET-only routes under the
gateway's `/api/*` (`packages/gateway/src/api.ts`). Its single write goes
through `chaperone/approve_change` over `/mcp`: the same `approveChange()`
the consent card reaches, called by the console as an ordinary MCP client
(`packages/console/src/mcp.ts`).

**Why not a console-only approve endpoint.** A second endpoint would be a
second approval mechanism, and the rest of the product exists to make sure
there is only one. A resident approving from the console proves possession
of the one-time token exactly as they would from the card.

**Why `/api` never serves the token.** Gate.ts still holds the plaintext
in memory for the consent card's benefit, so `/api/quarantine/:id` could
return it. Doing that would turn a read endpoint into an approval
capability for anyone who can issue a GET. The route exposes only
`tokenHeld: boolean`. The tests assert that neither the token nor its hash
appears in the response body.

**Why the queue sort lives server-side.** "Unscored first" is a policy
statement (an unscored item is not a safe item), and it should be testable
in one place (`sortQueue`, `packages/gateway/test/api.test.ts`), not
re-implemented per client. An advisory read failure sorts the row as
unscored, which pushes it toward more attention, not less.

**Why `listEvents` was added to the ledger package.** `verifyChain` already
walked the partition privately. `listEvents` exposes the same forward walk
read-only, so the rows the console shows are the rows the verifier checked.
No update or delete function was added, and `appendEvent` is still the only
write.

## Ledger hash covers the full event, not the payload — 2026-09-19

**What was wrong.** Since Phase 3, `appendEvent` stored `payloadHash =
sha256(canonical(payload))` and chained `prevEventHash` onto the previous
event's `payloadHash`. `type`, `actor`, `ts` and `prevEventHash` were
covered by no hash. Found while building the console (Phase 14), and
reproduced against real DynamoDB Local before the fix
(`spec/ledger-tamper.test.ts`, run on the old code: 3 of 4 failed):

- Editing an event's `type` → `verifyChain` returned `ok: true`.
- Editing an event's `actor` → `ok: true`.
- Deleting an event whose payload matched its neighbour's (gate.ts writes
  TOOL_QUARANTINED and CONSENT_SHOWN with byte-identical payloads) →
  `{ ok: true, count: 3 }`. The chain silently shrank and still verified,
  because both events had the same `payloadHash`.

**Decision.** The stored hash is now `eventHash = sha256(canonical({schema:
"chaperone/ledger-event@2", type, actor, ts, payload, prevEventHash}))`.
Folding in `prevEventHash` commits each event to its position, so identical
payloads no longer produce identical hashes, and a deletion, reorder or
splice breaks the successor's link. `verifyChain` checks both properties
and reports which one failed: `hash` (a field was edited), `link` (an event
was removed, reordered or inserted), or `unhashed` (the event predates this
rule). `sk` isn't hashed. Position is committed through `prevEventHash`,
and time through `ts`.

**Why the field was renamed.** `payloadHash` → `eventHash`, across the
ledger, the gateway's `/api/ledger`, and the console. Keeping the old name
on a hash that now covers five fields would invite a future reader to
reason from the old, weaker property.

**Legacy events are not re-hashed, and not skipped.** Re-hashing existing
items in place would mean rewriting them, which non-negotiable 6 forbids,
and it would launder exactly the evidence the chain exists to protect. An
event with no `eventHash` fails verification as `unhashed`: a chain that
can't be fully checked isn't reported as verified. DynamoDB Local's
`chaperone-ledger-event` table was dropped and re-migrated for a fresh chain
(the prior 19 events were snapshotted first with `pnpm ddb:dump`). No
deployed environment has ledger data yet, so this needs no migration there.

**Evidence.** `pnpm test:tamper` (real DynamoDB Local via the `aws` CLI,
Phase 3's tamper-and-restore pattern): 4/4 on the new code. The in-memory
unit tests add edited `ts`, a swapped pair, distinct hashes for
payload-identical neighbours, a legacy event, and per-field sensitivity of
`hashEvent`. On the fresh chain: `pnpm ddb:seed` → `pnpm verify-ledger`
"chain OK — 6 events verified", exit 0. After `pnpm pin:bootstrap`: 10
events, exit 0. A `type` edit on the fresh chain made `verify-ledger` exit
1 at index 3, and restoring it returned to OK.

**Gotcha found on the way.** Scripts under `packages/*/scripts` that import
`@chaperone/ledger` by package name resolve to its built `dist/`, not
`src/`. The first fresh-chain attempt ran `pnpm pin:bootstrap` before
`tsc -b`, so it appended 4 old-format events, which the new verifier
refused as `unhashed` at index 6. `ddb:seed` imports `../src` and wasn't
affected. After changing a package's source, run `pnpm build` before any
script that reaches it by package name.
