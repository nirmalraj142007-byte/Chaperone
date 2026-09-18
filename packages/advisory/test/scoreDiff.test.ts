import { afterEach, describe, expect, it, vi } from "vitest";
import { UpstreamError, UpstreamTimeoutError } from "@chaperone/errors";
import { scoreDiff } from "../src/scoreDiff.js";
import { MockModelProvider } from "../src/providers/mock.js";
import { DESCRIPTION_TRUNCATE_CHARS } from "../src/tokenBudget.js";
import type { DiffSummaryInput } from "../src/prompt.js";

const INPUT: DiffSummaryInput = {
  toolName: "add_item",
  upstreamLabel: "Household Grocery",
  capabilityClass: "write",
  changedFields: ["description"],
  beforeDescription: "Adds an item to the shopping list.",
  afterDescription: "Adds an item to the shopping list. Also reads the calendar.",
};

describe("scoreDiff", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a scored result on a clean first response", async () => {
    const provider = new MockModelProvider({
      respond: () => ({ text: JSON.stringify({ score: 62, summary: "Now also reads the household calendar." }), modelId: "mock-x" }),
    });
    const result = await scoreDiff(INPUT, provider);
    expect(result).toEqual({
      status: "scored",
      score: 62,
      summary: "Now also reads the household calendar.",
      modelId: "mock-x",
      promptSha: expect.any(String),
    });
  });

  it("strips a code fence before parsing", async () => {
    const provider = new MockModelProvider({
      respond: () => ({ text: '```json\n{"score": 10, "summary": "cosmetic"}\n```', modelId: "mock-x" }),
    });
    const result = await scoreDiff(INPUT, provider);
    expect(result.status).toBe("scored");
  });

  it("retries once after a parse failure and succeeds on the second try", async () => {
    const provider = new MockModelProvider({
      respond: (_req, callIndex) =>
        callIndex === 0
          ? { text: "not json at all", modelId: "mock-x" }
          : { text: JSON.stringify({ score: 20, summary: "ok on retry" }), modelId: "mock-x" },
    });
    const result = await scoreDiff(INPUT, provider);
    expect(result).toEqual({ status: "scored", score: 20, summary: "ok on retry", modelId: "mock-x", promptSha: expect.any(String) });
  });

  it("gives up as unavailable after a second consecutive parse failure", async () => {
    const provider = new MockModelProvider({ respond: () => ({ text: "still not json", modelId: "mock-x" }) });
    const result = await scoreDiff(INPUT, provider);
    expect(result).toEqual({ status: "unavailable", reason: "unparseable-response" });
  });

  it("retries a throttling failure and then succeeds", async () => {
    const provider = new MockModelProvider({
      throwOn: (i) => (i === 0 ? new UpstreamError("throttled", { providerErrorName: "ThrottlingException" }) : undefined),
      respond: () => ({ text: JSON.stringify({ score: 5, summary: "fine" }), modelId: "mock-x" }),
    });
    const result = await scoreDiff(INPUT, provider);
    expect(result.status).toBe("scored");
  });

  it("retries a timeout failure and then succeeds", async () => {
    const provider = new MockModelProvider({
      throwOn: (i) => (i === 0 ? new UpstreamTimeoutError("timed out") : undefined),
      respond: () => ({ text: JSON.stringify({ score: 5, summary: "fine" }), modelId: "mock-x" }),
    });
    const result = await scoreDiff(INPUT, provider);
    expect(result.status).toBe("scored");
  });

  it("does not retry a non-throttling UpstreamError (e.g. validation) and returns unavailable", async () => {
    const provider = new MockModelProvider({
      throwOn: () => new UpstreamError("bad request", { providerErrorName: "ValidationException" }),
    });
    const invokeSpy = vi.spyOn(provider, "invoke");
    const result = await scoreDiff(INPUT, provider);
    expect(result).toEqual({ status: "unavailable", reason: "provider-non-retryable" });
    expect(invokeSpy).toHaveBeenCalledTimes(1);
  });

  it("returns unavailable once retries are exhausted", async () => {
    vi.useFakeTimers();
    const provider = new MockModelProvider({
      throwOn: () => new UpstreamError("throttled", { providerErrorName: "ThrottlingException" }),
    });
    const invokeSpy = vi.spyOn(provider, "invoke");
    const pending = scoreDiff(INPUT, provider);
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result).toEqual({ status: "unavailable", reason: "provider-exhausted" });
    expect(invokeSpy).toHaveBeenCalledTimes(4); // 1 initial + 3 retries at 250/1000/4000ms
  });

  it("rejects a prompt that estimates over the token budget without ever calling the provider", async () => {
    const provider = new MockModelProvider();
    const invokeSpy = vi.spyOn(provider, "invoke");
    // Descriptions are truncated to DESCRIPTION_TRUNCATE_CHARS before the
    // budget check ever runs, so a long description alone can't reach
    // MAX_PROMPT_TOKENS — toolName isn't truncated, so it's the field this
    // test uses to actually exercise the reject-before-calling-the-provider
    // path.
    const hugeInput: DiffSummaryInput = { ...INPUT, toolName: "x".repeat(DESCRIPTION_TRUNCATE_CHARS * 20) };
    const result = await scoreDiff(hugeInput, provider);
    expect(result).toEqual({ status: "unavailable", reason: "prompt-too-large" });
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it("never throws even when the provider throws something unexpected", async () => {
    const provider = new MockModelProvider({ throwOn: () => new Error("something totally unrelated blew up") });
    await expect(scoreDiff(INPUT, provider)).resolves.toEqual({ status: "unavailable", reason: "provider-non-retryable" });
  });
});
