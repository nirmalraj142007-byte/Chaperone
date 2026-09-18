import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { UpstreamError, UpstreamTimeoutError } from "@chaperone/errors";
import { BedrockModelProvider } from "../../src/providers/bedrock.js";

/**
 * Mocks at the AWS SDK client boundary (`aws-sdk-client-mock`, already used
 * this way for DynamoDB throughout packages/ledger/test) rather than
 * hitting real Bedrock — CLAUDE.md is explicit that no live invocation
 * happens this phase. This is the SDK's own client contract, not a
 * third-party API response being faked; the never-mock-external-APIs
 * convention (packages/crawler's real-loopback-server tests) is about the
 * crawler's actual registry/GitHub network calls.
 */
const bedrockMock = mockClient(BedrockRuntimeClient);

beforeEach(() => {
  bedrockMock.reset();
});

afterEach(() => {
  bedrockMock.reset();
});

describe("BedrockModelProvider", () => {
  it("sends the prompt as a single user message and returns the response text", async () => {
    bedrockMock.on(ConverseCommand).resolves({
      output: { message: { role: "assistant", content: [{ text: '{"score":10,"summary":"ok"}' }] } },
      stopReason: "end_turn",
    });

    const provider = new BedrockModelProvider({ modelId: "test.model-v1", region: "us-east-1" });
    const result = await provider.invoke({ prompt: "describe this diff", maxTokens: 300, timeoutMs: 5000 });

    expect(result).toEqual({ text: '{"score":10,"summary":"ok"}', modelId: "test.model-v1" });
    const calls = bedrockMock.commandCalls(ConverseCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input).toMatchObject({
      modelId: "test.model-v1",
      messages: [{ role: "user", content: [{ text: "describe this diff" }] }],
      inferenceConfig: { maxTokens: 300 },
    });
  });

  it("throws UpstreamError when the response has no text content block", async () => {
    bedrockMock.on(ConverseCommand).resolves({ output: { message: { role: "assistant", content: [] } }, stopReason: "end_turn" });

    const provider = new BedrockModelProvider({ modelId: "test.model-v1", region: "us-east-1" });
    await expect(provider.invoke({ prompt: "x", maxTokens: 300, timeoutMs: 5000 })).rejects.toBeInstanceOf(UpstreamError);
  });

  it("maps a ThrottlingException to UpstreamError with providerErrorName set", async () => {
    const throttled = Object.assign(new Error("Rate exceeded"), { name: "ThrottlingException" });
    bedrockMock.on(ConverseCommand).rejects(throttled);

    const provider = new BedrockModelProvider({ modelId: "test.model-v1", region: "us-east-1" });
    try {
      await provider.invoke({ prompt: "x", maxTokens: 300, timeoutMs: 5000 });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UpstreamError);
      expect((error as UpstreamError).context["providerErrorName"]).toBe("ThrottlingException");
    }
  });

  it("maps a ModelTimeoutException to UpstreamTimeoutError", async () => {
    const timedOut = Object.assign(new Error("Model took too long"), { name: "ModelTimeoutException" });
    bedrockMock.on(ConverseCommand).rejects(timedOut);

    const provider = new BedrockModelProvider({ modelId: "test.model-v1", region: "us-east-1" });
    await expect(provider.invoke({ prompt: "x", maxTokens: 300, timeoutMs: 5000 })).rejects.toBeInstanceOf(UpstreamTimeoutError);
  });

  it("maps our own AbortSignal timeout (DOMException 'TimeoutError') to UpstreamTimeoutError", async () => {
    bedrockMock.on(ConverseCommand).rejects(new DOMException("The operation was aborted", "TimeoutError"));

    const provider = new BedrockModelProvider({ modelId: "test.model-v1", region: "us-east-1" });
    await expect(provider.invoke({ prompt: "x", maxTokens: 300, timeoutMs: 5000 })).rejects.toBeInstanceOf(UpstreamTimeoutError);
  });

  it("maps an unrecognized failure (e.g. ValidationException) to UpstreamError, not UpstreamTimeoutError", async () => {
    const invalid = Object.assign(new Error("Bad input"), { name: "ValidationException" });
    bedrockMock.on(ConverseCommand).rejects(invalid);

    const provider = new BedrockModelProvider({ modelId: "test.model-v1", region: "us-east-1" });
    try {
      await provider.invoke({ prompt: "x", maxTokens: 300, timeoutMs: 5000 });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UpstreamError);
      expect(error).not.toBeInstanceOf(UpstreamTimeoutError);
      expect((error as UpstreamError).context["providerErrorName"]).toBe("ValidationException");
    }
  });
});
