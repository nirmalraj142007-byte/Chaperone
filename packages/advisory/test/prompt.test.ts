import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildAdvisoryPrompt, type DiffSummaryInput } from "../src/prompt.js";
import { DESCRIPTION_TRUNCATE_CHARS } from "../src/tokenBudget.js";

const BASE_INPUT: DiffSummaryInput = {
  toolName: "add_item",
  upstreamLabel: "Household Grocery",
  capabilityClass: "write",
  changedFields: ["description"],
  beforeDescription: "Adds an item to the shopping list.",
  afterDescription: "Adds an item to the shopping list. Also reads the household calendar.",
};

describe("buildAdvisoryPrompt", () => {
  it("includes the tool metadata and both description sides", () => {
    const { prompt } = buildAdvisoryPrompt(BASE_INPUT);
    expect(prompt).toContain("add_item");
    expect(prompt).toContain("Household Grocery");
    expect(prompt).toContain("write");
    expect(prompt).toContain(BASE_INPUT.beforeDescription);
    expect(prompt).toContain(BASE_INPUT.afterDescription);
  });

  it("lists changed fields, or says none", () => {
    expect(buildAdvisoryPrompt(BASE_INPUT).prompt).toContain("Changed fields: description");
    expect(buildAdvisoryPrompt({ ...BASE_INPUT, changedFields: [] }).prompt).toContain("Changed fields: none");
  });

  it("truncates a description longer than DESCRIPTION_TRUNCATE_CHARS with an explicit marker", () => {
    const long = "x".repeat(DESCRIPTION_TRUNCATE_CHARS + 500);
    const { prompt } = buildAdvisoryPrompt({ ...BASE_INPUT, afterDescription: long });
    expect(prompt).not.toContain(long);
    expect(prompt).toContain("x".repeat(DESCRIPTION_TRUNCATE_CHARS) + "…[truncated]");
  });

  it("does not truncate a description at or under the limit", () => {
    const exact = "y".repeat(DESCRIPTION_TRUNCATE_CHARS);
    const { prompt } = buildAdvisoryPrompt({ ...BASE_INPUT, afterDescription: exact });
    expect(prompt).toContain(exact);
    expect(prompt).not.toContain("…[truncated]");
  });

  it("truncates the before and after sides independently", () => {
    const longBefore = "b".repeat(DESCRIPTION_TRUNCATE_CHARS + 10);
    const longAfter = "a".repeat(DESCRIPTION_TRUNCATE_CHARS + 20);
    const { prompt } = buildAdvisoryPrompt({ ...BASE_INPUT, beforeDescription: longBefore, afterDescription: longAfter });
    expect(prompt).toContain("b".repeat(DESCRIPTION_TRUNCATE_CHARS) + "…[truncated]");
    expect(prompt).toContain("a".repeat(DESCRIPTION_TRUNCATE_CHARS) + "…[truncated]");
  });

  it("promptSha is the sha256 hex of the exact prompt text", () => {
    const { prompt, promptSha } = buildAdvisoryPrompt(BASE_INPUT);
    expect(promptSha).toBe(createHash("sha256").update(prompt, "utf8").digest("hex"));
  });

  it("is deterministic for the same input", () => {
    expect(buildAdvisoryPrompt(BASE_INPUT).promptSha).toBe(buildAdvisoryPrompt(BASE_INPUT).promptSha);
  });

  it("produces a different promptSha when the input changes", () => {
    const a = buildAdvisoryPrompt(BASE_INPUT).promptSha;
    const b = buildAdvisoryPrompt({ ...BASE_INPUT, afterDescription: "Something entirely different." }).promptSha;
    expect(a).not.toBe(b);
  });

  it("asks for a single JSON object response", () => {
    expect(buildAdvisoryPrompt(BASE_INPUT).prompt).toContain('"score"');
    expect(buildAdvisoryPrompt(BASE_INPUT).prompt).toContain('"summary"');
  });
});
