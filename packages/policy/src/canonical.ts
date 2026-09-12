import { createHash } from "node:crypto";
import { canonicalizeJson } from "./jcs.js";
import type { ToolDefinition } from "./types.js";

/**
 * Only these three fields ever enter the hash. Vendor metadata, annotations,
 * and anything else an upstream tacks onto a tool object must never affect
 * it — each such field would otherwise become a false drift signal the
 * moment an unrelated field changes.
 */
interface CanonicalToolShape {
  name: string;
  description: string;
  inputSchema: unknown;
}

function toCanonicalShape(tool: ToolDefinition): CanonicalToolShape {
  return {
    name: tool.name,
    // undefined and "" are the same claim ("no description"); both must
    // canonicalize identically or a vendor toggling between them would
    // register as drift.
    description: tool.description ?? "",
    inputSchema: tool.inputSchema,
  };
}

export function canonicalizeTool(tool: ToolDefinition): string {
  const shape = toCanonicalShape(tool);
  const canonical = canonicalizeJson(shape);
  // canonicalize() only returns undefined for a top-level undefined/function
  // input; `shape` is always a plain object, so this is unreachable.
  if (canonical === undefined) {
    throw new TypeError("canonicalizeTool: tool definition could not be canonicalized");
  }
  return canonical;
}

/**
 * The shared hash primitive: sha256 over an already-canonicalized JSON
 * string, prefixed `sha256:`. `hashTool` and `@chaperone/ledger`'s
 * `appendEvent` both call this over their own canonicalized input — the
 * canonicalize-then-hash pipeline is identical either way, only the shape
 * being canonicalized differs (a tool definition vs. an event payload).
 */
export function hashCanonicalJson(canonicalJson: string): string {
  const digest = createHash("sha256").update(canonicalJson, "utf8").digest("hex");
  return `sha256:${digest}`;
}

export function hashTool(tool: ToolDefinition): string {
  return hashCanonicalJson(canonicalizeTool(tool));
}
