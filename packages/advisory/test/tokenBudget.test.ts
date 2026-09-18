import { describe, expect, it } from "vitest";
import { DESCRIPTION_TRUNCATE_CHARS, MAX_PROMPT_TOKENS, estimateTokens, exceedsPromptBudget } from "../src/tokenBudget.js";

describe("estimateTokens", () => {
  it("estimates roughly 4 characters per token", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });

  it("rounds a partial token up", () => {
    expect(estimateTokens("abc")).toBe(1);
  });

  it("returns 0 for an empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

describe("exceedsPromptBudget", () => {
  it("is false right at the boundary", () => {
    const prompt = "a".repeat(MAX_PROMPT_TOKENS * 4);
    expect(exceedsPromptBudget(prompt)).toBe(false);
  });

  it("is true one token over the boundary", () => {
    const prompt = "a".repeat(MAX_PROMPT_TOKENS * 4 + 4);
    expect(exceedsPromptBudget(prompt)).toBe(true);
  });

  it("a single untruncated description could not alone exceed the budget", () => {
    // Sanity check tying the two constants together: even a
    // DESCRIPTION_TRUNCATE_CHARS-sized field is nowhere near MAX_PROMPT_TOKENS.
    expect(estimateTokens("a".repeat(DESCRIPTION_TRUNCATE_CHARS))).toBeLessThan(MAX_PROMPT_TOKENS);
  });
});
