import { canonicalizeJson } from "./jcs.js";
import type { ToolDefinition } from "./types.js";

export interface DiffSpan {
  side: "before" | "after";
  start: number;
  end: number;
  kind: "add" | "remove";
}

export interface ToolDiff {
  changedFields: Array<"name" | "description" | "inputSchema">;
  spans: DiffSpan[];
  schemaAdditiveOnly: boolean;
}

function structurallyEqual(a: unknown, b: unknown): boolean {
  return canonicalizeJson(a) === canonicalizeJson(b);
}

// --- word-boundary LCS over the description, for consent-card highlighting ---

interface Token {
  text: string;
  start: number;
  end: number;
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  // Word runs, whitespace runs, and punctuation runs are separate tokens —
  // not `\S+|\s+`, which would glue sentence-ending punctuation onto the
  // preceding word (e.g. "list." vs "list") and spuriously mismatch it
  // against an edit that only continues the sentence past that word.
  const pattern = /\w+|\s+|[^\w\s]+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const [chunk] = match;
    tokens.push({ text: chunk, start: match.index, end: match.index + chunk.length });
  }
  return tokens;
}

/** table[i][j] = length of the LCS of a[i..] and b[j..], by token text equality. */
function lcsTable(a: readonly Token[], b: readonly Token[]): number[][] {
  const n = a.length;
  const m = b.length;
  const table: number[][] = [];
  for (let i = 0; i <= n; i++) {
    table.push(new Array<number>(m + 1).fill(0));
  }
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = table[i]!;
      const nextRow = table[i + 1]!;
      row[j] = a[i]!.text === b[j]!.text ? nextRow[j + 1]! + 1 : Math.max(nextRow[j]!, row[j + 1]!);
    }
  }
  return table;
}

/** Which tokens on each side participate in the longest common subsequence. */
function matchFlags(a: readonly Token[], b: readonly Token[]): { aMatched: boolean[]; bMatched: boolean[] } {
  const table = lcsTable(a, b);
  const aMatched = new Array<boolean>(a.length).fill(false);
  const bMatched = new Array<boolean>(b.length).fill(false);
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i]!.text === b[j]!.text) {
      aMatched[i] = true;
      bMatched[j] = true;
      i++;
      j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      i++;
    } else {
      j++;
    }
  }
  return { aMatched, bMatched };
}

/**
 * Merges consecutive unmatched non-whitespace tokens (whitespace tokens
 * between them don't break the run) into spans, so a multi-word change
 * highlights as one span instead of one per word.
 */
function buildSpans(
  tokens: readonly Token[],
  matched: readonly boolean[],
  side: DiffSpan["side"],
  kind: DiffSpan["kind"],
): DiffSpan[] {
  const spans: DiffSpan[] = [];
  let runStart: number | null = null;
  let runEnd = 0;

  for (const [idx, token] of tokens.entries()) {
    if (token.text.trim().length === 0) {
      continue;
    }
    if (!matched[idx]) {
      runStart ??= token.start;
      runEnd = token.end;
    } else if (runStart !== null) {
      spans.push({ side, start: runStart, end: runEnd, kind });
      runStart = null;
    }
  }
  if (runStart !== null) {
    spans.push({ side, start: runStart, end: runEnd, kind });
  }
  return spans;
}

function describeDescriptionSpans(before: string, after: string): DiffSpan[] {
  if (before === after) {
    return [];
  }
  const beforeTokens = tokenize(before);
  const afterTokens = tokenize(after);
  const { aMatched, bMatched } = matchFlags(beforeTokens, afterTokens);
  return [
    ...buildSpans(beforeTokens, aMatched, "before", "remove"),
    ...buildSpans(afterTokens, bMatched, "after", "add"),
  ];
}

// --- schema-additive-only detection ---

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAdditiveOnly(before: unknown, after: unknown): boolean {
  if (structurallyEqual(before, after)) {
    return true;
  }

  if (!isPlainObject(before) || !isPlainObject(after)) {
    // Primitives, arrays, or a type-shape change: any difference here is a
    // real behavioural change, never merely additive.
    return false;
  }

  const beforeEnum = before["enum"];
  const afterEnum = after["enum"];
  if (beforeEnum !== undefined || afterEnum !== undefined) {
    if (!Array.isArray(beforeEnum) || !Array.isArray(afterEnum)) {
      return false;
    }
    const beforeValues = new Set(beforeEnum.map((value) => canonicalizeJson(value)));
    const afterValues = new Set(afterEnum.map((value) => canonicalizeJson(value)));
    for (const value of beforeValues) {
      if (!afterValues.has(value)) {
        return false; // a previously valid enum value was removed: narrowed, not widened.
      }
    }
  }

  const beforeRequired = new Set(Array.isArray(before["required"]) ? (before["required"] as unknown[]) : []);
  const afterRequired = new Set(Array.isArray(after["required"]) ? (after["required"] as unknown[]) : []);
  for (const field of afterRequired) {
    if (!beforeRequired.has(field)) {
      return false; // a field that used to be optional (or absent) is now required.
    }
  }

  const beforeProps = isPlainObject(before["properties"]) ? before["properties"] : {};
  const afterProps = isPlainObject(after["properties"]) ? after["properties"] : {};
  for (const key of Object.keys(beforeProps)) {
    if (!(key in afterProps)) {
      return false; // a property was removed outright.
    }
    if (!isAdditiveOnly(beforeProps[key], afterProps[key])) {
      return false;
    }
  }
  // Keys present only in afterProps are new optional properties (already
  // confirmed not to be in afterRequired above) — additive by definition.

  const ignoredKeys = new Set(["properties", "required", "enum"]);
  const otherKeys = new Set([
    ...Object.keys(before).filter((key) => !ignoredKeys.has(key)),
    ...Object.keys(after).filter((key) => !ignoredKeys.has(key)),
  ]);
  for (const key of otherKeys) {
    if (!structurallyEqual(before[key], after[key]) && !isAdditiveOnly(before[key], after[key])) {
      return false;
    }
  }

  return true;
}

export function describeDiff(before: ToolDefinition, after: ToolDefinition): ToolDiff {
  const changedFields: Array<"name" | "description" | "inputSchema"> = [];

  if (before.name !== after.name) {
    changedFields.push("name");
  }

  const beforeDescription = before.description ?? "";
  const afterDescription = after.description ?? "";
  if (beforeDescription !== afterDescription) {
    changedFields.push("description");
  }

  const schemaChanged = !structurallyEqual(before.inputSchema, after.inputSchema);
  if (schemaChanged) {
    changedFields.push("inputSchema");
  }

  return {
    changedFields,
    spans: describeDescriptionSpans(beforeDescription, afterDescription),
    schemaAdditiveOnly: schemaChanged ? isAdditiveOnly(before.inputSchema, after.inputSchema) : true,
  };
}
