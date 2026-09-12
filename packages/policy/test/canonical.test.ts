import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalizeTool, hashTool } from "../src/canonical.js";
import { canonicalizeJson } from "../src/jcs.js";
import type { ToolDefinition } from "../src/types.js";

const vectorsPath = fileURLToPath(new URL("./vectors/jcs.json", import.meta.url));
const vectors = JSON.parse(readFileSync(vectorsPath, "utf8")) as Array<{
  name: string;
  description: string;
  input: unknown;
  canonical: string;
}>;

describe("RFC 8785 golden vectors", () => {
  it.each(vectors)("$name: $description", (vector) => {
    expect(canonicalizeJson(vector.input)).toBe(vector.canonical);
  });

  it("has at least four vectors", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(4);
  });
});

describe("canonicalizeTool", () => {
  it("canonicalizes only name, description, and inputSchema, in that key order", () => {
    const tool: ToolDefinition = {
      name: "add_item",
      description: "Adds an item.",
      inputSchema: { type: "object" },
    };
    expect(canonicalizeTool(tool)).toBe(
      '{"description":"Adds an item.","inputSchema":{"type":"object"},"name":"add_item"}',
    );
  });

  it("treats description: undefined and description: \"\" identically", () => {
    const withUndefined: ToolDefinition = { name: "x", inputSchema: {} };
    const withEmpty: ToolDefinition = { name: "x", description: "", inputSchema: {} };
    expect(canonicalizeTool(withUndefined)).toBe(canonicalizeTool(withEmpty));
    expect(hashTool(withUndefined)).toBe(hashTool(withEmpty));
  });

  it("ignores vendor metadata and annotations that aren't part of ToolDefinition", () => {
    const bare: ToolDefinition = { name: "x", description: "does x", inputSchema: {} };
    const withExtras = {
      ...bare,
      annotations: { readOnlyHint: true },
      vendor: { crawledAt: "2026-09-15T00:00:00Z" },
    } as unknown as ToolDefinition;
    expect(canonicalizeTool(withExtras)).toBe(canonicalizeTool(bare));
  });

  it("is stable regardless of input key order", () => {
    const a: ToolDefinition = { name: "x", description: "d", inputSchema: { a: 1, b: 2 } };
    const b: ToolDefinition = { description: "d", inputSchema: { b: 2, a: 1 }, name: "x" };
    expect(canonicalizeTool(a)).toBe(canonicalizeTool(b));
  });
});

describe("hashTool", () => {
  it("returns sha256:<64 hex chars>", () => {
    const tool: ToolDefinition = { name: "x", description: "d", inputSchema: {} };
    const hash = hashTool(tool);
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("is deterministic for the same tool definition", () => {
    const tool: ToolDefinition = { name: "x", description: "d", inputSchema: { a: 1 } };
    expect(hashTool(tool)).toBe(hashTool({ ...tool }));
  });

  it("changes when the description changes by a single character", () => {
    const tool: ToolDefinition = { name: "x", description: "Adds an item.", inputSchema: {} };
    const mutated: ToolDefinition = { ...tool, description: "Adds an item!" };
    expect(hashTool(tool)).not.toBe(hashTool(mutated));
  });

  it("changes when the name changes", () => {
    const tool: ToolDefinition = { name: "x", description: "d", inputSchema: {} };
    expect(hashTool(tool)).not.toBe(hashTool({ ...tool, name: "y" }));
  });

  it("changes when the input schema changes", () => {
    const tool: ToolDefinition = { name: "x", description: "d", inputSchema: { a: 1 } };
    expect(hashTool(tool)).not.toBe(hashTool({ ...tool, inputSchema: { a: 2 } }));
  });
});
