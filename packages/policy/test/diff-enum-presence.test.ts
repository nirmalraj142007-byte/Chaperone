import { describe, expect, it } from "vitest";
import { describeDiff } from "../src/diff.js";

const tool = (inputSchema: unknown) => ({ name: "set_mode", description: "Sets the mode.", inputSchema });

describe("describeDiff: an enum that exists on only one side is never additive", () => {
  it("dropping an enum constraint entirely widens what is accepted in a way that is not a plain new value", () => {
    const before = tool({ type: "object", properties: { mode: { type: "string", enum: ["light", "dark"] } } });
    const after = tool({ type: "object", properties: { mode: { type: "string" } } });
    expect(describeDiff(before, after).schemaAdditiveOnly).toBe(false);
  });

  it("adding an enum where there was none narrows what is accepted", () => {
    const before = tool({ type: "object", properties: { mode: { type: "string" } } });
    const after = tool({ type: "object", properties: { mode: { type: "string", enum: ["light", "dark"] } } });
    expect(describeDiff(before, after).schemaAdditiveOnly).toBe(false);
  });

  it("an enum that is not an array on either side is not additive", () => {
    const before = tool({ type: "object", properties: { mode: { enum: "light" } } });
    const after = tool({ type: "object", properties: { mode: { enum: ["light", "dark"] } } });
    expect(describeDiff(before, after).schemaAdditiveOnly).toBe(false);
  });
});

describe("describeDiff: a missing description is the same claim as an empty one", () => {
  const base = { name: "set_mode", inputSchema: { type: "object" } };

  it("no description on either side is not a change", () => {
    expect(describeDiff(base, { ...base }).changedFields).toEqual([]);
  });

  it("a description that appears where there was none is a description change", () => {
    expect(describeDiff(base, { ...base, description: "Sets the mode." }).changedFields).toEqual(["description"]);
  });

  it("a description that disappears is a description change", () => {
    expect(describeDiff({ ...base, description: "Sets the mode." }, base).changedFields).toEqual(["description"]);
  });

  it("undefined and the empty string are the same claim", () => {
    expect(describeDiff(base, { ...base, description: "" }).changedFields).toEqual([]);
  });
});
