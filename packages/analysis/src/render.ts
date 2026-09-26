/**
 * Text rendering for the labelling tool. The changed words are marked twice:
 * with git's word-diff brackets, `[-removed-]` and `{+added+}`, which survive
 * any terminal (Windows Command Prompt included), a pipe, and a screenshot in
 * black and white; and with red/green ANSI colour on top when the output is a
 * TTY and NO_COLOR is unset.
 */
import { type DiffSpan, describeDiff } from "@chaperone/policy";
import type { TodoItem } from "./labels.js";

export interface Style {
  removed(text: string): string;
  added(text: string): string;
  bold(text: string): string;
  dim(text: string): string;
  red(text: string): string;
}

export function makeStyle(color: boolean): Style {
  const wrap = (open: string, close: string) => (text: string) => (color ? `\u001b[${open}m${text}\u001b[${close}m` : text);
  const red = wrap("31", "39");
  const green = wrap("32", "39");
  return {
    removed: (text) => red(`[-${text}-]`),
    added: (text) => green(`{+${text}+}`),
    bold: wrap("1", "22"),
    dim: wrap("2", "22"),
    red: wrap("1;31", "22;39"),
  };
}

/** Wraps each span of `text` with `mark`, leaving the rest as is. Spans must be from one side and non-overlapping. */
export function highlightSpans(text: string, spans: readonly DiffSpan[], mark: (s: string) => string): string {
  let out = "";
  let cursor = 0;
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    out += text.slice(cursor, span.start) + mark(text.slice(span.start, span.end));
    cursor = span.end;
  }
  return out + text.slice(cursor);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A short, per-property account of what changed in an input schema, for the labeller. */
export function describeSchemaChange(before: unknown, after: unknown): string[] {
  const b = isObject(before) ? before : {};
  const a = isObject(after) ? after : {};
  const bProps = isObject(b["properties"]) ? b["properties"] : {};
  const aProps = isObject(a["properties"]) ? a["properties"] : {};
  const bReq = new Set(Array.isArray(b["required"]) ? b["required"].map(String) : []);
  const aReq = new Set(Array.isArray(a["required"]) ? a["required"].map(String) : []);
  const lines: string[] = [];

  for (const key of Object.keys(aProps).filter((k) => !(k in bProps))) {
    lines.push(`+ property "${key}" added (${aReq.has(key) ? "REQUIRED" : "optional"})`);
  }
  for (const key of Object.keys(bProps).filter((k) => !(k in aProps))) {
    lines.push(`- property "${key}" removed`);
  }
  for (const key of Object.keys(bProps).filter((k) => k in aProps)) {
    if (JSON.stringify(bProps[key]) !== JSON.stringify(aProps[key])) {
      lines.push(`~ property "${key}" changed: ${JSON.stringify(bProps[key])} -> ${JSON.stringify(aProps[key])}`);
    }
  }
  for (const key of [...aReq].filter((k) => !bReq.has(k) && k in bProps)) {
    lines.push(`! "${key}" is now required`);
  }
  for (const key of [...bReq].filter((k) => !aReq.has(k))) {
    lines.push(`~ "${key}" is no longer required`);
  }
  const otherKeys = new Set([...Object.keys(a), ...Object.keys(b)].filter((k) => k !== "properties" && k !== "required"));
  for (const key of otherKeys) {
    if (JSON.stringify(b[key]) !== JSON.stringify(a[key])) {
      lines.push(`~ schema "${key}": ${JSON.stringify(b[key])} -> ${JSON.stringify(a[key])}`);
    }
  }
  return lines.length > 0 ? lines : ["(no property-level difference; key order or formatting only)"];
}

export function renderTodoItem(item: TodoItem, position: number, total: number, style: Style, previouslySkipped: boolean): string {
  const diff = describeDiff(
    { name: item.toolName, description: item.before.description, inputSchema: item.before.inputSchema },
    { name: item.toolName, description: item.after.description, inputSchema: item.after.inputSchema },
  );
  const lines: string[] = [];
  lines.push("");
  lines.push(style.bold(`[${position}/${total}] ${item.serverId}  ::  ${item.toolName}`) + (previouslySkipped ? style.dim("  (skipped before)") : ""));
  lines.push(style.dim(`compared in: ${item.comparisons.join(", ")}`));
  lines.push(
    `proposed: ${style.bold(item.proposed)}  (${item.reason})` +
      (item.capabilityBefore !== item.capabilityAfter ? `\ncapability class moved: ${item.capabilityBefore} -> ${style.bold(item.capabilityAfter)}` : `\ncapability class: ${item.capabilityBefore}`),
  );
  if (item.descriptionChange === "none") {
    lines.push("description: unchanged");
    lines.push(`  ${item.after.description}`);
  } else {
    lines.push(style.bold("description BEFORE:"));
    lines.push(
      `  ${highlightSpans(
        item.before.description,
        diff.spans.filter((s) => s.side === "before"),
        style.removed,
      )}`,
    );
    lines.push(style.bold("description AFTER:"));
    lines.push(
      `  ${highlightSpans(
        item.after.description,
        diff.spans.filter((s) => s.side === "after"),
        style.added,
      )}`,
    );
  }
  if (item.schemaChange !== "none") {
    lines.push(style.bold(`input schema (${item.schemaChange}):`));
    for (const line of describeSchemaChange(item.before.inputSchema, item.after.inputSchema)) {
      lines.push(`  ${line}`);
    }
  }
  return lines.join("\n");
}

/** Greedy word wrap. A single word longer than `width` gets a line to itself rather than being split. */
export function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter((w) => w.length > 0)) {
    if (line.length === 0) {
      line = word;
    } else if (line.length + 1 + word.length <= width) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line.length > 0) {
    lines.push(line);
  }
  return lines;
}

/** Two titled columns, each wrapped to `columnWidth`, separated by " | ". Plain text, so it works in any console. */
export function sideBySide(left: { title: string; text: string }, right: { title: string; text: string }, columnWidth: number): string {
  const l = [left.title, "-".repeat(Math.min(columnWidth, left.title.length)), ...wrapText(left.text, columnWidth)];
  const r = [right.title, "-".repeat(Math.min(columnWidth, right.title.length)), ...wrapText(right.text, columnWidth)];
  const rows = Math.max(l.length, r.length);
  const out: string[] = [];
  for (let i = 0; i < rows; i++) {
    out.push(`${(l[i] ?? "").padEnd(columnWidth)} | ${r[i] ?? ""}`.trimEnd());
  }
  return out.join("\n");
}
