import { useRef, useState, type FormEvent } from "react";

export function Composer({ disabled, busy, onSend }: { disabled: boolean; busy: boolean; onSend: (text: string) => void }) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  function submit(event: FormEvent): void {
    event.preventDefault();
    if (disabled || busy || text.trim().length === 0) return;
    onSend(text);
    setText("");
    inputRef.current?.focus();
  }

  return (
    <form onSubmit={submit} className="flex gap-2" aria-label="Ask the household assistant">
      <label htmlFor="utterance" className="sr-only">
        Ask the household assistant
      </label>
      <input
        id="utterance"
        ref={inputRef}
        type="text"
        autoComplete="off"
        value={text}
        onChange={(event) => setText(event.target.value)}
        disabled={disabled}
        placeholder={disabled ? "Reconnect to keep talking" : 'Try "Add batteries to my list"'}
        className="min-h-11 min-w-0 flex-1 rounded-lg border-2 border-control bg-surface px-3 text-base"
      />
      <button type="submit" className="btn btn-primary" disabled={disabled || busy || text.trim().length === 0}>
        Send
      </button>
    </form>
  );
}
