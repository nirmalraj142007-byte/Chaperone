/** Pure helpers for the screens — no React, no fetch, unit-tested in test/lib.test.ts. */
import type { DiffSpan, VerifyResponse } from "./types";

export interface Segment {
  text: string;
  mark: "add" | "remove" | null;
}

/**
 * Splits `text` into plain and marked runs using the stored `diffSpans` for
 * one side. Spans come from @chaperone/policy's describeDiff at detection
 * time and are applied verbatim — the console never re-diffs. Overlapping
 * or out-of-range spans are clamped rather than trusted, so a malformed row
 * can mis-highlight but can never drop or duplicate characters of the
 * verbatim text.
 */
export function segmentsFor(text: string, spans: readonly DiffSpan[], side: DiffSpan["side"]): Segment[] {
  const own = spans.filter((s) => s.side === side).sort((a, b) => a.start - b.start);
  const out: Segment[] = [];
  let cursor = 0;
  for (const span of own) {
    const start = Math.max(cursor, Math.min(span.start, text.length));
    const end = Math.max(start, Math.min(span.end, text.length));
    if (start > cursor) {
      out.push({ text: text.slice(cursor, start), mark: null });
    }
    if (end > start) {
      out.push({ text: text.slice(start, end), mark: span.kind });
    }
    cursor = end;
  }
  if (cursor < text.length) {
    out.push({ text: text.slice(cursor), mark: null });
  }
  return out;
}

export type LinkState = "verified" | "broken" | "unverified" | "pending";

/**
 * One state per chain link. Before verification returns, every link is
 * `pending`. On a break at index N, links before N are verified, N is
 * broken, and everything after is `unverified` — the verifier stops at the
 * first break, so it vouches for nothing past it.
 */
export function linkStates(total: number, verify: VerifyResponse | undefined): LinkState[] {
  return Array.from({ length: total }, (_, i): LinkState => {
    if (verify === undefined) {
      return "pending";
    }
    if (verify.ok) {
      return "verified";
    }
    return i < verify.index ? "verified" : i === verify.index ? "broken" : "unverified";
  });
}

/** First `n` hex chars of a digest, with any "sha256:" scheme prefix dropped — the prefix is identical on every hash and carries no information at a glance. */
export function short(hash: string, n = 12): string {
  return hash.replace(/^sha256:/, "").slice(0, n);
}

const dateFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const timeFmt = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : dateFmt.format(d);
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : timeFmt.format(d);
}

/** "4m ago" / "3h ago" / "2d ago" — for scanning a queue, not for evidence (the full ISO is in the title attribute). */
export function ago(iso: string, now = Date.now()): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) {
    return "";
  }
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
