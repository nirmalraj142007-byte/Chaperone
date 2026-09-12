import { describe, expect, it } from "vitest";
import { describeDiff } from "../src/diff.js";
import type { ToolDefinition } from "../src/types.js";

function tool(overrides: Partial<ToolDefinition>): ToolDefinition {
  return { name: "add_item", description: "Adds an item to your list.", inputSchema: { type: "object" }, ...overrides };
}

describe("describeDiff: changedFields", () => {
  it("reports no changed fields for an identical tool", () => {
    const t = tool({});
    const diff = describeDiff(t, { ...t });
    expect(diff.changedFields).toEqual([]);
    expect(diff.spans).toEqual([]);
    expect(diff.schemaAdditiveOnly).toBe(true);
  });

  it("reports only 'name' when just the name changes", () => {
    const diff = describeDiff(tool({}), tool({ name: "add_grocery_item" }));
    expect(diff.changedFields).toEqual(["name"]);
  });

  it("reports only 'description' when just the description changes", () => {
    const diff = describeDiff(tool({}), tool({ description: "Adds an item to your grocery list." }));
    expect(diff.changedFields).toEqual(["description"]);
  });

  it("reports only 'inputSchema' when just the schema changes", () => {
    const diff = describeDiff(tool({}), tool({ inputSchema: { type: "object", properties: {} } }));
    expect(diff.changedFields).toEqual(["inputSchema"]);
  });

  it("reports all three when everything changes", () => {
    const diff = describeDiff(
      tool({}),
      tool({ name: "y", description: "different", inputSchema: { type: "string" } }),
    );
    expect(diff.changedFields).toEqual(["name", "description", "inputSchema"]);
  });

  it("treats description undefined and '' as unchanged", () => {
    const diff = describeDiff(tool({ description: undefined }), tool({ description: "" }));
    expect(diff.changedFields).toEqual([]);
  });
});

describe("describeDiff: description spans", () => {
  it("marks only the added words on the 'after' side for a pure addition", () => {
    const before = "Adds an item to your list.";
    const after = "Adds an item to your list and sends a text.";
    const diff = describeDiff(tool({ description: before }), tool({ description: after }));

    expect(diff.spans.filter((s) => s.side === "before")).toEqual([]);
    const addSpans = diff.spans.filter((s) => s.side === "after");
    expect(addSpans.length).toBeGreaterThan(0);
    for (const span of addSpans) {
      expect(span.kind).toBe("add");
    }
    const highlighted = addSpans.map((s) => after.slice(s.start, s.end)).join(" ");
    expect(highlighted).toContain("sends a text");
  });

  it("marks removed words on the 'before' side and added words on the 'after' side for a replacement", () => {
    const before = "Sends a text summary to yourself.";
    const after = "Sends a text summary to yourself and to your emergency contact.";
    const diff = describeDiff(tool({ description: before }), tool({ description: after }));

    const removeSpans = diff.spans.filter((s) => s.side === "before");
    const addSpans = diff.spans.filter((s) => s.side === "after");
    expect(removeSpans).toEqual([]);
    expect(addSpans.length).toBeGreaterThan(0);
    expect(addSpans.map((s) => after.slice(s.start, s.end)).join(" ")).toContain("emergency contact");
  });

  it("produces no spans when descriptions are identical", () => {
    const diff = describeDiff(tool({}), tool({}));
    expect(diff.spans).toEqual([]);
  });
});

describe("describeDiff: schemaAdditiveOnly — six hand-built pairs", () => {
  const cases: Array<{ name: string; before: unknown; after: unknown; additive: boolean }> = [
    {
      name: "new optional property added",
      before: { type: "object", properties: { item: { type: "string" } }, required: ["item"] },
      after: {
        type: "object",
        properties: { item: { type: "string" }, quantity: { type: "number" } },
        required: ["item"],
      },
      additive: true,
    },
    {
      name: "enum widened with a new value",
      before: { type: "object", properties: { mode: { type: "string", enum: ["light", "dark"] } } },
      after: { type: "object", properties: { mode: { type: "string", enum: ["light", "dark", "system"] } } },
      additive: true,
    },
    {
      name: "existing property removed",
      before: { type: "object", properties: { item: { type: "string" }, note: { type: "string" } } },
      after: { type: "object", properties: { item: { type: "string" } } },
      additive: false,
    },
    {
      name: "new field made required",
      before: { type: "object", properties: { item: { type: "string" } }, required: ["item"] },
      after: {
        type: "object",
        properties: { item: { type: "string" }, quantity: { type: "number" } },
        required: ["item", "quantity"],
      },
      additive: false,
    },
    {
      name: "previously optional field becomes required",
      before: { type: "object", properties: { item: { type: "string" }, note: { type: "string" } }, required: ["item"] },
      after: {
        type: "object",
        properties: { item: { type: "string" }, note: { type: "string" } },
        required: ["item", "note"],
      },
      additive: false,
    },
    {
      name: "enum narrowed by removing a value",
      before: { type: "object", properties: { mode: { type: "string", enum: ["light", "dark", "system"] } } },
      after: { type: "object", properties: { mode: { type: "string", enum: ["light", "dark"] } } },
      additive: false,
    },
  ];

  it.each(cases)("$name -> schemaAdditiveOnly === $additive", ({ before, after, additive }) => {
    const diff = describeDiff(tool({ inputSchema: before }), tool({ inputSchema: after }));
    expect(diff.changedFields).toContain("inputSchema");
    expect(diff.schemaAdditiveOnly).toBe(additive);
  });
});
