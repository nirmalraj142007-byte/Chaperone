import { ConsentCard, type Decide } from "./ConsentCard";
import type { Entry } from "../useAssistant";

function Sender({ children }: { children: string }) {
  return <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted">{children}</p>;
}

/** One line of the transcript. Every role has its own look, and none of them re-words what the gateway said. */
export function Message({ entry, decide }: { entry: Entry; decide: Decide }) {
  switch (entry.role) {
    case "resident":
      return (
        <li className="flex justify-end" data-role="resident">
          <div className="max-w-[85%]">
            <p className="mb-1 text-right text-xs font-medium uppercase tracking-wide text-muted">You</p>
            <p className="whitespace-pre-wrap rounded-2xl rounded-br-sm bg-brand px-4 py-2 text-white">{entry.text}</p>
          </div>
        </li>
      );

    case "assistant":
      return (
        <li className="flex justify-start" data-role="assistant">
          <div className="max-w-[85%]">
            <Sender>Assistant (rule-based stand-in)</Sender>
            <p className="whitespace-pre-wrap rounded-2xl rounded-bl-sm border border-line bg-surface px-4 py-2">{entry.text}</p>
          </div>
        </li>
      );

    case "tool":
      return (
        <li data-role="tool" data-ok={entry.ok}>
          <div className={`rounded-lg border-l-4 px-4 py-3 ${entry.ok ? "border-ok bg-ok-wash" : "border-bad bg-bad-wash"}`}>
            <p className={`mb-1 text-xs font-medium uppercase tracking-wide ${entry.ok ? "text-ok" : "text-bad"}`}>
              {entry.ok ? "Tool result" : "Tool error"} · <span className="font-mono normal-case">{entry.tool}</span> · {entry.ms} ms
            </p>
            <pre className="whitespace-pre-wrap break-words font-mono text-sm" data-testid="tool-text">{entry.text}</pre>
          </div>
        </li>
      );

    case "held":
      return (
        <li data-role="held">
          <div className="rounded-lg border-2 border-held-line bg-held-wash p-4">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-held">
              Chaperone · <span className="font-mono normal-case">{entry.tool}</span> did not run · {entry.ms} ms
            </p>
            <p className="rounded bg-surface px-3 py-2 font-medium text-ink" data-testid="refusal">{entry.refusal}</p>
            <p className="mb-3 mt-2 text-xs text-held">
              Fixed wording, shown as written: the same words every time. It was not composed by a model, and the decision behind it was a hash comparison.
            </p>
            <ConsentCard card={entry.card} decide={decide} />
          </div>
        </li>
      );

    case "notice":
      return (
        <li data-role="notice">
          <p
            className={`rounded-lg px-4 py-2 text-sm ${entry.tone === "error" ? "bg-bad-wash text-bad" : "bg-brand-wash text-brand"}`}
            role={entry.tone === "error" ? "alert" : "status"}
          >
            {entry.text}
          </p>
        </li>
      );
  }
}
