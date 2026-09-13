import type { CapabilityClass, DiffSpan } from "@chaperone/policy";

export interface ConsentCardModel {
  toolName: string;
  upstreamLabel: string;
  capabilityClass: CapabilityClass;
  approvedAt: string;
  beforeDescription: string;
  afterDescription: string;
  spans: DiffSpan[];
  advisorySummary?: string;
  quarantineId: string;
  approvalToken: string;
}

/**
 * Resident-facing badge copy for each capability class, ordered by
 * consequence to match packages/policy's PRECEDENCE order.
 */
const CAPABILITY_BADGES: Record<CapabilityClass, string> = {
  transact: "can transact",
  communicate: "can send messages",
  write: "can change your data",
  read: "reads only",
};

function spansForSide(spans: readonly DiffSpan[], side: DiffSpan["side"]): DiffSpan[] {
  return spans.filter((span) => span.side === side).sort((a, b) => a.start - b.start);
}

/**
 * Wraps each span's substring with open/close markers, applied from the
 * last span backward so earlier insertions never shift the offsets a later
 * (already-processed) span still needs to read from the original text.
 */
function wrapSpans(text: string, spans: readonly DiffSpan[], open: string, close: string): string {
  let result = text;
  for (const span of [...spans].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, span.start) + open + result.slice(span.start, span.end) + close + result.slice(span.end);
  }
  return result;
}

export function renderConsentCardText(model: ConsentCardModel): string {
  const before = wrapSpans(model.beforeDescription, spansForSide(model.spans, "before"), "[[", "]]");
  const after = wrapSpans(model.afterDescription, spansForSide(model.spans, "after"), "[[", "]]");

  const lines = [
    `Tool changed: ${model.toolName} (${model.upstreamLabel})`,
    `Capability: ${CAPABILITY_BADGES[model.capabilityClass]}`,
    `Approved: ${model.approvedAt}`,
    "",
    "Before:",
    before,
    "",
    "After:",
    after,
  ];

  if (model.advisorySummary !== undefined) {
    lines.push("", `Advisory (model-generated): ${model.advisorySummary}`);
  }

  lines.push(
    "",
    `[Approve] chaperone/approve_change quarantineId=${model.quarantineId} approvalToken=${model.approvalToken} decision=approve`,
    `[Keep blocked] chaperone/approve_change quarantineId=${model.quarantineId} approvalToken=${model.approvalToken} decision=block`,
  );

  return lines.join("\n");
}

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
 * unescaped source, so span boundaries always land between characters,
 * never inside an entity like &amp;.
 */
function wrapSpansHtml(text: string, spans: readonly DiffSpan[], className: string): string {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  let cursor = 0;
  let html = "";
  for (const span of sorted) {
    html += escapeHtml(text.slice(cursor, span.start));
    html += `<mark class="${className}">${escapeHtml(text.slice(span.start, span.end))}</mark>`;
    cursor = span.end;
  }
  html += escapeHtml(text.slice(cursor));
  return html;
}

/**
 * Escapes a value for embedding as a double-quoted string literal inside an
 * inline script block. Entity-escaping (escapeHtml) is wrong for this: a
 * script element's content is raw text, not HTML-attribute text, so
 * &quot; would appear verbatim rather than decoding back to a quote. This
 * also neutralizes the substring "</script" so the value can never
 * terminate the enclosing script element, and escapes the U+2028/U+2029
 * line terminators, which are legal inside a JS string literal but would
 * otherwise split it unexpectedly.
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

export function renderConsentCardHtml(model: ConsentCardModel): string {
  const beforeHtml = wrapSpansHtml(model.beforeDescription, spansForSide(model.spans, "before"), "diff-remove");
  const afterHtml = wrapSpansHtml(model.afterDescription, spansForSide(model.spans, "after"), "diff-add");
  const badge = CAPABILITY_BADGES[model.capabilityClass];
  const quarantineIdJs = escapeJsString(model.quarantineId);
  const approvalTokenJs = escapeJsString(model.approvalToken);

  const advisoryHtml =
    model.advisorySummary === undefined
      ? ""
      : `<p class="advisory"><span class="advisory-label">Advisory (model-generated):</span> ${escapeHtml(model.advisorySummary)}</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Chaperone consent card</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0;
    padding: 16px;
    font-family: -apple-system, "Segoe UI", Roboto, sans-serif;
    background: light-dark(#ffffff, #1b1b1f);
    color: light-dark(#1b1b1f, #f0f0f2);
  }
  .card { max-width: 480px; }
  .tool-name { font-size: 16px; font-weight: 600; margin: 0 0 4px; }
  .upstream { font-size: 13px; opacity: 0.7; margin: 0 0 12px; }
  .badge {
    display: inline-block;
    font-size: 12px;
    font-weight: 600;
    padding: 2px 10px;
    border-radius: 999px;
    background: light-dark(#fde68a, #78350f);
    color: light-dark(#78350f, #fde68a);
    margin-bottom: 12px;
  }
  .approved { font-size: 12px; opacity: 0.7; margin: 0 0 16px; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.6; margin: 16px 0 4px; }
  .desc { font-size: 14px; line-height: 1.5; margin: 0; white-space: pre-wrap; }
  mark.diff-remove { background: light-dark(#fecaca, #7f1d1d); color: inherit; text-decoration: line-through; }
  mark.diff-add { background: light-dark(#bbf7d0, #14532d); color: inherit; }
  .advisory { font-size: 13px; margin: 16px 0 0; padding: 8px 10px; border-left: 3px solid light-dark(#93c5fd, #1e40af); background: light-dark(#eff6ff, #172554); }
  .advisory-label { font-weight: 600; }
  .actions { margin-top: 20px; display: flex; gap: 8px; }
  button {
    font-size: 14px;
    font-weight: 600;
    padding: 10px 16px;
    border-radius: 8px;
    border: 1px solid transparent;
    cursor: pointer;
  }
  .approve { background: light-dark(#16a34a, #22c55e); color: #ffffff; }
  .block { background: transparent; border-color: light-dark(#d1d5db, #4b5563); color: inherit; }
</style>
</head>
<body>
<div class="card">
  <p class="tool-name">${escapeHtml(model.toolName)}</p>
  <p class="upstream">${escapeHtml(model.upstreamLabel)}</p>
  <span class="badge">${escapeHtml(badge)}</span>
  <p class="approved">Approved ${escapeHtml(model.approvedAt)}</p>
  <h2>Before</h2>
  <p class="desc">${beforeHtml}</p>
  <h2>After</h2>
  <p class="desc">${afterHtml}</p>
  ${advisoryHtml}
  <div class="actions">
    <button type="button" class="approve" id="approve-btn">Approve</button>
    <button type="button" class="block" id="block-btn">Keep blocked</button>
  </div>
</div>
<script>
  function invoke(decision) {
    window.parent.postMessage({
      type: "tool",
      payload: {
        toolName: "chaperone/approve_change",
        params: {
          quarantineId: "${quarantineIdJs}",
          approvalToken: "${approvalTokenJs}",
          decision: decision
        }
      }
    }, "*");
  }
  document.getElementById("approve-btn").addEventListener("click", function () { invoke("approve"); });
  document.getElementById("block-btn").addEventListener("click", function () { invoke("block"); });
</script>
</body>
</html>`;
}
