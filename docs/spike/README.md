# Phase 6 spike evidence

This directory holds the evidence backing the GO/PARTIAL/NO-GO verdict in
[`docs/DECISIONS.md`](../DECISIONS.md#mcp-app-go-no-go--phase-6-spike-2026-09-13).

## No screen recording

This phase's acceptance checklist asks for a screen recording of any host
that renders the card interactively, "or a written explanation of why none
exists." This session ran in a sandboxed, headless-by-default development
environment with no OS-level screen recorder and no tool that persists a
Browser-pane screenshot to disk (the pane returns images inline for the
agent to look at, not files it can write out). What follows instead is the
full reproducible transcript: exact commands, exact raw JSON responses,
and exact DOM queries, run in the order shown, against
`packages/mcp-app/src/spike-server.ts` running on `localhost:3300` and MCP
Inspector 2.6.0 (`npx @modelcontextprotocol/inspector`). Anyone with Docker
and Node 24 can re-run every line below verbatim and get the same result —
which is a stronger, not weaker, form of evidence than an unannotated
video would have been.

## 1. Spec-conformance surface (CLI)

```
$ npx @modelcontextprotocol/inspector --cli http://localhost:3300/mcp --method tools/list --format json
{"result":{"tools":[{"name":"chaperone/approve_change","title":"Approve or block a changed tool","description":"Records a household member's decision on a quarantined tool-definition change.","inputSchema":{"type":"object","properties":{"quarantineId":{"type":"string","minLength":1},"approvalToken":{"type":"string","minLength":1},"decision":{"type":"string","enum":["approve","block"]}},"required":["quarantineId","approvalToken","decision"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"},"execution":{"taskSupport":"forbidden"}}]}}

$ npx @modelcontextprotocol/inspector --cli http://localhost:3300/mcp --method resources/list --format json
{"result":{"resources":[{"name":"chaperone-consent-demo","title":"Chaperone consent card (demo)","uri":"ui://chaperone/consent/demo","description":"Before/after consent card for a tool description that changed after approval.","mimeType":"text/html"}]}}

$ npx @modelcontextprotocol/inspector --cli http://localhost:3300/mcp --method tools/call --tool-name "chaperone/approve_change" --tool-arg quarantineId=quarantine-demo-1 approvalToken=approval-token-demo-1 decision=approve --format json
{"result":{"content":[{"type":"text","text":"Recorded decision \"approve\" for quarantine quarantine-demo-1."}]}}
```

Each of these three commands was its own OS process (a fresh `initialize`
each time) against one already-running server — this only works because
`spike-server.ts` keeps one `StreamableHTTPServerTransport` per session
(see `friction-log.md`, Entry 008; the first cut supported exactly one
session ever and broke on the second CLI invocation).

## 2. Static rendering (web UI, Resources tab)

Connected Inspector's web UI (`http://127.0.0.1:6274`) to
`http://localhost:3300/mcp` as a Streamable HTTP server, opened the
**Resources** tab, selected "Chaperone consent card (demo)". The preview
pane rendered:

- Tool name `add_item`, upstream label `Household Grocery`
- Capability badge reading **"can change your data"**
- "Approved 2026-01-12"
- The before description unchanged; the after description with `Also
  reads the household calendar and includes upcoming events in the
  response.` highlighted in green
- The advisory line, prefixed **"Advisory (model-generated):"**
- Two buttons, **Approve** and **Keep blocked**

"View Source" on the same resource showed the literal HTML byte-for-byte
identical to `renderConsentCardHtml`'s output (confirmed by diffing
against the function's own snapshot test in
`packages/mcp-app/test/render.test.ts`).

## 3. Buttons don't round-trip in the plain resource preview

Before clicking, ran this in the page's own devtools console to catch
anything the card's script might send:

```js
window.__captured = [];
window.addEventListener('message', (e) => { window.__captured.push({origin: e.origin, data: e.data}); });
document.querySelectorAll('iframe').length;
// => 1
```

Clicked **Approve**. No new entry appeared in Inspector's own
client↔server protocol log. Re-read the capture:

```js
JSON.stringify(window.__captured);
// => "[]"
```

Inspected the live iframe element directly:

```js
document.querySelector('iframe').outerHTML.slice(0, 300);
// => '<iframe class="" title="HTML preview" src="blob:http://127.0.0.1:6274/b9a4979b-72b9-430f-8f6f-c32ae1872fab" sandbox="" style="border: 0rem; width: 100%; height: calc(25rem * var(--mantine-scale)); display: block;"></iframe>'
```

`sandbox=""` — the empty sandbox attribute is the *most* restrictive form
(every restriction token applies, including disabling script execution
entirely). The card's own `<script>` never ran in this view, which fully
explains step 3 independent of the message shape it would have sent.

## 4. Wiring the tool to the resource unlocks a different, unsandboxed surface

Built a throwaway probe server (not committed — same card, same tool,
plus `_meta: {"ui/resourceUri": "ui://chaperone/consent/demo"}` on the
tool's registration and `text/html;profile=mcp-app` as the resource's
mimetype) on `localhost:3301`, confirmed via Inspector's own detector:

```
$ npx @modelcontextprotocol/inspector --cli http://localhost:3301/mcp --method tools/list --app-info --format json
{"hasApp":true,"toolName":"chaperone/approve_change","resourceUri":"ui://chaperone/consent/demo","resourceMimeType":"text/html;profile=mcp-app"}
```

Connecting this server in the web UI grew a new top-level **Apps** tab —
"MCP Apps (1): Approve or block a changed tool." Filling the tool's input
(`quarantineId`, `approvalToken`, `decision`) and clicking **Open App**
rendered the identical card inside a different iframe:

```js
Array.from(document.querySelectorAll('iframe')).map(f => ({src: f.src, sandbox: f.getAttribute('sandbox'), title: f.title}));
// => [{ src: "http://127.0.0.1:6275/sandbox", sandbox: null, title: "Approve or block a changed tool" }]
```

`sandbox: null` — no restriction at all; this frame is served from
Inspector's own dedicated MCP-Apps sandbox process on a separate port, and
scripts run. Opening the app itself produced a real `TOOLS/CALL
chaperone/approve_change` entry in the protocol log (Inspector calls the
tool to obtain the result it renders the app around).

## 5. But the button still doesn't round-trip — root cause confirmed

Clicked **Approve** inside this unsandboxed Apps surface. No new entry
appeared in the protocol log — the same symptom as step 3, but this time
scripts were provably running, isolating the cause to the message's shape
rather than its ability to execute at all. Reading
`@modelcontextprotocol/ext-apps@1.7.5`'s own bundled `dist/src/app-bridge.js`
directly confirmed why: the bridge's `postMessage` listener parses incoming
messages with `JSONRPCMessageSchema.safeParse` and silently
`console.debug`s-and-drops anything that isn't a valid `{jsonrpc:"2.0",
...}` message. `render.ts`'s current script sends
`{type:"tool", payload:{toolName, params}}` — the `@mcp-ui/server`-style
informal convention this phase's prompt described — which fails that parse
and is dropped with no error visible to the page that sent it.

This is the exact, complete explanation for the PARTIAL verdict, and the
exact target for the follow-on fix: replace the inline script's
`postMessage` call with a real `ui/initialize` → `tools/call` JSON-RPC
handshake. See `docs/DECISIONS.md` for the fix scope and the recommended
re-verification step.
