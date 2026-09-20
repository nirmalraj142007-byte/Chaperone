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

/**
 * The error state: a sentence a resident can act on, a retry, and — where
 * one exists — the committed file that holds the same numbers. /corpus and
 * /bench read committed JSON, so "the gateway is down" never means "the
 * evidence is gone"; saying where it is turns a dead end into a next step.
 */
export function ErrorBox({
  error,
  what,
  onRetry,
  alsoIn,
}: {
  error: unknown;
  what: string;
  onRetry?: () => void;
  alsoIn?: string;
}) {
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
      {alsoIn !== undefined && (
        <p className="mt-2 text-1 text-n-600">
          The numbers are also in <span className="hash text-n-900">{alsoIn}</span>, committed to this repository — this screen
          reads that file at build time, so a checkout has them even when nothing is running.
        </p>
      )}
      {onRetry !== undefined && (
        <button
          type="button"
          onClick={onRetry}
          className="micro label mt-3 rounded-form border-[length:var(--rule)] border-blocked bg-n-0 px-3 py-2 text-blocked hover:bg-blocked-wash active:translate-y-px"
        >
          Try again
        </button>
      )}
    </div>
  );
}

/**
 * The empty state. Always says what would put something here — an empty
 * screen that explains itself is a status report; one that doesn't is a
 * bug report. `tone="ok"` is for the empties that are the healthy outcome,
 * chiefly an empty review queue.
 */
export function EmptyState({
  label,
  children,
  tone = "neutral",
  height,
}: {
  label: string;
  children: ReactNode;
  tone?: "ok" | "neutral";
  height?: string;
}) {
  return (
    <div
      className={`box border-dashed p-6 ${tone === "ok" ? "border-ok bg-ok-wash" : "border-n-200"}`}
      style={height !== undefined ? { minHeight: height } : undefined}
    >
      <div className={`label ${tone === "ok" ? "text-ok" : "text-n-600"}`}>{label}</div>
      <div className="mt-1 max-w-[52rem] text-n-800">{children}</div>
    </div>
  );
}

/**
 * Loading frame: the shape of the rows to come, drawn as empty form boxes
 * at the row height the real rows will use. The height comes from a shared
 * token (`--row-*`) rather than a literal, so the skeleton cannot drift
 * away from the row it stands in for and the list does not jump when the
 * data lands.
 */
export function SkeletonRows({ rows = 3, label, height = "var(--row-queue)" }: { rows?: number; label: string; height?: string }) {
  return (
    <div aria-busy="true" aria-label={label} className="grid gap-2">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="box border-dashed border-n-200 flex items-center px-4" style={{ height }}>
          <span className="label text-n-400">{i === 0 ? label : " "}</span>
        </div>
      ))}
    </div>
  );
}

/** A single skeleton panel at an explicit height, for the non-list regions (charts, the track, a detail card). */
export function SkeletonBlock({ label, height, className = "" }: { label: string; height: string; className?: string }) {
  return (
    <div
      aria-busy="true"
      aria-label={label}
      className={`box border-dashed border-n-200 flex items-start px-4 py-3 ${className}`}
      style={{ height }}
    >
      <span className="label text-n-400">{label}</span>
    </div>
  );
}
