import type { CapabilityClass, DiffSpan } from "@chaperone/policy";
export * from "./protocol.js";

export type ConsentCardState =
  | "loading"
  | "pending"
  | "advisory-unavailable"
  | "batch"
  | "approved"
  | "refused"
  | "expired";

/**
 * One quarantined tool's worth of before/after content. `advisorySummary`
 * is only ever read by the "pending" state's renderer — "loading" and
 * "advisory-unavailable" carry an item with it left `undefined` by
 * construction (the caller in packages/gateway/src/consentCard.ts is what
 * enforces that, not this type), and "batch" carries a per-item optional
 * summary since a batch can have some items advised and others not.
 */
export interface ConsentCardItem {
  quarantineId: string;
  toolName: string;
  upstreamLabel: string;
  capabilityClass: CapabilityClass;
  detectedAt: string;
  beforeDescription: string;
  afterDescription: string;
  spans: DiffSpan[];
  approvalToken: string;
  advisorySummary?: string;
}

export type ConsentCardModel =
  | { state: "loading"; item: ConsentCardItem }
  | { state: "pending"; item: ConsentCardItem }
  | { state: "advisory-unavailable"; item: ConsentCardItem }
  | { state: "batch"; upstreamLabel: string; items: ConsentCardItem[] }
  | { state: "approved"; toolName: string; upstreamLabel: string; newHashPrefix: string }
  | { state: "refused"; toolName: string; upstreamLabel: string }
  | { state: "expired"; toolName: string; upstreamLabel: string; detectedAt: string };

/** Resident-facing badge copy for each capability class, ordered by consequence to match packages/policy's PRECEDENCE order. */
const CAPABILITY_BADGES: Record<CapabilityClass, string> = {
  transact: "can transact",
  communicate: "can send messages",
  write: "can change your data",
  read: "reads only",
};

/**
 * Unicode control characters that are invisible or reorder text without
 * changing what characters are visibly present: RTL/LTR direction marks and
 * overrides (U+200E/U+200F, U+202A-U+202E), directional isolates
 * (U+2066-U+2069), and zero-width characters (U+200B zero-width space,
 * U+200C/U+200D joiners, U+2060 word joiner, U+FEFF zero-width no-break
 * space / BOM). Each is exactly one UTF-16 code unit, so replacing every
 * occurrence with a space preserves string length and therefore every
 * `DiffSpan` offset computed against the untouched original in
 * packages/policy/src/diff.ts — stripping them outright (rather than
 * substituting a same-width character) would shift every span after the
 * first occurrence and misalign the highlight from the text it's meant to
 * cover. An upstream tool description is untrusted third-party input: a
 * direction-override character can visually reorder rendered text enough to
 * hide an added clause inside what still *looks* like the original
 * sentence, and a zero-width character can split a word to defeat a naive
 * keyword match on the raw string.
 */
// eslint-disable-next-line no-irregular-whitespace -- the character class itself is the point: these are the invisible/reordering codepoints being neutralized.
const INVISIBLE_CONTROL_CHARS = /[​-‏‪-‮⁠⁦-⁩﻿]/g;

function sanitizeUpstreamText(text: string): string {
  return text.replace(INVISIBLE_CONTROL_CHARS, " ");
}

function truncateHash(hash: string): string {
  return hash.slice(0, 12);
}

/** Resident-facing cap on a rendered description — see truncateForRender. */
const MAX_DESCRIPTION_CHARS = 4000;

/**
 * Caps an upstream-controlled description before it reaches span-wrapping
 * or the DOM. A hostile or merely careless upstream can return an
 * arbitrarily large description — the 12KB whole-card budget asserted in
 * render.test.ts has no enforcement behind it without this — and an
 * unbounded string embedded in an MCP App resource or a plain-text tool
 * result is a real resource-exhaustion vector on whatever renders it.
 * Truncating (not rejecting) keeps the card informative: the resident still
 * sees the start of both sides of the diff, and the truncation marker names
 * exactly where to find the rest.
 */
function truncateForRender(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_DESCRIPTION_CHARS) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, MAX_DESCRIPTION_CHARS), truncated: true };
}

/** Drops or clips spans that fall partly or wholly past a truncation cut, so wrapSpansText/wrapSpansHtml is never asked to read past the text it was given. */
function clipSpansToLength(spans: readonly DiffSpan[], maxLen: number): DiffSpan[] {
  return spans.filter((span) => span.start < maxLen).map((span) => (span.end > maxLen ? { ...span, end: maxLen } : span));
}

function truncationNoteText(truncated: boolean, quarantineId: string): string {
  return truncated ? `\n[... truncated at 4,000 characters — full text: /queue/${quarantineId}]` : "";
}

function truncationNoteHtml(truncated: boolean, quarantineId: string): string {
  return truncated
    ? ` <span class="truncated">[truncated at 4,000 characters — <a href="/queue/${escapeHtml(quarantineId)}">full text</a>]</span>`
    : "";
}

function spansForSide(spans: readonly DiffSpan[], side: DiffSpan["side"]): DiffSpan[] {
  return spans.filter((span) => span.side === side).sort((a, b) => a.start - b.start);
}

// --- text renderer -----------------------------------------------------

/**
 * Wraps each span with a diff-style marker, applied from the last span
 * backward so earlier insertions never shift the offsets a later
 * (already-processed) span still needs to read from the original text.
 */
function wrapSpansText(text: string, spans: readonly DiffSpan[]): string {
  let result = text;
  for (const span of [...spans].sort((a, b) => b.start - a.start)) {
    const open = span.kind === "add" ? "{+" : "{-";
    const close = span.kind === "add" ? "+}" : "-}";
    result = result.slice(0, span.start) + open + result.slice(span.start, span.end) + close + result.slice(span.end);
  }
  return result;
}

function textBeforeAfter(item: ConsentCardItem): string[] {
  const beforeT = truncateForRender(sanitizeUpstreamText(item.beforeDescription));
  const afterT = truncateForRender(sanitizeUpstreamText(item.afterDescription));
  const beforeSpans = clipSpansToLength(spansForSide(item.spans, "before"), beforeT.text.length);
  const afterSpans = clipSpansToLength(spansForSide(item.spans, "after"), afterT.text.length);
  return [
    "Before:",
    wrapSpansText(beforeT.text, beforeSpans) + truncationNoteText(beforeT.truncated, item.quarantineId),
    "",
    "After:",
    wrapSpansText(afterT.text, afterSpans) + truncationNoteText(afterT.truncated, item.quarantineId),
  ];
}

function textActions(item: ConsentCardItem): string[] {
  return [
    "",
    `[Approve] chaperone/approve_change quarantineId=${item.quarantineId} approvalToken=${item.approvalToken} decision=approve`,
    `[Keep blocked] chaperone/approve_change quarantineId=${item.quarantineId} approvalToken=${item.approvalToken} decision=block`,
  ];
}

function textItemBlock(item: ConsentCardItem): string {
  const toolName = sanitizeUpstreamText(item.toolName);
  const lines = [
    `Tool changed: ${toolName} (${sanitizeUpstreamText(item.upstreamLabel)})`,
    `Capability: ${CAPABILITY_BADGES[item.capabilityClass]}`,
    `Detected: ${item.detectedAt}`,
    "",
    ...textBeforeAfter(item),
  ];
  if (item.advisorySummary !== undefined) {
    lines.push("", `Advisory (model-generated): ${sanitizeUpstreamText(item.advisorySummary)}`);
  }
  lines.push(...textActions(item));
  return lines.join("\n");
}

export function renderConsentCardText(model: ConsentCardModel): string {
  switch (model.state) {
    case "loading":
      return [
        `Tool changed: ${sanitizeUpstreamText(model.item.toolName)} (${sanitizeUpstreamText(model.item.upstreamLabel)})`,
        `Capability: ${CAPABILITY_BADGES[model.item.capabilityClass]}`,
        `Detected: ${model.item.detectedAt}`,
        "",
        ...textBeforeAfter(model.item),
        "",
        "Advisory: preparing a summary of this change... (re-check chaperone/pending_changes shortly)",
        ...textActions(model.item),
      ].join("\n");

    case "pending":
    case "advisory-unavailable":
      return textItemBlock(model.item);

    case "batch": {
      const header = `${model.items.length} tool changes are pending review for ${sanitizeUpstreamText(model.upstreamLabel)}. Each one is reviewed and decided on its own; none of them can be decided together.`;
      return [header, "", ...model.items.map((item) => textItemBlock(item))].join("\n\n---\n\n");
    }

    case "approved":
      return [
        `Approved: ${sanitizeUpstreamText(model.toolName)} (${sanitizeUpstreamText(model.upstreamLabel)})`,
        `The new definition is now pinned as ${truncateHash(model.newHashPrefix)}.`,
      ].join("\n");

    case "refused":
      return [
        `Kept blocked: ${sanitizeUpstreamText(model.toolName)} (${sanitizeUpstreamText(model.upstreamLabel)})`,
        "Nothing from this tool will run. Call chaperone/pending_changes to review it again if you change your mind.",
      ].join("\n");

    case "expired":
      return [
        `Expired: ${sanitizeUpstreamText(model.toolName)} (${sanitizeUpstreamText(model.upstreamLabel)})`,
        `This change was detected ${model.detectedAt} and its one-time approval token is no longer valid.`,
        "The tool stays withheld. Call chaperone/pending_changes to open a fresh review.",
      ].join("\n");
  }
}

// --- html renderer -------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .split("&")
    .join("&amp;")
    .split("<")
    .join("&lt;")
    .split(">")
    .join("&gt;")
    .split('"')
    .join("&quot;")
    .split("'")
    .join("&#39;");
}

/**
 * Escapes the text first, then wraps spans by offsets measured against the
 * unescaped (but bidi-sanitized) source, so span boundaries always land
 * between characters, never inside an entity like &amp;. Uses semantic
 * `<ins>`/`<del>` rather than a generic `<mark>` — this card's signature
 * element is an underline/strike-through on the clause itself, not a
 * colored highlight block.
 */
function wrapSpansHtml(text: string, spans: readonly DiffSpan[]): string {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  let cursor = 0;
  let html = "";
  for (const span of sorted) {
    html += escapeHtml(text.slice(cursor, span.start));
    const tag = span.kind === "add" ? "ins" : "del";
    const cls = span.kind === "add" ? "clause-add" : "clause-remove";
    html += `<${tag} class="${cls}">${escapeHtml(text.slice(span.start, span.end))}</${tag}>`;
    cursor = span.end;
  }
  html += escapeHtml(text.slice(cursor));
  return html;
}

/**
 * Escapes a value for embedding as a double-quoted string literal inside an
 * inline script block. Entity-escaping (escapeHtml) is wrong for this: a
 * script element's content is raw text, not HTML-attribute text, so &quot;
 * would appear verbatim rather than decoding back to a quote. This also
 * neutralizes the substring "</script" so the value can never terminate the
 * enclosing script element, and escapes the U+2028/U+2029 line terminators,
 * which are legal inside a JS string literal but would otherwise split it
 * unexpectedly.
 */
function escapeJsString(text: string): string {
  const lineSeparator = String.fromCharCode(0x2028);
  const paragraphSeparator = String.fromCharCode(0x2029);
  return text
    .split("\\")
    .join("\\\\")
    .split('"')
    .join('\\"')
    .split("<")
    .join("\\u003C")
    .split(lineSeparator)
    .join("\\u2028")
    .split(paragraphSeparator)
    .join("\\u2029");
}

const CARD_STYLE = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 16px;
  font-family: -apple-system, "Segoe UI", Roboto, sans-serif;
  background: light-dark(#ECEAE4, #201F1C);
  color: light-dark(#232321, #ECE9E2);
  direction: ltr;
}
.card {
  max-width: 480px;
  margin: 0 auto;
  background: light-dark(#F7F5F0, #2A2925);
  border-radius: 10px;
  overflow: hidden;
  unicode-bidi: isolate;
}
.strip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  background: light-dark(#F1DDB8, #4A3A1E);
  border-left: 5px solid light-dark(#B4700F, #E0A857);
}
.eyebrow {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: light-dark(#7A4C0A, #E0A857);
}
.badge {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid light-dark(#B4700F, #E0A857);
  color: light-dark(#7A4C0A, #E0A857);
}
.body { padding: 16px; }
.tool-name { font-size: 20px; font-weight: 650; letter-spacing: -0.01em; margin: 0 0 2px; }
.upstream { font-size: 13px; color: light-dark(#6B6862, #A39E93); margin: 0 0 4px; }
.meta {
  font-family: ui-monospace, "Cascadia Code", "SFMono-Regular", Menlo, Consolas, monospace;
  font-size: 12px;
  color: light-dark(#6B6862, #A39E93);
  margin: 0 0 16px;
}
h2 {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: light-dark(#6B6862, #A39E93);
  margin: 16px 0 4px;
}
.desc { font-size: 15px; line-height: 1.5; margin: 0; white-space: pre-wrap; }
.truncated { font-size: 12px; font-style: italic; color: light-dark(#6B6862, #A39E93); }
.truncated a { color: inherit; }
ins.clause-add {
  text-decoration: underline;
  text-decoration-thickness: 2px;
  text-underline-offset: 2px;
  text-decoration-color: light-dark(#3F5D3A, #8FB886);
  background: light-dark(#DCE6D6, #2B3A28);
  color: inherit;
}
del.clause-remove {
  text-decoration: line-through;
  text-decoration-color: light-dark(#8C4A3A, #D08A76);
  background: light-dark(#EEDCD6, #3D2A24);
  color: inherit;
}
.advisory {
  margin: 20px 0 0;
  padding-top: 12px;
  border-top: 1px dashed light-dark(#D9D5C9, #3A3833);
  font-size: 13px;
  color: light-dark(#35566B, #8FB8CC);
}
.advisory-label { font-weight: 600; letter-spacing: 0.02em; }
.advisory-body { color: light-dark(#232321, #ECE9E2); margin-top: 2px; }
.advisory-skeleton {
  height: 13px;
  width: 70%;
  margin-top: 6px;
  border-radius: 4px;
  background: linear-gradient(
    90deg,
    light-dark(#DCE6EC, #24333B) 25%,
    light-dark(#EAF0F3, #33454F) 50%,
    light-dark(#DCE6EC, #24333B) 75%
  );
  background-size: 200% 100%;
  animation: chaperone-shimmer 1.4s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) { .advisory-skeleton { animation: none; } }
@keyframes chaperone-shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
.actions { margin-top: 20px; display: flex; flex-direction: column; gap: 8px; }
button {
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.01em;
  padding: 12px 16px;
  border-radius: 8px;
  border: 1px solid transparent;
  cursor: pointer;
  width: 100%;
}
.approve { background: light-dark(#3F5D3A, #8FB886); color: light-dark(#ffffff, #14201A); }
.approve:hover { background: light-dark(#35502F, #A0C797); }
.approve:focus-visible { outline: 3px solid light-dark(#8FB8CC, #35566B); outline-offset: 2px; }
.approve:active { background: light-dark(#2C4126, #7EA675); }
.approve:disabled { opacity: 0.6; cursor: not-allowed; }
.block {
  background: transparent;
  border-color: light-dark(#B8B3A6, #4B4941);
  color: inherit;
}
.block:hover { background: light-dark(#ECE9E2, #322F2A); }
.block:focus-visible { outline: 3px solid light-dark(#8FB8CC, #35566B); outline-offset: 2px; }
.block:active { background: light-dark(#DFDBCE, #3A3833); }
.block:disabled { opacity: 0.6; cursor: not-allowed; }
.outcome { padding: 16px; font-size: 14px; }
.outcome-title { font-weight: 650; font-size: 16px; margin: 0 0 4px; }
.outcome.approved .outcome-title { color: light-dark(#3F5D3A, #8FB886); }
.outcome.refused .outcome-title,
.outcome.expired .outcome-title { color: light-dark(#8C4A3A, #D08A76); }
.hash { font-family: ui-monospace, "Cascadia Code", "SFMono-Regular", Menlo, Consolas, monospace; font-size: 13px; }
details.batch-item { border-top: 1px solid light-dark(#D9D5C9, #3A3833); }
details.batch-item:first-of-type { border-top: none; }
details.batch-item > summary {
  padding: 12px 16px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 600;
  list-style: none;
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
details.batch-item > summary::-webkit-details-marker { display: none; }
details.batch-item > summary:focus-visible { outline: 3px solid light-dark(#8FB8CC, #35566B); outline-offset: -3px; }
details.batch-item[open] > summary { padding-bottom: 4px; }
.batch-item .body { padding-top: 4px; }
.batch-note { padding: 10px 16px; font-size: 12px; color: light-dark(#6B6862, #A39E93); border-top: 1px solid light-dark(#D9D5C9, #3A3833); }
`;

/**
 * Vanilla-JS view side of the real `@modelcontextprotocol/ext-apps@1.7.5`
 * bridge, hand-rolled rather than imported: the card ships as one
 * self-contained inline `<script>` under the 12KB budget with no bundler
 * and no external request, and the npm package pulls in its own transitive
 * dependency graph. The message shapes below (method names, request/notify
 * framing, `postMessage(..., "*")`) are copied from the package's own
 * `dist/src/message-transport.d.ts` and `dist/src/spec.types.d.ts` rather
 * than the informal `@mcp-ui/server` convention the phase 6 spike shipped —
 * see docs/DECISIONS.md, "MCP App mechanism", for why that convention is
 * silently dropped by a real `ext-apps` host's own `postMessage` listener.
 *
 * Handshake: send `ui/initialize` (a real JSON-RPC request) and wait for its
 * response, then send `ui/notifications/initialized` (a notification, no
 * id). Only after that does `tools/call` get sent. A host that never
 * responds (a plain HTML preview with no bridge) leaves every button
 * inert rather than throwing — there is nothing to invoke without a host on
 * the other end of the channel.
 */
function bridgeScript(): string {
  return `
function initChaperoneBridge(){
  var pending = {};
  var nextId = 1;
  function post(msg){ window.parent.postMessage(msg, "*"); }
  function request(method, params){
    return new Promise(function(resolve, reject){
      var id = nextId++;
      pending[id] = { resolve: resolve, reject: reject };
      post({ jsonrpc: "2.0", id: id, method: method, params: params });
    });
  }
  function notify(method){ post({ jsonrpc: "2.0", method: method }); }
  window.addEventListener("message", function(event){
    var msg = event.data;
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") return;
    if (typeof msg.id === "undefined") return;
    var p = pending[msg.id];
    if (!p) return;
    delete pending[msg.id];
    if (msg.error) p.reject(new Error(msg.error.message || "request failed"));
    else p.resolve(msg.result);
  });
  var ready = request("ui/initialize", {
    appInfo: { name: "chaperone-consent-card", version: "1.0.0" },
    appCapabilities: { tools: { listChanged: false } },
    protocolVersion: "2025-11-25"
  }).then(function(){ notify("ui/notifications/initialized"); }).catch(function(err){
    console.debug("chaperone consent card: no MCP App host detected", err);
  });
  return {
    callApprove: function(quarantineId, approvalToken, decision){
      return ready.then(function(){
        return request("tools/call", {
          name: "chaperone/approve_change",
          arguments: { quarantineId: quarantineId, approvalToken: approvalToken, decision: decision }
        });
      });
    },
    teardown: function(){ notify("ui/notifications/request-teardown"); }
  };
}
var chaperoneApp = initChaperoneBridge();
function chaperoneBindDecision(root, quarantineId, approvalToken){
  var approveBtn = root.querySelector(".approve");
  var blockBtn = root.querySelector(".block");
  var pendingEl = root.querySelector(".pending-content");
  function settle(decision, resultText){
    var outcome = document.createElement("div");
    outcome.className = "outcome " + (decision === "approve" ? "approved" : "refused");
    var title = document.createElement("p");
    title.className = "outcome-title";
    title.textContent = decision === "approve" ? "Approved" : "Kept blocked";
    var body = document.createElement("p");
    body.textContent = resultText;
    outcome.appendChild(title);
    outcome.appendChild(body);
    pendingEl.replaceWith(outcome);
    if (decision === "approve") {
      setTimeout(function(){
        outcome.style.transition = "opacity 400ms";
        outcome.style.opacity = "0";
        setTimeout(function(){ chaperoneApp.teardown(); }, 400);
      }, 4000);
    }
  }
  function invoke(decision){
    approveBtn.disabled = true;
    blockBtn.disabled = true;
    chaperoneApp.callApprove(quarantineId, approvalToken, decision).then(function(result){
      var text = (result && result.content && result.content[0] && result.content[0].text) || "Recorded.";
      settle(decision, text);
    }).catch(function(err){
      approveBtn.disabled = false;
      blockBtn.disabled = false;
      console.error("chaperone consent card: approve_change failed", err);
    });
  }
  approveBtn.addEventListener("click", function(){ invoke("approve"); });
  blockBtn.addEventListener("click", function(){ invoke("block"); });
}
`;
}

function badgeAndStrip(item: Pick<ConsentCardItem, "capabilityClass">, eyebrow: string): string {
  return `<div class="strip"><span class="eyebrow">${escapeHtml(eyebrow)}</span><span class="badge">${escapeHtml(CAPABILITY_BADGES[item.capabilityClass])}</span></div>`;
}

/** The batch header names how many changes are waiting, not a single capability — a batch can mix read/write/transact tools, so no one capability badge would be honest here. */
function batchStripHtml(count: number): string {
  return `<div class="strip"><span class="eyebrow">Changed</span><span class="badge">${count} tools</span></div>`;
}

function beforeAfterHtml(item: ConsentCardItem): string {
  const beforeT = truncateForRender(sanitizeUpstreamText(item.beforeDescription));
  const afterT = truncateForRender(sanitizeUpstreamText(item.afterDescription));
  const beforeSpans = clipSpansToLength(spansForSide(item.spans, "before"), beforeT.text.length);
  const afterSpans = clipSpansToLength(spansForSide(item.spans, "after"), afterT.text.length);
  const beforeHtml = wrapSpansHtml(beforeT.text, beforeSpans) + truncationNoteHtml(beforeT.truncated, item.quarantineId);
  const afterHtml = wrapSpansHtml(afterT.text, afterSpans) + truncationNoteHtml(afterT.truncated, item.quarantineId);
  return `<h2>Before</h2><p class="desc">${beforeHtml}</p><h2>After</h2><p class="desc">${afterHtml}</p>`;
}

/** The interactive item markup shared by "pending" and each expanded row of "batch". `advisorySlot` is the caller's choice of skeleton, filled line, or nothing. */
function itemCardHtml(item: ConsentCardItem, advisorySlot: string, rootId: string): string {
  const quarantineIdJs = escapeJsString(item.quarantineId);
  const approvalTokenJs = escapeJsString(item.approvalToken);
  return `<div class="pending-content" id="${rootId}">
  ${badgeAndStrip(item, "Changed")}
  <div class="body">
    <p class="tool-name">${escapeHtml(sanitizeUpstreamText(item.toolName))}</p>
    <p class="upstream">${escapeHtml(sanitizeUpstreamText(item.upstreamLabel))}</p>
    <p class="meta">Detected ${escapeHtml(item.detectedAt)}</p>
    ${beforeAfterHtml(item)}
    ${advisorySlot}
    <div class="actions">
      <button type="button" class="approve">Approve</button>
      <button type="button" class="block">Keep blocked</button>
    </div>
  </div>
</div>
<script>chaperoneBindDecision(document.getElementById("${rootId}").parentNode, "${quarantineIdJs}", "${approvalTokenJs}");</script>`;
}

function advisorySkeletonHtml(): string {
  return `<div class="advisory"><span class="advisory-label">Advisory (model-generated)</span><div class="advisory-skeleton"></div></div>`;
}

function advisoryFilledHtml(summary: string): string {
  return `<div class="advisory"><span class="advisory-label">Advisory (model-generated)</span><p class="advisory-body">${escapeHtml(sanitizeUpstreamText(summary))}</p></div>`;
}

function documentShell(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>${CARD_STYLE}</style>
</head>
<body>
<div class="card">
${bodyHtml}
</div>
<script>${bridgeScript()}</script>
</body>
</html>`;
}

function outcomeHtml(kind: "approved" | "refused" | "expired", title: string, body: string): string {
  return `<div class="outcome ${kind}"><p class="outcome-title">${escapeHtml(title)}</p><p>${body}</p></div>`;
}

export function renderConsentCardHtml(model: ConsentCardModel): string {
  switch (model.state) {
    case "loading": {
      const rootId = "chaperone-item";
      return documentShell(
        "Chaperone consent card",
        itemCardHtml(model.item, advisorySkeletonHtml(), rootId),
      );
    }

    case "pending": {
      const rootId = "chaperone-item";
      const advisory =
        model.item.advisorySummary === undefined ? "" : advisoryFilledHtml(model.item.advisorySummary);
      return documentShell("Chaperone consent card", itemCardHtml(model.item, advisory, rootId));
    }

    case "advisory-unavailable": {
      const rootId = "chaperone-item";
      return documentShell("Chaperone consent card", itemCardHtml(model.item, "", rootId));
    }

    case "batch": {
      const rows = model.items
        .map((item, index) => {
          const advisory = item.advisorySummary === undefined ? "" : advisoryFilledHtml(item.advisorySummary);
          const rootId = `chaperone-item-${index}`;
          return `<details class="batch-item"${index === 0 ? " open" : ""}>
  <summary><span>${escapeHtml(sanitizeUpstreamText(item.toolName))}</span><span class="badge">${escapeHtml(CAPABILITY_BADGES[item.capabilityClass])}</span></summary>
  <div class="body pending-content" id="${rootId}">
    <p class="meta">Detected ${escapeHtml(item.detectedAt)}</p>
    ${beforeAfterHtml(item)}
    ${advisory}
    <div class="actions">
      <button type="button" class="approve">Approve</button>
      <button type="button" class="block">Keep blocked</button>
    </div>
  </div>
</details>
<script>chaperoneBindDecision(document.getElementById("${rootId}").closest("details"), "${escapeJsString(item.quarantineId)}", "${escapeJsString(item.approvalToken)}");</script>`;
        })
        .join("\n");
      return documentShell(
        "Chaperone consent card",
        `${batchStripHtml(model.items.length)}\n${rows}\n<p class="batch-note">Each change is reviewed and decided on its own; none of them can be decided together.</p>`,
      );
    }

    case "approved": {
      const body = outcomeHtml(
        "approved",
        "Approved",
        `${escapeHtml(sanitizeUpstreamText(model.toolName))} is now pinned as <span class="hash">${escapeHtml(truncateHash(model.newHashPrefix))}</span>.`,
      );
      return documentShell(
        "Chaperone consent card",
        `${body}<script>setTimeout(function(){ chaperoneApp.teardown(); }, 4000);</script>`,
      );
    }

    case "refused":
      return documentShell(
        "Chaperone consent card",
        outcomeHtml(
          "refused",
          "Kept blocked",
          `Nothing from ${escapeHtml(sanitizeUpstreamText(model.toolName))} will run. Call <span class="hash">chaperone/pending_changes</span> to review it again.`,
        ),
      );

    case "expired":
      return documentShell(
        "Chaperone consent card",
        outcomeHtml(
          "expired",
          "Expired",
          `This change to ${escapeHtml(sanitizeUpstreamText(model.toolName))} was detected ${escapeHtml(model.detectedAt)} and its approval token is no longer valid. The tool stays withheld — call <span class="hash">chaperone/pending_changes</span> to open a fresh review.`,
        ),
      );
  }
}
