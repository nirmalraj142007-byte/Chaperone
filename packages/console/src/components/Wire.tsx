/**
 * The wire: a docked strip showing every request the console just made —
 * channel, method, path (or JSON-RPC method), status, latency, and the
 * gateway's X-Request-Id. Collapsed it shows the latest hop; expanded, the
 * last 60. This is how the console shows its work: there is no model in
 * the loop to narrate, so it shows the calls themselves.
 */
import { useState } from "react";
import { useWire, type WireEntry } from "../wire";

function tone(e: WireEntry): string {
  if (e.error === "closed") return "text-n-400";
  if (e.error !== undefined || (e.status !== undefined && e.status >= 500)) return "text-blocked";
  if (e.status !== undefined && e.status >= 400) return "text-warn-ink";
  if (e.status === undefined) return "text-n-400";
  return "text-ok";
}

function Line({ e }: { e: WireEntry }) {
  return (
    <div className="grid grid-cols-[3.5rem_2.25rem_minmax(0,1fr)_3rem] items-baseline gap-x-3 sm:grid-cols-[3.5rem_3rem_minmax(0,1fr)_3rem_4rem_9rem]">
      <span className={`label ${e.channel === "mcp" ? "text-accent" : "text-n-600"}`}>{e.channel}</span>
      <span className="hash text-n-600">{e.method}</span>
      <span className="hash truncate text-n-900" title={e.rpc ?? e.path}>
        {e.path}
        {e.rpc !== undefined && <span className="text-accent"> · {e.rpc}</span>}
      </span>
      <span className={`hash text-right ${tone(e)}`}>{e.error ?? e.status ?? "…"}</span>
      <span className="num hidden text-right text-n-800 sm:inline">{e.ms !== undefined ? `${e.ms}ms` : ""}</span>
      <span className="hash hidden truncate text-n-400 sm:inline" title={e.requestId ? `X-Request-Id ${e.requestId}` : undefined}>
        {e.requestId ?? ""}
      </span>
    </div>
  );
}

export function Wire() {
  const entries = useWire();
  const [open, setOpen] = useState(false);
  const latest = entries[entries.length - 1];

  return (
    <section
      aria-label="Wire: requests this console made"
      className="sticky bottom-0 z-10 border-t-[length:var(--rule)] border-accent bg-n-0"
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="micro flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-accent-wash active:bg-n-100 sm:px-6"
      >
        <span className="label shrink-0">Wire</span>
        <span className="label shrink-0 text-n-400">{entries.length}</span>
        <span className="min-w-0 flex-1">{latest && !open ? <Line e={latest} /> : null}</span>
        <span className="label shrink-0 text-n-600" aria-hidden>
          {open ? "Hide" : "Show"}
        </span>
      </button>
      {open && (
        <div className="max-h-[40vh] overflow-y-auto border-t-[length:var(--rule)] border-n-100 px-4 py-2 sm:px-6">
          <div className="hidden gap-x-3 pb-1 sm:grid sm:grid-cols-[3.5rem_3rem_minmax(0,1fr)_3rem_4rem_9rem]">
            {["chan", "verb", "path · rpc", "status", "latency", "x-request-id"].map((h, i) => (
              <span key={h} className={`label text-n-400 ${i === 3 || i === 4 ? "text-right" : ""}`}>
                {h}
              </span>
            ))}
          </div>
          <div className="grid gap-1">
            {[...entries].reverse().map((e) => (
              <Line key={e.id} e={e} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
