/**
 * Grouping of labelling items whose edit is identical, so a person answers once
 * for "the same change" seen on many tools.
 *
 * Two items are in one group when BOTH of these are equal:
 *   - the description edit: the same removed word runs and the same added word
 *     runs (the changed spans only, whitespace collapsed, not the unchanged text
 *     around them), and
 *   - the input-schema change: the same property-level difference lines.
 *
 * This module only groups. It reads no proposed class and says nothing about
 * what a group should be labelled: the answer is the person's, and is applied to
 * every member of the group they answered for.
 */
import { createHash } from "node:crypto";
import { describeDiff } from "@chaperone/policy";
import type { TodoItem } from "./labels.js";
import { describeSchemaChange } from "./render.js";

export interface LabelGroup {
  /** First 12 hex characters of the SHA-256 of `signature`. Stable across runs. */
  id: string;
  /** Canonical JSON of the edit: what the members have in common. */
  signature: string;
  /** Members in the order they appeared in the input. Never empty. */
  items: TodoItem[];
}

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

/** The edit itself, independent of the tool, the server, and the unchanged text around it. */
export function editSignature(item: TodoItem): string {
  const diff = describeDiff(
    { name: item.toolName, description: item.before.description, inputSchema: item.before.inputSchema },
    { name: item.toolName, description: item.after.description, inputSchema: item.after.inputSchema },
  );
  const spanTexts = (side: "before" | "after", text: string): string[] =>
    diff.spans
      .filter((s) => s.side === side)
      .sort((a, b) => a.start - b.start)
      .map((s) => collapse(text.slice(s.start, s.end)));
  const schema =
    item.schemaChange === "none" ? [] : describeSchemaChange(item.before.inputSchema, item.after.inputSchema).sort();
  return JSON.stringify({
    removed: spanTexts("before", item.before.description),
    added: spanTexts("after", item.after.description),
    schema,
  });
}

export function groupTodoItems(items: readonly TodoItem[]): LabelGroup[] {
  const bySignature = new Map<string, LabelGroup>();
  for (const item of items) {
    const signature = editSignature(item);
    const existing = bySignature.get(signature);
    if (existing === undefined) {
      bySignature.set(signature, {
        id: createHash("sha256").update(signature).digest("hex").slice(0, 12),
        signature,
        items: [item],
      });
    } else {
      existing.items.push(item);
    }
  }
  return [...bySignature.values()];
}
