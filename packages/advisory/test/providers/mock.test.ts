import { describe, expect, it } from "vitest";
import { MockModelProvider } from "../../src/providers/mock.js";
import { parseAdvisoryResponse } from "../../src/parse.js";

describe("MockModelProvider", () => {
  it("returns a deterministic, schema-valid default response when unconfigured", async () => {
    const provider = new MockModelProvider();
    const result = await provider.invoke({ prompt: "irrelevant", maxTokens: 300, timeoutMs: 1000 });
    expect(result.modelId).toBe("mock-advisory-v1");
    const parsed = parseAdvisoryResponse(result.text);
    expect(parsed.ok).toBe(true);
  });

  it("uses a custom modelId when given one", async () => {
    const provider = new MockModelProvider({ modelId: "test-model-7" });
    const result = await provider.invoke({ prompt: "x", maxTokens: 10, timeoutMs: 100 });
    expect(result.modelId).toBe("test-model-7");
  });

  it("increments callIndex across invocations for respond/throwOn to key off of", async () => {
    const seen: number[] = [];
    const provider = new MockModelProvider({
      respond: (_req, callIndex) => {
        seen.push(callIndex);
        return { text: "{}", modelId: "m" };
      },
    });
    await provider.invoke({ prompt: "a", maxTokens: 1, timeoutMs: 1 });
    await provider.invoke({ prompt: "b", maxTokens: 1, timeoutMs: 1 });
    expect(seen).toEqual([0, 1]);
  });

  it("throwOn returning a falsy value lets the call proceed normally", async () => {
    const provider = new MockModelProvider({ throwOn: () => undefined });
    await expect(provider.invoke({ prompt: "x", maxTokens: 1, timeoutMs: 1 })).resolves.toBeDefined();
  });
});
