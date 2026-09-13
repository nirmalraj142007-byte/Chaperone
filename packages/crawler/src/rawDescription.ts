import type { SourceServer } from "./types.js";

interface RawWithDescription {
  server?: { description?: string };
  description?: string;
}

/**
 * Recovers the human-written description text from a source's raw payload.
 * assemble.ts deliberately doesn't persist this into candidates.json (it's
 * not part of the corpus schema), but the crawler's on-disk HTTP cache keeps
 * the original responses around, so re-running a source's fetchAll() against
 * a warm cache recovers it with zero new network calls.
 */
export function descriptionOf(entry: SourceServer): string {
  const raw = entry.raw as RawWithDescription;
  if (raw.server?.description) {
    return raw.server.description;
  }
  if (typeof raw.description === "string") {
    return raw.description;
  }
  return "";
}
