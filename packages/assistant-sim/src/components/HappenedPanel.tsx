import { useState, type ReactNode } from "react";
import type { CallRecord, ConnectionState } from "../useAssistant";

const RESULT_TEXT: Record<CallRecord["result"], string> = {
  ran: "ran",
  held: "not run: held by the gateway",
  error: "error result",
  approved: "approval recorded",
  "kept-blocked": "kept blocked",
};

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_1fr] gap-2 py-1">
      <dt className="text-muted">{label}</dt>
      <dd className="m-0 min-w-0 break-words">{children}</dd>
    </div>
  );
}

/**
 * The plain account of the last few calls. It states only what was
 * observed on the wire: which tool, which rule of the stand-in asked for it,
 * how long the round trip took, and what came back. A "held" row says the
 * gateway compared hashes; it never says anything decided.
 */
export function HappenedPanel({ connection, calls }: { connection: ConnectionState; calls: readonly CallRecord[] }) {
  const [open, setOpen] = useState(() => (typeof window.matchMedia === "function" ? window.matchMedia("(min-width: 1024px)").matches : true));
  const recent = [...calls].reverse().slice(0, 8);

  return (
    <aside className="rounded-xl border border-line bg-surface" aria-label="What just happened">
      <h2 className="m-0 text-base">
        <button
          type="button"
          className="flex min-h-11 w-full items-center justify-between rounded-xl px-4 py-2 text-left font-semibold"
          aria-expanded={open}
          aria-controls="happened-body"
          onClick={() => setOpen(!open)}
        >
          <span>What just happened</span>
          <span aria-hidden="true">{open ? "−" : "+"}</span>
        </button>
      </h2>
      {open && (
        <div id="happened-body" className="border-t border-line px-4 pb-4 pt-3 text-sm" data-testid="happened">
          <p className="mb-3 rounded bg-held-wash px-3 py-2 text-held">
            The assistant here is a <strong>rule-based stand-in for the assistant&rsquo;s model &mdash; not part of Chaperone</strong>. It matches fixed
            phrases to tool calls; no model chose any of them. Whether a tool runs is decided by the gateway comparing a hash, with no model involved.
          </p>

          <h3 className="mb-1 mt-3 text-xs font-semibold uppercase tracking-wide text-muted">Connection</h3>
          {connection.state === "connecting" && <p role="status">Connecting…</p>}
          {connection.state === "unreachable" && <p className="text-bad">Not connected: {connection.message}</p>}
          {connection.state === "ready" && (
            <dl className="m-0">
              <Row label="Endpoint">
                MCP Streamable HTTP, <span className="font-mono">{connection.info.url}</span>
              </Row>
              <Row label="Session ID">
                <span className="font-mono text-xs" data-testid="session-id">
                  {connection.info.sessionId ?? "(none)"}
                </span>
              </Row>
              <Row label="Protocol">
                <span className="font-mono" data-testid="protocol-version">
                  {connection.info.protocolVersion ?? "(unknown)"}
                </span>
              </Row>
              <Row label="Server">{connection.info.server ?? "(unknown)"}</Row>
              <Row label="Connect">initialize + tools/list, {connection.connectMs} ms</Row>
              <Row label="Tools listed">
                {connection.tools.length === 0
                  ? "none"
                  : connection.tools.map((tool) => (
                      <span key={tool} className="mr-2 inline-block font-mono text-xs">
                        {tool}
                      </span>
                    ))}
              </Row>
            </dl>
          )}

          <h3 className="mb-1 mt-4 text-xs font-semibold uppercase tracking-wide text-muted">Calls, newest first</h3>
          {recent.length === 0 ? (
            <p className="m-0 text-muted">No tool has been called yet.</p>
          ) : (
            <ol className="m-0 list-none space-y-2 p-0" data-testid="calls">
              {recent.map((call) => (
                <li key={call.id} className="rounded border border-line px-3 py-2" data-result={call.result}>
                  <p className="m-0 font-mono text-xs font-semibold">{call.tool}</p>
                  <p className="m-0">
                    {RESULT_TEXT[call.result]} · <span data-testid="latency">{call.ms} ms</span>
                  </p>
                  <p className="m-0 text-xs text-muted">
                    {call.at} · asked for by {call.via === "card" ? "the consent card" : `stand-in rule “${call.via}”`}
                    {call.requestId !== undefined && (
                      <>
                        {" "}
                        · request <span className="font-mono">{call.requestId}</span>
                      </>
                    )}
                  </p>
                  {call.result === "held" && (
                    <p className="m-0 mt-1 text-xs text-held">
                      The gateway compared this tool&rsquo;s current definition hash with the one you approved. They differ, so the call was not forwarded.
                    </p>
                  )}
                </li>
              ))}
            </ol>
          )}
          <p className="mb-0 mt-3 text-xs text-muted">Latency is the round trip as this browser saw it, through the local proxy.</p>
        </div>
      )}
    </aside>
  );
}
