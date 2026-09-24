/**
 * The pure half of `pnpm check-placeholders` (scripts/check-placeholders.ts):
 * finds `{{PENDING: <what> — <when>}}` markers in a block of prose.
 *
 * A marker is how committed prose says "this number has not been measured
 * yet" without inventing one. The marker is expected to exist until the
 * measurement does (crawl 2 on 2026-10-20 for drift and baseline 2, the AWS
 * run for production latency), so the guard is a pre-submission step and is
 * deliberately NOT in CI. See docs/TESTING.md.
 *
 * A line that documents the marker syntax itself, rather than standing in
 * for a value, opts out with the literal text `check-placeholders:allow`
 * anywhere on that line, the same escape hatch `check-claims` has.
 */

export const PLACEHOLDER_ALLOW_MARKER = "check-placeholders:allow";

/** Matches `{{PENDING: ...}}` on one line; lazy, so two markers on a line are two matches. */
const PLACEHOLDER_PATTERN = /\{\{\s*PENDING\s*:[^}]*\}\}/gi;

export interface PlaceholderHit {
  /** 1-based line number. */
  line: number;
  text: string;
  matched: string;
}

export function findPlaceholders(source: string): PlaceholderHit[] {
  const hits: PlaceholderHit[] = [];
  source.split("\n").forEach((text, index) => {
    if (text.includes(PLACEHOLDER_ALLOW_MARKER)) {
      return;
    }
    for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
      hits.push({ line: index + 1, text, matched: match[0] });
    }
  });
  return hits;
}
