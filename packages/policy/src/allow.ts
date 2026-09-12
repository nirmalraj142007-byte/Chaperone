import { hashTool } from "./canonical.js";
import type { ToolDefinition } from "./types.js";

export type AllowResult =
  | { allowed: true; hash: string }
  | {
      allowed: false;
      reason: "HASH_MISMATCH" | "UNPINNED";
      currentHash: string;
      pinnedHash: string | null;
    };

/**
 * The entire security property. Synchronous, no clock, no I/O, no config —
 * a hash computation and a string compare. Callers own everything else:
 * reading the pin from storage, deciding what a mismatch means, and failing
 * closed if that read itself fails.
 */
export function allow(current: ToolDefinition, pinnedHash: string | null): AllowResult {
  const currentHash = hashTool(current);

  if (pinnedHash === null) {
    return { allowed: false, reason: "UNPINNED", currentHash, pinnedHash: null };
  }

  if (currentHash === pinnedHash) {
    return { allowed: true, hash: currentHash };
  }

  return { allowed: false, reason: "HASH_MISMATCH", currentHash, pinnedHash };
}
