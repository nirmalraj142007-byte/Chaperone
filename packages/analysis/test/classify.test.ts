import type { ToolDefinition } from "@chaperone/policy";
import { describe, expect, it } from "vitest";
import { formattingKey, proposeChangeClass } from "../src/index.js";

const base: ToolDefinition = {
  name: "add_to_list",
  description: "Adds an item to your shopping list.",
  inputSchema: { type: "object", properties: { item: { type: "string" } }, required: ["item"] },
};

describe("proposeChangeClass follows the appendix's table", () => {
  it("formatting-only description change -> cosmetic, no label (TAXONOMY.md cosmetic example 1)", () => {
    const p = proposeChangeClass(base, { ...base, description: "Adds an item to your shopping list" });
    expect(p).toMatchObject({ proposed: "cosmetic", needsLabel: false, descriptionChange: "formatting", schemaChange: "none" });
  });

  it("markdown code span and case -> still formatting only", () => {
    const p = proposeChangeClass(base, { ...base, description: "adds an item to your `shopping` **list**." });
    expect(p.descriptionChange).toBe("formatting");
  });

  it("new optional property -> schema-additive, no label (TAXONOMY.md schema-additive example 1)", () => {
    const after = { ...base, inputSchema: { type: "object", properties: { item: { type: "string" }, quantity: { type: "number" } }, required: ["item"] } };
    expect(proposeChangeClass(base, after)).toMatchObject({ proposed: "schema-additive", needsLabel: false, schemaChange: "additive", descriptionChange: "none" });
  });

  it("optional property plus a formatting-only description change -> schema-additive", () => {
    const after = {
      ...base,
      description: "Adds an item to your shopping list",
      inputSchema: { type: "object", properties: { item: { type: "string" }, quantity: { type: "number" } }, required: ["item"] },
    };
    const p = proposeChangeClass(base, after);
    expect(p).toMatchObject({ proposed: "schema-additive", needsLabel: false });
    expect(p.reason).toContain("formatting only");
  });

  it("new required property -> semantic-intent, needs a label", () => {
    const after = { ...base, inputSchema: { type: "object", properties: { item: { type: "string" }, phone: { type: "string" } }, required: ["item", "phone"] } };
    expect(proposeChangeClass(base, after)).toMatchObject({ proposed: "semantic-intent", needsLabel: true, schemaChange: "non-additive" });
  });

  it("words changed -> semantic-intent, needs a label (TAXONOMY.md semantic-intent example 1)", () => {
    const after = { ...base, description: "Adds an item to your shopping list. Also checks your calendar for upcoming events and includes relevant items." };
    expect(proposeChangeClass(base, after)).toMatchObject({ proposed: "semantic-intent", needsLabel: true, descriptionChange: "words" });
  });

  it("a one-letter typo fix is words changed: in doubt, not cosmetic", () => {
    const p = proposeChangeClass({ ...base, description: "Adds an itme to your list." }, { ...base, description: "Adds an item to your list." });
    expect(p).toMatchObject({ proposed: "semantic-intent", needsLabel: true });
  });

  it("refuses a pair with no difference", () => {
    expect(() => proposeChangeClass(base, { ...base })).toThrow(/no difference/);
  });

  it("formattingKey keeps letters and digits in any script", () => {
    expect(formattingKey("Größe: 10 cm!")).toBe("größe10cm");
    expect(formattingKey("  A  b ")).toBe(formattingKey("a b"));
  });
});
