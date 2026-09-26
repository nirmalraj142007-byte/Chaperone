import { useEffect, useRef, useState } from "react";
import { Composer } from "./components/Composer";
import { HappenedPanel } from "./components/HappenedPanel";
import { Message } from "./components/Message";
import { EXAMPLE_PHRASES } from "./rules";
import { speechSupported, stopSpeaking } from "./speech";
import { useAssistant } from "./useAssistant";

function HouseGlyph() {
  return (
    <svg width="36" height="36" viewBox="0 0 36 36" aria-hidden="true" focusable="false">
      <circle cx="18" cy="18" r="18" fill="var(--color-brand)" />
      <path d="M9 18.5 18 10l9 8.5V26a1 1 0 0 1-1 1H10a1 1 0 0 1-1-1z" fill="#fff" />
      <rect x="15" y="20" width="6" height="7" fill="var(--color-brand)" />
    </svg>
  );
}

export function App() {
  const [speechOn, setSpeechOn] = useState(false);
  const { entries, calls, connection, busy, send, retry, decide } = useAssistant(speechOn);
  const endRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLOListElement>(null);
  const canSpeak = speechSupported();

  useEffect(() => {
    // A refusal is the moment the resident needs to read from the top (the frozen words, then the card),
    // so when the newest thing said is one, pin its top in view; otherwise follow the conversation down.
    const newestSaid = [...entries].reverse().find((entry) => entry.role !== "notice");
    const held = transcriptRef.current?.querySelectorAll('[data-role="held"]');
    const target = newestSaid?.role === "held" ? held?.item(held.length - 1) : undefined;
    if (target) target.scrollIntoView({ block: "start" });
    else endRef.current?.scrollIntoView({ block: "end" });
  }, [entries, busy]);

  const ready = connection.state === "ready";

  return (
    <div className="mx-auto flex min-h-dvh max-w-6xl flex-col px-4 pb-4 sm:px-6 lg:h-dvh">
      <header className="flex flex-wrap items-center justify-between gap-3 py-4">
        <div className="flex items-center gap-3">
          <HouseGlyph />
          <div>
            <h1 className="m-0 text-xl font-semibold leading-tight">Simulated Alexa+ experience</h1>
            <p className="m-0 text-sm text-muted">A household assistant, simulated on a web page</p>
          </div>
        </div>
        <label className={`flex items-center gap-2 text-sm ${canSpeak ? "" : "text-muted"}`}>
          <input
            type="checkbox"
            role="switch"
            className="h-5 w-5 accent-[var(--color-brand)]"
            checked={speechOn}
            disabled={!canSpeak}
            onChange={(event) => {
              setSpeechOn(event.target.checked);
              if (!event.target.checked) stopSpeaking();
            }}
          />
          {canSpeak ? "Speak replies aloud" : "Speaking replies is not supported in this browser"}
        </label>
      </header>

      <p className="mb-4 rounded-lg border border-held-line bg-held-wash px-4 py-2 text-sm text-held" role="note" data-testid="simulation-banner">
        <strong>This is a simulation.</strong> The assistant is a <strong>rule-based stand-in for the assistant&rsquo;s model &mdash; not part of Chaperone</strong>: it
        matches fixed phrases to tool calls. Everything it calls goes through the real Chaperone gateway over MCP. Not made by or affiliated with Amazon.
      </p>

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_23rem]">
        <section className="flex h-[75dvh] min-h-0 flex-col rounded-xl border border-line bg-bg lg:h-auto" aria-label="Conversation">
          <div className="flex-1 overflow-y-auto p-4" aria-busy={busy || connection.state === "connecting"}>
            {connection.state === "connecting" && (
              <div role="status" className="space-y-3">
                <p className="m-0">Connecting to the household gateway…</p>
                <div className="h-10 w-2/3 animate-pulse rounded-2xl bg-line/60" />
                <div className="h-10 w-1/2 animate-pulse rounded-2xl bg-line/60" />
              </div>
            )}

            {connection.state === "unreachable" && entries.length === 0 && (
              <div role="alert" className="rounded-lg border-2 border-bad bg-bad-wash p-4 text-bad" data-testid="gateway-unreachable">
                <h2 className="m-0 mb-1 text-lg">The gateway can&rsquo;t be reached</h2>
                <p className="m-0 mb-2">
                  {connection.kind === "session-lost" ? "The gateway no longer knows this session." : "Nothing answered on /mcp."} Nothing was sent, and no tool was run.
                </p>
                <p className="m-0 mb-3 font-mono text-xs">{connection.message}</p>
                <p className="m-0 mb-3 text-sm">
                  Is the demo stack running? From the repo: <span className="font-mono">docker compose up -d</span>, then <span className="font-mono">pnpm demo:reset</span>.
                </p>
                <button type="button" className="btn btn-primary" onClick={retry}>
                  Try again
                </button>
              </div>
            )}

            {ready && entries.length === 0 && (
              <div data-testid="empty-state">
                <h2 className="mb-1 mt-0 text-lg">Ask me about your shopping list</h2>
                <p className="mt-0 text-muted">I only understand a few phrases, because I&rsquo;m a stand-in and not a model. Tap one, or type it.</p>
                <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
                  {EXAMPLE_PHRASES.map((example) => (
                    <li key={example.phrase}>
                      <button type="button" className="chip" onClick={() => void send(example.phrase)} disabled={busy} title={example.effect}>
                        {example.phrase}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {entries.length > 0 && (
              <ol ref={transcriptRef} className="m-0 list-none space-y-3 p-0" role="log" aria-live="polite" aria-relevant="additions" aria-label="Conversation transcript">
                {entries.map((entry) => (
                  <Message key={entry.id} entry={entry} decide={decide} />
                ))}
              </ol>
            )}

            {connection.state === "unreachable" && entries.length > 0 && (
              <div className="mt-3">
                <button type="button" className="btn btn-primary" onClick={retry}>
                  Reconnect to the gateway
                </button>
              </div>
            )}

            {busy && (
              <p className="dots mb-0 mt-3 text-sm text-muted" role="status" aria-label="Waiting for the gateway">
                <span />
                <span />
                <span />
              </p>
            )}
            <div ref={endRef} />
          </div>
          <div className="border-t border-line p-3">
            <Composer disabled={!ready} busy={busy} onSend={(text) => void send(text)} />
          </div>
        </section>

        <div className="min-h-0 lg:overflow-y-auto">
          <HappenedPanel connection={connection} calls={calls} />
        </div>
      </div>
    </div>
  );
}
