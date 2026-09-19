/** Small, quiet marks: capability, review state, field, error, skeleton. Nothing here animates. */
import type { ReactNode } from "react";
import { ApiError } from "../api";
import type { ReviewState } from "../types";

/**
 * Capability is encoded as ink density — hollow for read, half-inked for
 * write, fully inked for the two classes that act outside the household
 * (transact, communicate). Not a semantic colour: capability is what a
 * tool *can* do, not whether anything is wrong.
 */
const CAPABILITY_INK: Record<string, "hollow" | "half" | "full"> = {
  read: "hollow",
  write: "half",
  transact: "full",
  communicate: "full",
};

export function CapabilityBadge({ value }: { value: string }) {
  const ink = CAPABILITY_INK[value] ?? "hollow";
  const style =
    ink === "full"
      ? "bg-accent text-n-0"
      : ink === "half"
        ? "bg-[linear-gradient(90deg,var(--accent)_0_var(--space-2),var(--accent-wash)_var(--space-2))] text-accent pl-4"
        : "bg-n-0 text-accent";
  return (
    <span
      className={`label inline-flex items-center border-[length:var(--rule)] border-accent rounded-form px-2 py-px ${style}`}
      title={`Capability class: ${value} (from the pinned version, not the changed text)`}
    >
      {value}
    </span>
  );
}

const STATE: Record<ReviewState, { label: string; tone: string; note: string }> = {
  pending: { label: "Awaiting review", tone: "border-warn bg-warn-wash text-warn-ink", note: "Withheld from the assistant until a resident decides." },
  expired: { label: "Token expired", tone: "border-n-400 bg-n-100 text-n-600", note: "Still withheld. The approval token has passed its 24h window." },
  approved: { label: "Approved", tone: "border-ok bg-ok-wash text-ok", note: "Re-pinned under the new hash." },
  refused: {
    label: "Blocked",
    tone: "border-blocked bg-blocked-wash text-blocked",
    note: "Withheld for good for this exact change. The gateway won't ask about it again. If the tool changes again, that opens a new review.",
  },
};

export function StateMark({ state }: { state: ReviewState }) {
  const s = STATE[state];
  return (
    <span className={`label inline-flex items-center border-l-[length:var(--rule-heavy)] px-2 py-px ${s.tone}`} title={s.note}>
      {s.label}
    </span>
  );
}

export function stateNote(state: ReviewState): string {
  return STATE[state].note;
}

/** A printed form field: carbon label above typed value. */
export function Field({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={`min-w-0 ${className}`}>
      <div className="label">{label}</div>
      <div className="mt-1 min-w-0">{children}</div>
    </div>
  );
}

export function ErrorBox({ error, what }: { error: unknown; what: string }) {
  const status = error instanceof ApiError ? error.status : undefined;
  const headline =
    status === 0 ? "Gateway unreachable" : status === 503 ? "Storage unavailable" : status === 404 ? "Not found" : "Could not load";
  return (
    <div role="alert" className="box border-blocked bg-blocked-wash p-4">
      <div className="label text-blocked">{headline}</div>
      <p className="mt-1 text-n-800">
        {error instanceof Error ? error.message : `Could not load ${what}.`}
        {status !== 404 && " Nothing on this screen is treated as approved while it can't be read."}
      </p>
    </div>
  );
}

/** Loading frame: the shape of the rows to come, drawn as empty form boxes. No spinner. */
export function SkeletonRows({ rows = 3, label }: { rows?: number; label: string }) {
  return (
    <div aria-busy="true" aria-label={label} className="grid gap-2">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="box border-dashed border-n-200 h-14 flex items-center px-4">
          <span className="label text-n-400">{i === 0 ? label : " "}</span>
        </div>
      ))}
    </div>
  );
}
