import { describe, expect, it } from "vitest";
import { AdvisorySchema } from "../src/schema.js";

describe("AdvisorySchema", () => {
  it("accepts a well-formed advisory", () => {
    const result = AdvisorySchema.safeParse({ score: 42, summary: "Adds calendar access it didn't ask for before." });
    expect(result.success).toBe(true);
  });

  it.each([0, 100])("accepts the score boundary %d", (score) => {
    expect(AdvisorySchema.safeParse({ score, summary: "ok" }).success).toBe(true);
  });

  it.each([-1, 101])("rejects a score outside 0-100 (%d)", (score) => {
    expect(AdvisorySchema.safeParse({ score, summary: "ok" }).success).toBe(false);
  });

  it("rejects a non-numeric score", () => {
    expect(AdvisorySchema.safeParse({ score: "42", summary: "ok" }).success).toBe(false);
  });

  it("rejects a missing summary", () => {
    expect(AdvisorySchema.safeParse({ score: 10 }).success).toBe(false);
  });

  it("rejects an empty summary", () => {
    expect(AdvisorySchema.safeParse({ score: 10, summary: "   " }).success).toBe(false);
  });

  it("rejects a summary over the 480-char cap", () => {
    expect(AdvisorySchema.safeParse({ score: 10, summary: "x".repeat(481) }).success).toBe(false);
  });

  it("drops unknown extra fields rather than failing", () => {
    const result = AdvisorySchema.safeParse({ score: 10, summary: "ok", reasoning: "chain of thought here" });
    expect(result.success).toBe(true);
    expect(result.success && (result.data as Record<string, unknown>)["reasoning"]).toBeUndefined();
  });
});
