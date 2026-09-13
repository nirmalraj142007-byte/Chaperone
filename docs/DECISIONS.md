# Decisions

Durable, dated decision records for Chaperone. Each entry is written once,
at the time the decision was made, and not silently rewritten later —
if a decision changes, a new dated entry supersedes the old one and says so.

---

## MCP App go/no-go — Phase 6 spike (2026-09-13)

**Verdict: PARTIAL.**

A real MCP host renders the consent card's HTML *and* runs its inline
script, but the card's Approve/Keep-blocked buttons do not round-trip to a
real tool call, because the card was built against the informal
`@mcp-ui/server`-style `postMessage` convention named in this phase's
prompt, and the host being tested — MCP Inspector 2.6.0 — implements a
different, more recent, formally JSON-RPC-based bridge instead. The gap is
fully diagnosed (exact `_meta` key, exact mimetype, exact handshake — see
below), not an open question, so this is a scoped two-part fix, not a
rediscovery cost, for whoever picks up the next twelve hours of P0 work.

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

### Evidence

See [`docs/spike/README.md`](spike/README.md) for why this entry has no
screen recording, and for the full reproducible transcript (raw CLI JSON,
exact DOM queries, exact click sequence) backing every claim above.
